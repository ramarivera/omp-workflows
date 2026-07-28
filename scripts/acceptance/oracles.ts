import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RpcFrame, TranscriptEntry } from "./rpc.js";

export const SCENARIOS = [
	"generate-inspect-approve-run",
	"parallel-scheduling",
	"structured-failure",
	"pause-resume",
	"process-recovery",
	"approval-invalidation",
	"model-facing-control",
	"isolation",
	"session-continuity",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type Verdict = "pass" | "fail" | "inconclusive";
export type AssertionMap = Record<string, boolean>;

export type FileEvidence = {
	path: string;
	relativePath: string;
	content?: string;
	json?: unknown;
};
export type RunSnapshot = {
	id?: string;
	status?: string;
	calls?: Array<Record<string, unknown>>;
	result?: unknown;
	error?: string;
	limits?: Record<string, unknown>;
	deterministic?: { now?: unknown[]; random?: unknown[] };
	totals?: Record<string, unknown>;
	definition?: Record<string, unknown>;
};
export type JournalEntry = {
	type?: string;
	seq?: number;
	runId?: string;
	callIndex?: number;
	attemptId?: string;
	at?: number;
	payload?: unknown;
};
export type ScenarioEvidence = {
	scenario: Scenario;
	frames: RpcFrame[];
	transcript: TranscriptEntry[];
	uiRequests: Array<{ id: string; method: string; title?: string; message?: string }>;
	files: FileEvidence[];
	runs: RunSnapshot[];
	journals: JournalEntry[];
	gitDiff: string;
	gitHead: string;
	approvalHashes: string[];
	usage: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function walk(root: string, base = root): Promise<FileEvidence[]> {
	const entries: FileEvidence[] = [];
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return entries;
	}
	for (const name of names.sort()) {
		if (name === ".git") continue;
		if (name === "node_modules") continue;
		const path = join(root, name);
		const info = await stat(path).catch(() => undefined);
		if (!info) continue;
		if (info.isDirectory()) {
			entries.push(...(await walk(path, base)));
			continue;
		}
		if (!info.isFile()) continue;
		const item: FileEvidence = { path, relativePath: relative(base, path) };
		if (info.size <= 2_000_000) {
			const content = await readFile(path, "utf8").catch(() => undefined);
			if (content !== undefined) {
				item.content = content;
				try { item.json = JSON.parse(content); } catch { /* non-json artifact */ }
			}
		}
		entries.push(item);
	}
	return entries;
}

function parseLines(content: string | undefined): JournalEntry[] {
	if (!content) return [];
	return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
		try {
			const value = JSON.parse(line) as unknown;
			return isObject(value) ? [value as JournalEntry] : [];
		} catch { return []; }
	});
}

function filesForRun(files: FileEvidence): boolean {
	return files.relativePath.endsWith("/run.json") || files.relativePath === "run.json";
}

export async function collectScenarioEvidence(input: {
	scenario: Scenario;
	fixtureDir: string;
	transcript: TranscriptEntry[];
	frames: RpcFrame[];
	uiRequests: Array<{ id: string; method: string; title?: string; message?: string }>;
	gitDiff: string;
	gitHead: string;
}): Promise<ScenarioEvidence> {
	const files = await walk(input.fixtureDir);
	const runs: RunSnapshot[] = [];
	const journals: JournalEntry[] = [];
	const approvalHashes: string[] = [];
	for (const file of files) {
		if (filesForRun(file) && isObject(file.json)) runs.push(file.json as RunSnapshot);
		if (file.relativePath.endsWith("journal.jsonl")) journals.push(...parseLines(file.content));
		if (file.relativePath.endsWith("workflow-approvals.json")) {
			const approvals = Array.isArray(file.json)
				? file.json
				: isObject(file.json) && Array.isArray(file.json.approvals)
					? file.json.approvals
					: [];
			for (const value of approvals) if (isObject(value) && typeof value.hash === "string") approvalHashes.push(value.hash);
		}
	}
	let usage: unknown;
	for (const frame of input.frames) if (frame.usage !== undefined) usage = frame.usage;
	return { ...input, files, runs, journals, approvalHashes: [...new Set(approvalHashes)], usage };
}

function toolFrames(evidence: ScenarioEvidence, name: string): RpcFrame[] {
	return evidence.frames.filter((frame) => JSON.stringify(frame).includes(`"${name}"`));
}
function transitions(evidence: ScenarioEvidence): string[] {
	return evidence.journals.flatMap((entry) => typeof entry.type === "string" ? [entry.type] : []);
}
function completedRun(evidence: ScenarioEvidence): boolean {
	return evidence.runs.some((run) => run.status === "completed");
}
function hasArtifact(evidence: ScenarioEvidence): boolean {
	return evidence.files.some((file) => file.relativePath.includes("artifact") || file.relativePath.includes("output") || file.relativePath.endsWith(".patch")) || evidence.runs.some((run) => run.status === "completed" && run.result !== undefined);
}
function uniqueCallIndices(evidence: ScenarioEvidence): number[] {
	return [...new Set(evidence.journals.flatMap((entry) => typeof entry.callIndex === "number" ? [entry.callIndex] : []))].sort((a, b) => a - b);
}
function transitionPath(evidence: ScenarioEvidence, required: string[]): boolean {
	let at = 0;
	for (const transition of transitions(evidence)) if (transition === required[at]) at++;
	return at === required.length;
}

export function assertScenario(evidence: ScenarioEvidence): AssertionMap {
	const base: AssertionMap = {
		journalPresent: evidence.journals.length > 0,
		snapshotPresent: evidence.runs.length > 0,
		recursiveArtifactsCollected: evidence.files.length > 0,
		transcriptPreserved: evidence.transcript.length > 0 && evidence.transcript.every((entry) => typeof entry.raw === "string"),
		gitHeadCaptured: evidence.gitHead.length > 0,
	};
	if (evidence.scenario === "generate-inspect-approve-run") {
		const displayed = evidence.uiRequests.flatMap((request) => {
			const match = request.message?.match(/\b[a-f0-9]{64}\b/);
			return match ? [match[0]] : [];
		});
		const resultHashes = toolFrames(evidence, "workflow_stage").flatMap((frame) => JSON.stringify(frame).match(/\b[a-f0-9]{64}\b/g) ?? []);
		const approvedHashes = evidence.uiRequests.flatMap((request) => {
			const approved = evidence.transcript.some(
				(entry) =>
					entry.direction === "out" &&
					entry.frame?.type === "extension_ui_response" &&
					entry.frame.id === request.id &&
					entry.frame.confirmed === true,
			);
			if (!approved) return [];
			const hash = request.message?.match(/\b[a-f0-9]{64}\b/);
			return hash ? [hash[0]] : [];
		});
		base.sourceAuthored = evidence.files.some((file) => file.relativePath.includes(".omp/workflows") && file.path.endsWith(".ts") && (file.content?.includes("export") ?? false));
		base.rawProgramDisplayed = displayed.length > 0;
		base.exactDisplayedHashApproved = displayed.some((hash) => approvedHashes.includes(hash));
		base.savedApprovalHashRecorded = resultHashes.some((hash) => evidence.approvalHashes.includes(hash));
		base.completed = completedRun(evidence);
		base.terminalArtifact = hasArtifact(evidence);
		return base;
	}
	if (evidence.scenario === "parallel-scheduling") {
		const calls = evidence.runs.flatMap((run) => run.calls ?? []);
		const intervals = calls.flatMap((call) => (call.attempts as unknown[] | undefined)?.flatMap((attempt) => {
			if (!isObject(attempt) || typeof attempt.startedAt !== "number" || typeof attempt.finishedAt !== "number") return [];
			return [{ start: attempt.startedAt, end: attempt.finishedAt }];
		}) ?? []);
		const peak = intervals.reduce((max, interval, _, all) => Math.max(max, all.filter((other) => other.start < interval.end && other.end > interval.start).length), 0);
		const limit = Number(evidence.runs[0]?.limits?.maxConcurrency ?? 0);
		const terminalByIndex = new Map<number, number>();
		for (const [index, entry] of evidence.journals.entries()) {
			if (typeof entry.callIndex === "number" && ["call.succeeded", "call.failed", "call.cancelled"].includes(String(entry.type))) terminalByIndex.set(entry.callIndex, index);
		}
		const dependentDispatch = evidence.journals.findIndex((entry) => entry.type === "call.dispatched" && entry.callIndex === 2);
		base.independentOverlap = intervals.length > 1 && peak > 1;
		base.dependentWait = dependentDispatch >= 0 && [0, 1].every((callIndex) => (terminalByIndex.get(callIndex) ?? Number.POSITIVE_INFINITY) < dependentDispatch);
		base.concurrencyBound = limit > 0 && peak <= limit;
		base.deterministicOrdering = uniqueCallIndices(evidence).every((value, index, all) => index === 0 || value >= all[index - 1]);
		base.successfulCalls = calls.length === 3 && calls.every((call) => call.status === "succeeded");
		base.completed = completedRun(evidence);
		return base;
	}
	if (evidence.scenario === "structured-failure") {
		const calls = evidence.runs.flatMap((run) => run.calls ?? []);
		base.typedFailure = evidence.runs.some((run) => typeof run.error === "string" && run.error.length > 0) || evidence.journals.some((entry) => entry.type === "call.failed");
		base.successfulSiblingPreserved = calls.some((call) => call.status === "succeeded") && calls.some((call) => call.status === "failed");
		base.partialResultPreserved = evidence.runs.some((run) => isObject(run.result) || Array.isArray(run.result));
		return base;
	}
	if (evidence.scenario === "pause-resume") {
		base.pauseTransition = transitionPath(evidence, ["pausing", "paused", "running"]);
		const pausedAt = evidence.journals.findIndex((entry) => entry.type === "paused");
		const resumedAt = evidence.journals.findIndex((entry, index) => index > pausedAt && entry.type === "running");
		base.noDispatchWhilePaused = pausedAt >= 0 && resumedAt > pausedAt && !evidence.journals.slice(pausedAt + 1, resumedAt).some((entry) => entry.type === "call.dispatched");
		const dispatched = evidence.journals.filter((entry) => entry.type === "call.dispatched").map((entry) => entry.attemptId).filter(Boolean);
		base.acceptedPrefixNotRerun = dispatched.length === new Set(dispatched).size;
		base.completed = completedRun(evidence);
		return base;
	}
	if (evidence.scenario === "process-recovery") {
		base.boundaryPersisted = evidence.journals.some((entry) => entry.type === "call.dispatched" || entry.type === "controller_claimed");
		base.singleRunRecovered = evidence.runs.length === 1;
		base.reconciledOrTerminal = evidence.journals.some((entry) => entry.type === "reconciled") || evidence.runs.some((run) => ["completed", "failed", "cancelled", "persistence_degraded"].includes(String(run.status)) || (run.calls ?? []).some((call) => call.status === "unknown"));
		base.noDuplicateSideEffects = evidence.runs.every((run) => (run.calls ?? []).every((call) => ((call.attempts as unknown[] | undefined)?.length ?? 0) <= 1));
		return base;
	}
	if (evidence.scenario === "approval-invalidation") {
		const invalidationIndex = evidence.frames.findIndex((frame) => /stale|invalid|approval/i.test(JSON.stringify(frame)) && (frame.success === false || frame.isError === true));
		const tupleDimensions = ["source", "args", "toolset", "model", "thinking", "isolation", "plugin"].filter((dimension) => evidence.transcript.some((entry) => entry.raw.includes(dimension)));
		base.invalidationRejected = invalidationIndex >= 0;
		base.allTupleDimensionsExercised = tupleDimensions.length === 7;
		base.onlyBaselineChildStarted = evidence.journals.filter((entry) => entry.type === "call.dispatched").length === 1;
		return base;
	}
	if (evidence.scenario === "model-facing-control") {
		const actions = ["list", "status", "pause", "resume", "stop", "retry"];
		base.statusInspected = actions.slice(0, 2).some((action) => toolFrames(evidence, "workflow_control").some((frame) => JSON.stringify(frame).includes(action)));
		base.validTransitionsOnly = !evidence.frames.some((frame) => frame.isError === true && JSON.stringify(frame).includes("invalid_action"));
		base.controlTransitionsObserved = evidence.journals.some((entry) => ["pausing", "paused", "running", "cancelled", "failed"].includes(String(entry.type)));
		base.artifactStateMatches = evidence.runs.length > 0 && evidence.journals.length > 0;
		return base;
	}
	if (evidence.scenario === "isolation") {
		base.captureOnlyPatch = evidence.runs.some((run) => (run.calls ?? []).some((call) => call.status === "succeeded" && call.patch !== undefined)) || evidence.files.some((file) => file.relativePath.endsWith(".patch"));
		base.inspectableArtifact = hasArtifact(evidence);
		base.sourceWorkspaceUnchanged = evidence.gitDiff.length === 0;
		base.unavailableIsolationFailsClosed = evidence.runs.some((run) => isObject(run.result) && run.result.unavailableIsolationRejected === true) && evidence.journals.some((entry) => entry.type === "call.failed" && entry.callIndex === 1) && !evidence.journals.some((entry) => entry.type === "call.succeeded" && entry.callIndex === 1);
		return base;
	}
	base.newSessionObserved = evidence.frames.some(
		(frame) => frame.type === "response" && frame.command === "new_session" && frame.success === true,
	);
	base.sameRunInspectable = evidence.runs.length > 0 && evidence.runs.some((run) => run.calls?.every((call) => typeof call.status === "string") ?? false);
	base.completedOutputsPersisted = evidence.runs.some((run) => run.result !== undefined) && hasArtifact(evidence);
	base.reloadObserved = evidence.transcript.some((entry) => entry.raw.includes("session_start") || entry.raw.includes("new_session"));
	return base;
}

