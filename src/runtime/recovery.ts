import { promises as fs } from "node:fs";
import { runJsonPath, runPath, workflowRunsRoot } from "../storage/paths.js";
import { RunJournal } from "./journal.js";
import type {
	JournalEvent,
	WorkflowAttempt,
	WorkflowHost,
	WorkflowRun,
} from "./types.js";

export interface RecoveryOptions {
	cwd?: string;
	controllerGeneration?: number;
	fencingToken?: string;
}
export class RecoveryError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RecoveryError";
	}
}

function validRun(value: unknown, id: string): value is WorkflowRun {
	const r = value as WorkflowRun;
	return (
		!!r &&
		typeof r === "object" &&
		r.schemaVersion === 2 &&
		r.id === id &&
		typeof r.namespace === "string" &&
		typeof r.controllerGeneration === "number" &&
		typeof r.fencingToken === "string" &&
		!!r.definition &&
		typeof r.definition.name === "string" &&
		typeof r.definition.version === "number" &&
		Array.isArray(r.calls)
	);
}
function assertWritable(run: WorkflowRun, options: RecoveryOptions) {
	if (
		options.controllerGeneration !== undefined &&
		run.controllerGeneration !== options.controllerGeneration
	)
		throw new RecoveryError(
			"stale controller generation; refusing to persist recovery",
		);
	if (
		options.fencingToken !== undefined &&
		run.fencingToken !== options.fencingToken
	)
		throw new RecoveryError(
			"fencing token mismatch; refusing to persist recovery",
		);
}

/** Discover persisted run directories. Malformed runs are errors, never silently ignored. */
export async function discoverRunIds(cwd = process.cwd()): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(workflowRunsRoot(cwd));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const ids: string[] = [];
	for (const id of entries) {
		const stat = await fs.stat(runPath(id, cwd)).catch(() => undefined);
		if (!stat?.isDirectory()) continue;
		const primary = await fs
			.readFile(runJsonPath(id, cwd), "utf8")
			.catch(() => undefined);
		const backup = await fs
			.readFile(`${runJsonPath(id, cwd)}.bak`, "utf8")
			.catch(() => undefined);
		const candidate = primary ?? backup;
		if (candidate === undefined)
			throw new RecoveryError(`malformed run ${id}: missing snapshot`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			if (backup === undefined)
				throw new RecoveryError(`malformed run ${id}: corrupt snapshot`);
			try {
				parsed = JSON.parse(backup);
			} catch {
				throw new RecoveryError(`malformed run ${id}: corrupt snapshot`);
			}
		}
		if (!validRun(parsed, id))
			throw new RecoveryError(
				`incompatible run ${id}: expected schemaVersion 2`,
			);
		ids.push(id);
	}
	return ids.sort();
}

function eventValue(event: JournalEvent): unknown {
	if (
		event.payload &&
		typeof event.payload === "object" &&
		"value" in event.payload
	) {
		return event.payload.value;
	}
	return event.payload;
}

function applyEvent(run: WorkflowRun, event: JournalEvent): void {
	const existing =
		event.callIndex === undefined
			? undefined
			: run.calls.find((call) => call.index === event.callIndex);
	if (
		["call_allocated", "call.allocated"].includes(event.type) &&
		event.callIndex !== undefined &&
		!existing
	) {
		const payload = (eventValue(event) ?? {}) as {
			inputHash?: string;
			namespace?: string;
		};
		run.calls.push({
			index: event.callIndex,
			namespace: payload.namespace ?? run.namespace,
			inputHash: payload.inputHash ?? "",
			status: "queued",
			attempts: [],
		});
	}

	const call =
		event.callIndex === undefined
			? undefined
			: run.calls.find((candidate) => candidate.index === event.callIndex);
	if (call) {
		if (["dispatched", "call.dispatched"].includes(event.type)) {
			const payload = eventValue(event) as Partial<WorkflowAttempt> | undefined;
			if (
				payload?.id &&
				!call.attempts.some((attempt) => attempt.id === payload.id)
			) {
				call.attempts.push(payload as WorkflowAttempt);
			}
			call.status = "running";
		}
		if (["completed", "call.succeeded"].includes(event.type)) {
			const payload = eventValue(event) as { value?: unknown } | undefined;
			call.status = "succeeded";
			call.result = payload?.value;
			const attempt = call.attempts.find(
				(candidate) => candidate.id === event.attemptId,
			);
			if (attempt) {
				attempt.status = "succeeded";
				attempt.result = call.result;
			}
		}
		if (["failed", "call.failed"].includes(event.type)) {
			call.status = "failed";
			const attempt = call.attempts.find(
				(candidate) => candidate.id === event.attemptId,
			);
			if (attempt) {
				attempt.status = "failed";
				attempt.error = String(
					(eventValue(event) as { error?: unknown } | undefined)?.error ??
						eventValue(event),
				);
			}
		}
		if (event.type === "call.cancelled") call.status = "cancelled";
		if (event.type === "call.cached") call.status = "cached";
	}

	if (
		[
			"running",
			"paused",
			"pausing",
			"completed",
			"failed",
			"cancelled",
			"planned",
			"awaiting_approval",
			"persistence_degraded",
		].includes(event.type)
	) {
		run.status = event.type as WorkflowRun["status"];
	}
}

export async function recoverRun(
	runId: string,
	host: WorkflowHost,
	options: RecoveryOptions = {},
): Promise<WorkflowRun> {
	const cwd = options.cwd ?? process.cwd();
	const journal = new RunJournal(runId, cwd);
	const loaded = await journal.restore();
	const restoredRecord = loaded as {
		run?: WorkflowRun;
		value?: WorkflowRun;
		source: string;
	};
	const restored = restoredRecord.run ?? restoredRecord.value;
	if (!restored)
		throw new RecoveryError(`unable to recover run ${runId}: ${loaded.source}`);
	if (!validRun(restored, runId))
		throw new RecoveryError(
			`incompatible run ${runId}: expected schemaVersion 2`,
		);
	const run = structuredClone(restored);
	assertWritable(run, options);
	const events = await journal.load();
	for (const event of events) {
		if (event.seq > (run.journalSeq ?? 0)) applyEvent(run, event);
	}
	run.journalSeq = events.at(-1)?.seq ?? run.journalSeq ?? 0;
	for (const c of run.calls)
		for (const a of c.attempts)
			if (["dispatched", "running"].includes(a.status)) a.status = "unknown";
	await journal.persistRun(run);
	return reconcileRun(run, host, options);
}

export async function reconcileRun(
	run: WorkflowRun,
	host: WorkflowHost,
	options: RecoveryOptions = {},
): Promise<WorkflowRun> {
	assertWritable(run, options);
	const journal = new RunJournal(run.id, options.cwd ?? process.cwd());
	for (const c of run.calls)
		for (const a of c.attempts) {
			if (a.status !== "unknown") continue;
			const state = (await host.inspectAgent?.(a.childId)) ?? "unknown";
			a.status =
				state === "completed"
					? "succeeded"
					: state === "failed"
						? "failed"
						: state;
			c.status =
				a.status === "succeeded"
					? "succeeded"
					: a.status === "failed"
						? "failed"
						: a.status;
			await journal.append({
				type: "reconciled",
				runId: run.id,
				callIndex: c.index,
				attemptId: a.id,
				at: Date.now(),
				payload: { childId: a.childId, state },
			});
			await journal.persistRun(run);
		}
	return run;
}
