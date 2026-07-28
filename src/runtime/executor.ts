import { canonicalInputHash, ReplayCache } from "./cache.js";
import { SharedLimits } from "./limits.js";
import type {
	AgentCallOptions,
	AgentRequest,
	AgentResult,
	WorkflowAttempt,
	WorkflowCall,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowEvent,
	WorkflowHost,
	WorkflowRun,
} from "./types.js";

export class WorkflowAbortError extends Error {
	readonly code = "WORKFLOW_ABORTED";

	constructor(message = "workflow aborted") {
		super(message);
		this.name = "WorkflowAbortError";
	}
}

export class IsolationUnavailableError extends Error {
	readonly code = "ISOLATION_UNAVAILABLE";

	constructor() {
		super("workflow isolation unavailable");
		this.name = "IsolationUnavailableError";
	}
}

export class IntegrationHeadMismatchError extends Error {
	readonly code = "INTEGRATION_HEAD_MISMATCH";

	constructor(expected: string, actual: string | undefined) {
		super(
			`captured integration head mismatch: expected ${expected}, received ${actual ?? "none"}`,
		);
		this.name = "IntegrationHeadMismatchError";
	}
}

export interface ExecutionEvent {
	type: string;
	callIndex?: number;
	childId?: string;
	payload?: unknown;
}

export interface ExecutorOptions<A = unknown> {
	run: WorkflowRun<A>;
	host: WorkflowHost;
	journal?: (event: ExecutionEvent) => void | Promise<void>;
	stateWriter?: (run: WorkflowRun<A>) => void | Promise<void>;
	eventSink?: (event: WorkflowEvent) => void | Promise<void>;
	onPaused?: () => void | Promise<void>;
	limits?: SharedLimits;
	signal?: AbortSignal;
	resolveToolset?: (name: string) => unknown;
	now?: () => number;
	random?: () => number;
	capturedIntegrationHead?: string;
	captureOnly?: boolean;
}

function stableCallHash(
	run: WorkflowRun,
	prompt: string,
	options: AgentCallOptions,
	definition: WorkflowDefinition,
): string {
	return canonicalInputHash({
		definition: {
			name: definition.name,
			version: definition.version,
			sourceHash: definition.sourceHash,
			sourcePath: definition.sourcePath,
		},
		args: run.args,
		prompt,
		options,
	});
}

function minimumDefined(values: Array<number | undefined>): number | undefined {
	const defined = values.filter(
		(value): value is number => value !== undefined,
	);
	return defined.length === 0 ? undefined : Math.max(0, Math.min(...defined));
}

export class WorkflowExecution<A = unknown, R = unknown> {
	private nextIndex = 0;
	private paused = false;
	private stopped = false;
	private pausedPublished = false;
	private fence = 0;
	private readonly active = new Map<string, AbortController>();
	private readonly cache: ReplayCache;
	private readonly limits: SharedLimits;
	private gate?: Promise<void>;
	private openGate?: () => void;
	private deterministicWrites: Promise<void> = Promise.resolve();
	private readonly replayNow: number[];
	private readonly replayRandom: number[];

	constructor(
		private readonly definition: WorkflowDefinition<A, R>,
		private readonly options: ExecutorOptions<A>,
	) {
		const priorCalls = structuredClone(options.run.calls);
		this.cache = new ReplayCache(priorCalls, options.run.namespace);
		options.run.calls = [];
		const previousDeterminism = structuredClone(
			options.run.deterministic ?? { now: [], random: [] },
		);
		this.replayNow = previousDeterminism.now;
		this.replayRandom = previousDeterminism.random;
		options.run.deterministic = { now: [], random: [] };
		options.run.executionEpoch = (options.run.executionEpoch ?? 0) + 1;
		this.limits =
			options.limits ??
			new SharedLimits(options.run.limits, undefined, {
				agents: options.run.totals.agents,
				outputTokens: options.run.totals.outputTokens,
				startedAt: options.run.createdAt,
				now: options.now,
			});
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.pausedPublished = false;
		this.openGate?.();
		this.openGate = undefined;
		this.gate = undefined;
	}

	private async waitGate(): Promise<void> {
		if (this.paused) {
			this.gate ??= new Promise<void>((resolve) => {
				this.openGate = resolve;
			});
			if (!this.pausedPublished) {
				this.pausedPublished = true;
				await this.options.onPaused?.();
			}
			await this.gate;
		}
		this.guard();
	}

	private guard(): void {
		if (this.stopped || this.options.signal?.aborted)
			throw new WorkflowAbortError();
		this.limits.check();
	}

	private async event(
		type: string,
		callIndex?: number,
		childId?: string,
		payload?: unknown,
	): Promise<void> {
		await this.options.journal?.({ type, callIndex, childId, payload });
		await this.options.stateWriter?.(this.options.run);
		await this.options.eventSink?.({
			type,
			runId: this.options.run.id,
			callIndex,
			childId,
			data: payload,
			at: this.options.now?.() ?? Date.now(),
		});
	}

	private deterministicValue(kind: "now" | "random"): number {
		const replay = kind === "now" ? this.replayNow : this.replayRandom;
		const isReplay = replay.length > 0;
		const value = isReplay
			? (replay.splice(0, 1)[0] as number)
			: kind === "now"
				? (this.options.now?.() ?? Date.now())
				: (this.options.random?.() ?? Math.random());
		const deterministic = this.options.run.deterministic ?? {
			now: [],
			random: [],
		};
		deterministic[kind].push(value);
		this.options.run.deterministic = deterministic;
		this.deterministicWrites = this.deterministicWrites.then(() =>
			this.event(
				`context.${isReplay ? "replayed." : ""}${kind}`,
				undefined,
				undefined,
				value,
			),
		);
		return value;
	}

	private async flushDeterminism(): Promise<void> {
		await this.deterministicWrites;
	}

	context(): WorkflowContext<A> {
		return {
			args: this.options.run.args,
			agent: this.agent.bind(this),
			parallel: async <T>(tasks: Array<() => Promise<T>>, fatal = false) => {
				const promises = tasks.map((task) => task());
				if (!fatal) {
					const settled = await Promise.allSettled(promises);
					return settled.map((result) =>
						result.status === "fulfilled" ? result.value : (undefined as T),
					);
				}
				try {
					return await Promise.all(promises);
				} catch (error) {
					await this.stop();
					await Promise.allSettled(promises);
					throw error;
				}
			},
			pipeline: async <T>(
				value: T | Promise<T>,
				...stages: Array<(stageValue: unknown) => T | Promise<T>>
			) => {
				let current: unknown = await value;
				for (const stage of stages) current = await stage(current);
				return current as T;
			},
			phase: (title) => {
				this.options.run.phases.push(title);
				this.deterministicWrites = this.deterministicWrites.then(() =>
					this.event("phase", undefined, undefined, { title }),
				);
			},
			now: () => this.deterministicValue("now"),
			random: () => this.deterministicValue("random"),
		};
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.fence += 1;
		const active = [...this.active.entries()];
		await Promise.allSettled(
			active.map(async ([childId, controller]) => {
				controller.abort();
				await this.options.host.cancel?.(childId);
			}),
		);
		this.openGate?.();
	}

	private async assertIsolation(options: AgentCallOptions): Promise<void> {
		const isolation = options.isolation;
		if (!isolation || isolation.mode === "none") return;
		const supported =
			(await this.options.host.supportsIsolation?.(isolation)) ??
			Boolean(options.worktree);
		if (!supported) throw new IsolationUnavailableError();
	}

	private async resolveToolsets(
		toolset: string | string[] | undefined,
	): Promise<string[] | undefined> {
		if (!toolset) return undefined;
		const tools: string[] = [];
		for (const name of Array.isArray(toolset) ? toolset : [toolset]) {
			const resolved =
				(await this.options.resolveToolset?.(name)) ??
				(await this.options.host.toolset?.(name));
			if (resolved === undefined)
				throw new Error(`toolset unavailable: ${name}`);
			const record =
				resolved && typeof resolved === "object" && !Array.isArray(resolved)
					? (resolved as { tools?: unknown }).tools
					: resolved;
			const names =
				typeof record === "string"
					? [record]
					: Array.isArray(record)
						? record.filter(
								(entry): entry is string => typeof entry === "string",
							)
						: [];
			if (names.length === 0) {
				throw new Error(`toolset ${name} resolved without any tools`);
			}
			tools.push(...names);
		}
		return [...new Set(tools)];
	}

	async agent<T = unknown>(
		prompt: string,
		callOptions: AgentCallOptions = {},
	): Promise<T> {
		const callIndex = this.nextIndex++;
		await this.flushDeterminism();
		await this.waitGate();
		const options = structuredClone(callOptions);
		await this.assertIsolation(options);
		const resolvedTools = await this.resolveToolsets(options.toolset);
		const dispatchOptions =
			resolvedTools === undefined
				? options
				: { ...options, toolset: resolvedTools };

		const inputHash = stableCallHash(
			this.options.run,
			prompt,
			options,
			this.definition,
		);
		const captureOnly = this.options.captureOnly || options.apply === false;
		const replay = this.cache.probe(callIndex, inputHash);
		if (replay.hit) {
			const cached: WorkflowCall = {
				...(replay.call ?? {
					index: callIndex,
					namespace: this.options.run.namespace,
					inputHash,
					attempts: [],
				}),
				index: callIndex,
				namespace: this.options.run.namespace,
				inputHash,
				status: "cached",
				result: replay.value,
			};
			this.options.run.calls.push(cached);
			await this.event("call.cached", callIndex, undefined, { inputHash });
			return replay.value as T;
		}
		const capturedIntegrationHead = captureOnly
			? (this.options.capturedIntegrationHead ??
				(await this.options.host.currentIntegrationHead?.()))
			: undefined;

		const call: WorkflowCall = {
			index: callIndex,
			namespace: this.options.run.namespace,
			inputHash,
			status: "queued",
			attempts: [],
		};
		this.options.run.calls.push(call);
		await this.event("call.allocated", callIndex, undefined, { inputHash });

		const epoch = this.options.run.executionEpoch ?? 1;
		const childId = `${this.options.run.id}:${callIndex}:${epoch}`;
		const controller = new AbortController();
		const parentAbort = () => controller.abort();
		this.options.signal?.addEventListener("abort", parentAbort, { once: true });
		this.active.set(childId, controller);
		const release = await this.limits.acquireAgent(controller.signal);
		const attempt: WorkflowAttempt = {
			id: `${childId}:attempt`,
			callIndex,
			childId,
			status: "running",
			inputHash,
			startedAt: this.options.now?.() ?? Date.now(),
			requestedModel: options.model,
			requestedEffort: options.effort,
		};
		call.attempts.push(attempt);
		call.status = "running";
		await this.event("call.dispatched", callIndex, childId, attempt);

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			this.guard();
			const timeoutMs = minimumDefined([
				options.timeoutMs,
				options.idleTimeoutMs,
				this.limits.remainingRuntimeMs(),
			]);
			const request: AgentRequest = {
				runId: this.options.run.id,
				callIndex,
				childId,
				prompt,
				options: dispatchOptions,
				inputHash,
				signal: controller.signal,
			};
			const invocation = this.options.host.invokeAgent<T>(
				request,
				controller.signal,
			);
			const result: AgentResult<T> =
				timeoutMs === undefined
					? await invocation
					: await Promise.race([
							invocation,
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => {
									controller.abort();
									void this.options.host.cancel?.(childId);
									reject(new Error(`agent timed out after ${timeoutMs}ms`));
								}, timeoutMs);
							}),
						]);

			if (this.stopped || this.options.signal?.aborted || this.fence > 0) {
				throw new WorkflowAbortError(
					"late child completion rejected by workflow fence",
				);
			}
			if (result.usage?.outputTokens) {
				this.limits.consumeTokens(result.usage.outputTokens);
			}
			if (captureOnly && capturedIntegrationHead !== undefined) {
				const actual =
					result.integrationHead ??
					(await this.options.host.currentIntegrationHead?.());
				if (actual !== capturedIntegrationHead) {
					throw new IntegrationHeadMismatchError(
						capturedIntegrationHead,
						actual,
					);
				}
			}

			call.status = "succeeded";
			call.result = result.value;
			Object.assign(attempt, {
				status: "succeeded",
				result: result.value,
				usage: result.usage,
				sessionId: result.sessionId,
				handle: result.handle,
				requestedModel: result.requestedModel ?? options.model,
				resolvedModel: result.resolvedModel,
				requestedEffort: result.requestedEffort ?? options.effort,
				resolvedEffort: result.resolvedEffort,
				artifacts: result.artifacts,
				patch: result.patch,
				branch: result.branch,
				integrationHead: result.integrationHead,
				warnings: result.warnings,
				finishedAt: this.options.now?.() ?? Date.now(),
			} satisfies Partial<WorkflowAttempt>);
			this.limits.progress();
			this.options.run.totals = this.limits.totals;
			await this.event("call.succeeded", callIndex, childId, result);
			return result.value;
		} catch (error) {
			const cancelled =
				this.stopped ||
				this.options.signal?.aborted ||
				controller.signal.aborted;
			call.status = cancelled ? "cancelled" : "failed";
			attempt.status = cancelled ? "cancelled" : "failed";
			attempt.error = error instanceof Error ? error.message : String(error);
			attempt.finishedAt = this.options.now?.() ?? Date.now();
			this.options.run.totals = this.limits.totals;
			await this.event(
				cancelled ? "call.cancelled" : "call.failed",
				callIndex,
				childId,
				{ error: attempt.error },
			);
			throw error;
		} finally {
			clearTimeout(timer);
			this.active.delete(childId);
			this.options.signal?.removeEventListener("abort", parentAbort);
			release();
		}
	}

	async execute(): Promise<R> {
		try {
			const result = await this.definition.run(this.context());
			await this.flushDeterminism();
			if (this.stopped || this.options.signal?.aborted)
				throw new WorkflowAbortError();
			this.options.run.result = result;
			this.options.run.totals = this.limits.totals;
			return result;
		} catch (error) {
			if (!this.stopped && !this.options.signal?.aborted) {
				this.options.run.error =
					error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}
}

export async function executeWorkflow<A, R>(
	definition: WorkflowDefinition<A, R>,
	options: ExecutorOptions<A>,
): Promise<R> {
	return new WorkflowExecution<A, R>(definition, options).execute();
}
