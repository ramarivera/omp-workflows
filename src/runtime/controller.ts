import { randomUUID } from "node:crypto";
import path from "node:path";
import { Lease } from "../storage/lease.js";
import { runPath } from "../storage/paths.js";
import { canonicalInputHash } from "./cache.js";
import { WorkflowExecution } from "./executor.js";
import { PersistenceDegradedError, RunJournal } from "./journal.js";
import { discoverRunIds, recoverRun } from "./recovery.js";
import type {
	JournalEvent,
	WorkflowDefinition,
	WorkflowEvent,
	WorkflowHost,
	WorkflowRun,
	WorkflowRunStatus,
} from "./types.js";

export class InvalidTransitionError extends Error {
	readonly code = "INVALID_TRANSITION";

	constructor(message: string) {
		super(message);
		this.name = "InvalidTransitionError";
	}
}

export class ApprovalError extends Error {
	readonly code = "APPROVAL_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "ApprovalError";
	}
}

export class RecoveryBlockedError extends Error {
	readonly code = "RECOVERY_BLOCKED";

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RecoveryBlockedError";
	}
}

export interface ControllerJournal {
	append(
		event: Omit<JournalEvent, "schemaVersion" | "seq">,
	): Promise<JournalEvent>;
	snapshot(run: WorkflowRun): Promise<void>;
	persistRun(run: WorkflowRun): Promise<void>;
	restore(): Promise<{
		run?: WorkflowRun;
		source: "primary" | "backup" | "missing" | "corrupt";
	}>;
	load(): Promise<JournalEvent[]>;
}

export interface ControllerOptions {
	cwd?: string;
	validateApproval?: (
		proof: unknown,
		tuple: unknown,
	) => Promise<boolean> | boolean;
	generation?: number;
	resolveDefinition?: (
		run: WorkflowRun,
	) => Promise<WorkflowDefinition | undefined> | WorkflowDefinition | undefined;
	resolveToolset?: (name: string) => unknown;
	journalFactory?: (runId: string, cwd: string) => ControllerJournal;
	now?: () => number;
	random?: () => number;
}

interface WorkflowExecutionControl {
	pause(): void;
	resume(): void;
	stop(): Promise<void>;
	execute(): Promise<unknown>;
}

interface ActiveExecution {
	execution: WorkflowExecutionControl;
	abort: AbortController;
}

export class WorkflowController {
	private readonly runs = new Map<string, WorkflowRun>();
	private readonly tasks = new Map<string, Promise<void>>();
	private readonly executions = new Map<string, ActiveExecution>();
	private readonly definitions = new Map<string, WorkflowDefinition>();
	private readonly journals = new Map<string, ControllerJournal>();
	private readonly leases = new Map<string, Lease>();
	private readonly stopping = new Set<string>();
	private readonly suspending = new Set<string>();
	private readonly listeners = new Set<
		(event: WorkflowEvent) => void | Promise<void>
	>();
	private readonly cwd: string;
	private readonly generation: number;
	private readonly validateApproval?: ControllerOptions["validateApproval"];
	private readonly resolveDefinition?: ControllerOptions["resolveDefinition"];
	private readonly resolveToolset?: ControllerOptions["resolveToolset"];
	private readonly journalFactory: (
		runId: string,
		cwd: string,
	) => ControllerJournal;
	private readonly now: () => number;
	private readonly random: () => number;
	private disposed = false;

	constructor(
		private readonly host: WorkflowHost,
		options: ControllerOptions | string = process.cwd(),
	) {
		const resolved = typeof options === "string" ? { cwd: options } : options;
		this.cwd = resolved.cwd ?? process.cwd();
		this.generation = resolved.generation ?? 1;
		this.validateApproval = resolved.validateApproval;
		this.resolveDefinition = resolved.resolveDefinition;
		this.resolveToolset = resolved.resolveToolset;
		this.journalFactory =
			resolved.journalFactory ?? ((runId, cwd) => new RunJournal(runId, cwd));
		this.now = resolved.now ?? Date.now;
		this.random = resolved.random ?? Math.random;
	}

	subscribe(
		listener: (event: WorkflowEvent) => void | Promise<void>,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async publish(event: WorkflowEvent): Promise<void> {
		await Promise.allSettled(
			[...this.listeners].map((listener) => listener(structuredClone(event))),
		);
	}

	private journalFor(runId: string): ControllerJournal {
		const existing = this.journals.get(runId);
		if (existing) return existing;
		const journal = this.journalFactory(runId, this.cwd);
		this.journals.set(runId, journal);
		return journal;
	}

	private async assertOwner(run: WorkflowRun): Promise<void> {
		const lease = this.leases.get(run.id);
		if (!lease)
			throw new RecoveryBlockedError(`run ${run.id} has no controller lease`);
		await lease.assert(this.generation);
		if (
			run.controllerGeneration !== this.generation ||
			run.fencingToken !== lease.record.token
		) {
			throw new RecoveryBlockedError(
				`run ${run.id} is fenced by another controller`,
			);
		}
	}

	private async degrade(
		run: WorkflowRun,
		journal: ControllerJournal,
		cause: unknown,
	): Promise<never> {
		run.status = "persistence_degraded";
		run.persistenceHealth = "degraded";
		run.error = cause instanceof Error ? cause.message : String(cause);
		run.updatedAt = this.now();
		try {
			await journal.append({
				type: "persistence_degraded",
				runId: run.id,
				at: run.updatedAt,
				payload: { error: run.error },
			});
			await journal.snapshot(run);
		} catch {
			// The in-memory state and event remain the last-resort operator signal.
		}
		await this.publish({
			type: "persistence_degraded",
			runId: run.id,
			at: run.updatedAt,
			data: { error: run.error },
		});
		throw new PersistenceDegradedError("workflow persistence is degraded", {
			cause,
		});
	}

	private async transition(
		run: WorkflowRun,
		status: WorkflowRunStatus,
		data?: unknown,
	): Promise<void> {
		await this.assertOwner(run);
		const journal = this.journalFor(run.id);
		const next = structuredClone(run);
		next.status = status;
		next.updatedAt = this.now();
		try {
			await journal.append({
				type: status,
				runId: run.id,
				at: next.updatedAt,
				payload: data,
			});
			await journal.snapshot(next);
		} catch (error) {
			await this.degrade(run, journal, error);
		}
		Object.assign(run, next);
		await this.publish({
			type: status,
			runId: run.id,
			at: next.updatedAt,
			data,
		});
	}

	private approvalRecord(
		definition: WorkflowDefinition,
		args: unknown,
		proof: unknown,
	): WorkflowRun["approval"] {
		if (proof && typeof proof === "object" && !Array.isArray(proof)) {
			const candidate = proof as Record<string, unknown>;
			if (
				typeof candidate.hash === "string" &&
				candidate.hash.length > 0 &&
				"tuple" in candidate
			) {
				return {
					hash: candidate.hash,
					tuple: structuredClone(candidate.tuple),
				};
			}
		}
		const tuple = {
			definition: {
				name: definition.name,
				version: definition.version,
				sourceHash: definition.sourceHash,
				sourcePath: definition.sourcePath,
			},
			args,
			limits: definition.limits ?? {},
			proof,
		};
		return {
			hash: canonicalInputHash(tuple),
			tuple,
		};
	}

	private approvalValidationTuple<A>(
		definition: WorkflowDefinition<A>,
		args: A,
	): unknown {
		return {
			name: definition.name,
			version: definition.version,
			sourceHash: definition.sourceHash,
			sourcePath: definition.sourcePath,
			args,
			limits: definition.limits ?? {},
		};
	}

	async start<A, R>(
		definition: WorkflowDefinition<A, R>,
		args: A,
		approval?: unknown,
	): Promise<WorkflowRun<A>> {
		if (this.disposed)
			throw new InvalidTransitionError("controller is disposed");
		if (this.validateApproval) {
			if (
				!approval ||
				typeof approval !== "object" ||
				Array.isArray(approval)
			) {
				throw new ApprovalError("workflow approval proof is missing");
			}
			const proof = approval as Record<string, unknown>;
			if (
				typeof proof.hash !== "string" ||
				proof.hash.length === 0 ||
				!proof.tuple ||
				typeof proof.tuple !== "object" ||
				Array.isArray(proof.tuple)
			) {
				throw new ApprovalError("workflow approval proof is malformed");
			}
			if (
				!(await this.validateApproval(
					approval,
					this.approvalValidationTuple(definition, args),
				))
			) {
				throw new ApprovalError("workflow approval proof is invalid or stale");
			}
		}

		const id = randomUUID();
		const lease = await Lease.acquire(
			path.join(runPath(id, this.cwd), "controller.lease"),
			this.generation,
		);
		const createdAt = this.now();
		const run: WorkflowRun<A> = {
			schemaVersion: 2,
			id,
			namespace: id,
			controllerGeneration: this.generation,
			fencingToken: lease.record.token,
			executionEpoch: 0,
			definition: {
				name: definition.name,
				version: definition.version,
				sourceHash: definition.sourceHash,
				sourcePath: definition.sourcePath,
			},
			args: structuredClone(args),
			approval: this.approvalRecord(definition, args, approval),
			limits: structuredClone(definition.limits ?? {}),
			status: "planned",
			persistenceHealth: "healthy",
			calls: [],
			deterministic: { now: [], random: [] },
			totals: { agents: 0, outputTokens: 0, runtimeMs: 0 },
			phases: [],
			createdAt,
			updatedAt: createdAt,
		};
		const journal = this.journalFor(id);
		try {
			await journal.append({
				type: "run_created",
				runId: id,
				at: createdAt,
				payload: run.approval?.tuple,
			});
			await journal.snapshot(run);
		} catch (error) {
			await lease.release().catch(() => undefined);
			await this.degrade(run, journal, error);
		}

		this.leases.set(id, lease);
		this.runs.set(id, run);
		this.definitions.set(id, definition);
		await this.transition(run, "running");
		this.launch(run, definition);
		return structuredClone(run);
	}

	private createExecution<A, R>(
		run: WorkflowRun<A>,
		definition: WorkflowDefinition<A, R>,
	): ActiveExecution {
		const abort = new AbortController();
		const journal = this.journalFor(run.id);
		const execution = new WorkflowExecution(definition, {
			run,
			host: this.host,
			signal: abort.signal,
			journal: async (event) => {
				await this.assertOwner(run);
				const attemptId =
					event.childId === undefined
						? undefined
						: run.calls
								.flatMap((call) => call.attempts)
								.find((attempt) => attempt.childId === event.childId)?.id;
				await journal.append({
					type: event.type,
					runId: run.id,
					callIndex: event.callIndex,
					attemptId,
					at: this.now(),
					payload: {
						childId: event.childId,
						value: event.payload,
					},
				});
			},
			stateWriter: async (state) => {
				try {
					await this.assertOwner(run);
					await journal.snapshot(state);
				} catch (error) {
					await this.degrade(run, journal, error);
				}
			},
			eventSink: (event) => this.publish(event),
			onPaused: async () => {
				if (run.status === "pausing") await this.transition(run, "paused");
			},
			resolveToolset: this.resolveToolset,
			now: this.now,
			random: this.random,
			captureOnly: false,
		});
		return { execution, abort };
	}

	private launch<A, R>(
		run: WorkflowRun<A>,
		definition: WorkflowDefinition<A, R>,
	): void {
		const active = this.createExecution(run, definition);
		this.executions.set(run.id, active);
		const task = Promise.resolve().then(async () => {
			try {
				run.result = await active.execution.execute();
				if (
					!this.stopping.has(run.id) &&
					!this.suspending.has(run.id) &&
					!["cancelled", "paused", "pausing", "persistence_degraded"].includes(
						run.status,
					)
				) {
					await this.transition(run, "completed");
				}
			} catch (error) {
				if (
					this.stopping.has(run.id) ||
					this.suspending.has(run.id) ||
					["cancelled", "paused", "pausing", "persistence_degraded"].includes(
						run.status,
					)
				) {
					return;
				}
				run.error = error instanceof Error ? error.message : String(error);
				await this.transition(run, "failed", { error: run.error }).catch(
					() => undefined,
				);
			} finally {
				run.updatedAt = this.now();
				this.executions.delete(run.id);
			}
		});
		this.tasks.set(run.id, task);
		void task.finally(() => {
			if (this.tasks.get(run.id) === task) this.tasks.delete(run.id);
		});
	}

	async wait(runId: string): Promise<WorkflowRun | undefined> {
		await this.tasks.get(runId);
		const run = this.runs.get(runId);
		return run ? structuredClone(run) : undefined;
	}

	async list(): Promise<WorkflowRun[]> {
		return structuredClone([...this.runs.values()]);
	}

	async inspect(runId: string): Promise<WorkflowRun | undefined> {
		const run = this.runs.get(runId);
		return run ? structuredClone(run) : undefined;
	}

	private require(runId: string): WorkflowRun {
		const run = this.runs.get(runId);
		if (!run)
			throw new InvalidTransitionError(`workflow run ${runId} was not found`);
		return run;
	}

	async pause(runId: string): Promise<WorkflowRun> {
		const run = this.require(runId);
		if (run.status !== "running") {
			throw new InvalidTransitionError(
				`cannot pause workflow in ${run.status}`,
			);
		}
		const active = this.executions.get(runId);
		if (!active) throw new InvalidTransitionError("workflow is not active");
		active.execution.pause();
		await this.transition(run, "pausing");
		return structuredClone(run);
	}

	async resume(runId: string): Promise<WorkflowRun> {
		const run = this.require(runId);
		if (!(["paused", "pausing"] as WorkflowRunStatus[]).includes(run.status)) {
			throw new InvalidTransitionError(
				`cannot resume workflow in ${run.status}`,
			);
		}
		const active = this.executions.get(runId);
		if (active) {
			await this.transition(run, "running");
			active.execution.resume();
			return structuredClone(run);
		}

		const definition =
			this.definitions.get(runId) ??
			(await this.resolveDefinition?.(structuredClone(run)));
		if (!definition) {
			run.blockedReason = "exact approved workflow definition is unavailable";
			throw new RecoveryBlockedError(run.blockedReason);
		}
		this.definitions.set(runId, definition);
		await this.transition(run, "running");
		this.launch(run, definition);
		return structuredClone(run);
	}

	private async suspend(runId: string): Promise<void> {
		const run = this.require(runId);
		const active = this.executions.get(runId);
		if (!active) return;
		this.suspending.add(runId);
		try {
			if (run.status === "running") {
				active.execution.pause();
				await this.transition(run, "pausing");
			}
			active.abort.abort();
			await active.execution.stop();
			await this.tasks.get(runId);
			if (run.status === "pausing") await this.transition(run, "paused");
		} finally {
			this.suspending.delete(runId);
		}
	}

	async stop(runId: string): Promise<WorkflowRun> {
		const run = this.require(runId);
		if (["completed", "cancelled"].includes(run.status))
			return structuredClone(run);
		this.stopping.add(runId);
		const active = this.executions.get(runId);
		active?.abort.abort();
		await active?.execution.stop();
		try {
			await this.transition(run, "cancelled");
		} finally {
			this.stopping.delete(runId);
		}
		return structuredClone(run);
	}

	async retry(runId: string, callIndex?: number): Promise<WorkflowRun> {
		const run = this.require(runId);
		if (this.executions.has(runId)) {
			throw new InvalidTransitionError("cannot retry an active workflow");
		}
		const index =
			callIndex ??
			run.calls.find((call) =>
				["failed", "unknown", "cancelled"].includes(call.status),
			)?.index;
		if (index === undefined) {
			throw new InvalidTransitionError("workflow has no retryable call");
		}
		const offset = run.calls.findIndex((call) => call.index === index);
		if (offset < 0)
			throw new InvalidTransitionError(`call ${index} was not found`);
		run.calls.splice(offset);
		run.result = undefined;
		run.error = undefined;
		run.blockedReason = undefined;

		const definition =
			this.definitions.get(runId) ??
			(await this.resolveDefinition?.(structuredClone(run)));
		if (!definition) {
			run.blockedReason = "exact approved workflow definition is unavailable";
			throw new RecoveryBlockedError(run.blockedReason);
		}
		this.definitions.set(runId, definition);
		await this.transition(run, "planned", { retryFrom: index });
		await this.transition(run, "running", { retryFrom: index });
		this.launch(run, definition);
		return structuredClone(run);
	}

	async restore(): Promise<WorkflowRun[]> {
		for (const runId of await discoverRunIds(this.cwd)) {
			let lease: Lease;
			try {
				lease = await Lease.acquire(
					path.join(runPath(runId, this.cwd), "controller.lease"),
					this.generation,
				);
			} catch (error) {
				throw new RecoveryBlockedError(
					`workflow run ${runId} is owned by another live controller`,
					{ cause: error },
				);
			}

			try {
				const run = await recoverRun(runId, this.host, { cwd: this.cwd });
				if (["running", "pausing"].includes(run.status)) {
					run.status = "paused";
					run.blockedReason = "restored after controller interruption";
				}
				run.controllerGeneration = this.generation;
				run.fencingToken = lease.record.token;
				run.updatedAt = this.now();
				const journal = this.journalFor(runId);
				await journal.append({
					type: "controller_claimed",
					runId,
					at: run.updatedAt,
					payload: {
						generation: this.generation,
						fencingToken: lease.record.token,
					},
				});
				await journal.snapshot(run);
				this.leases.set(runId, lease);
				this.runs.set(runId, run);
				const definition = await this.resolveDefinition?.(structuredClone(run));
				if (definition) this.definitions.set(runId, definition);
				else if (["paused", "pausing", "failed"].includes(run.status)) {
					run.blockedReason =
						"exact approved workflow definition is unavailable";
					await journal.snapshot(run);
				}
			} catch (error) {
				await lease.release().catch(() => undefined);
				throw error;
			}
		}
		return this.list();
	}

	async initialize(): Promise<WorkflowRun[]> {
		return this.restore();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await Promise.allSettled(
			[...this.executions.keys()].map((runId) => this.suspend(runId)),
		);
		await Promise.allSettled(this.tasks.values());
		await Promise.allSettled(
			[...this.leases.values()].map((lease) => lease.release()),
		);
		this.leases.clear();
		this.listeners.clear();
	}
}
