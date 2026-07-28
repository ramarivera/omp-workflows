import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, symlink, rm, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	type AssertionMap,
	assertScenario,
	collectScenarioEvidence,
	SCENARIOS,
	type Scenario,
	type ScenarioEvidence,
	type Verdict,
} from "./acceptance/oracles.js";
import {
	RawRpcClient,
	extractHashFromApprovalMessage,
	type ConfirmRequest,
	type RpcFrame,
	type TranscriptEntry,
} from "./acceptance/rpc.js";
import { PLUGIN_VERSION } from "../src/version.js";

export { SCENARIOS };
export type { Scenario, Verdict };

export const MODEL = "openai-codex/gpt-5.6-luna";
export const THINKING = "low";
export const RUNS_PER_SCENARIO = 3;
export const HARNESS_ID = "omp-rpc-live";
/** Scratch root mandated for acceptance fixtures; isolated from the repo and $HOME. */
export const SCRATCH_ROOT =
	process.env.OMP_LUNA_ACCEPTANCE_SCRATCH ??
	"/Volumes/ExtSSD/SCRATCHPADS_FOR_AGENTS";
const SCENARIO_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 3 * 60_000;
const DISPATCH_TIMEOUT_MS = 5 * 60_000;
const RPC_SCENARIOS = new Set<Scenario>([
	"generate-inspect-approve-run",
	"pause-resume",
	"process-recovery",
	"approval-invalidation",
	"model-facing-control",
	"session-continuity",
]);

export function commandForScenario(
	scenario: Scenario,
	fixtureDir: string,
	profileName: string,
	sessionDir: string,
	_pluginPath: string,
	omp = "omp",
	prompt = promptFor(scenario),
): string[] {
	const args = [
		"--model", MODEL,
		"--thinking", THINKING,
		"--max-time", "10m",
		"--profile", profileName,
		"--cwd", fixtureDir,
		"--session-dir", sessionDir,
	];
	if (RPC_SCENARIOS.has(scenario)) args.push("--mode", "rpc");
	else args.push("-p", "--mode", "json");
	return [omp, ...args, prompt];
}

export function pluginLinkCommand(packageRoot: string, omp = "omp"): string[] {
	return [omp, "plugin", "link", packageRoot];
}
/** Agent-dir files seeded into the isolated profile so Luna auth/model routing still resolve. */
const AGENT_SEED_FILES = [
	"agent.db",
	"agent.db-shm",
	"agent.db-wal",
	"models.yml",
	"models.db",
	"models.db-shm",
	"models.db-wal",
	"config.yml",
] as const;

export type Evidence = {
	command: string[];
	installationCommand: string[];
	prompt: string;
	exit: number | null;
	stdout: string;
	stderr: string;
	transcript: string[];
	gitDiff: string;
	journal: unknown;
	artifacts: string[];
	agentHandles: string[];
	usage: unknown;
	assertions: AssertionMap;
};
export type RunResult = {
	scenario: Scenario;
	iteration: number;
	verdict: Verdict;
	evidence: Evidence;
	nextAction: "keep" | "iterate" | "block release";
};
export type AcceptanceArtifact = {
	schemaVersion: 2;
	harness: typeof HARNESS_ID;
	synthetic: false;
	model: string;
	thinking: string;
	packageVersion: string;
	ompVersion: string;
	extension: string;
	extensionSha256: string;
	gitCommit: string | null;
	gitTag: string | null;
	generatedAt: string;
	roundsRequested: number;
	roundsCompleted: number;
	allPassed: boolean;
	scenarios: readonly Scenario[];
	runs: RunResult[];
};
export type OneShotResult = {
	exit: { code: number | null; signal: NodeJS.Signals | null };
	stdout: string;
	stderr: string;
};
export type SetupEvidence = {
	transcript: TranscriptEntry[];
	uiRequests: ConfirmRequest[];
	frames: RpcFrame[];
};
export type HarnessOptions = {
	omp?: string;
	extension?: string;
	scratchRoot?: string;
	rounds?: number;
	scenarios?: readonly Scenario[];
	packageRoot?: string;
	pluginLinkRunner?: (input: { command: string[]; env: NodeJS.ProcessEnv; cwd: string }) => Promise<void>;
	setupRunner?: (input: { scenario: Scenario; fixtureDir: string; profileName: string; sessionDir: string; extensionPath: string; homeDir: string; omp: string }) => Promise<SetupEvidence | void>;
	oneShotRunner?: (input: { command: string[]; cwd: string; env: NodeJS.ProcessEnv }) => Promise<OneShotResult>;
};
const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
export function parseJsonl(lines: string[]): Record<string, unknown>[] {
	return lines.flatMap((line) => {
		try {
			const value = object(JSON.parse(line));
			return value ? [value] : [];
		} catch {
			return [];
		}
	});
}
const MAX_TRANSCRIPT_ENTRY_CHARS = 64 * 1024;
export function compactTranscript(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
	return entries.flatMap((entry) => {
		const frame = entry.frame;
		if (
			frame?.type === "message_update" ||
			frame?.type === "get_state" ||
			(frame?.type === "response" && frame.command === "get_state")
		) {
			return [];
		}
		if (entry.raw.length <= MAX_TRANSCRIPT_ENTRY_CHARS) return [entry];
		const omitted = entry.raw.length - MAX_TRANSCRIPT_ENTRY_CHARS;
		return [
			{
				...entry,
				raw: `${entry.raw.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}…[${omitted} chars omitted]`,
			},
		];
	});
}


/** Legacy NDJSON contract kept for the original one-shot acceptance test. */
export function parseAcceptanceEvents(lines: string[]): {
	provider: string | null;
	model: string | null;
	workflowStart: boolean;
	workflowEnd: boolean;
	listResult: unknown;
} {
	const summary = {
		provider: null as string | null,
		model: null as string | null,
		workflowStart: false,
		workflowEnd: false,
		listResult: undefined as unknown,
	};
	for (const event of parseJsonl(lines)) {
		const message = object(event.message);
		if (message?.provider === "openai-codex" || event.provider === "openai-codex")
			summary.provider = "openai-codex";
		if (typeof message?.model === "string" && message.model.includes("gpt-5.6-luna"))
			summary.model = message.model;
		const args = object(event.args);
		const content = typeof args?.content === "string" ? args.content : "";
		if (event.type === "tool_execution_start" && args?.path === "xd://workflow_control" && content.includes('"action":"list"'))
			summary.workflowStart = true;
		const result = object(event.result);
		const details = object(result?.details);
		const xdev = object(details?.xdev);
		const xdevArgs = object(xdev?.args);
		if (event.type === "tool_execution_end" && event.isError !== true && xdev?.tool === "workflow_control" && xdevArgs?.action === "list") {
			summary.workflowEnd = true;
			const resultContent = Array.isArray(result?.content) ? result.content : [];
			if (resultContent.some((item) => object(item)?.text === "[]")) summary.listResult = [];
		}
	}
	return summary;
}

const GENERATED_ACCEPTANCE_SOURCE = `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({
 name: "acceptance-generated",
 version: 1,
 args: { type: "object", properties: {}, additionalProperties: false },
 limits: { maxConcurrency: 1, maxAgents: 4, maxOutputTokens: 12000, maxRuntimeMs: 180000 },
 async run({ agent, phase }) {
  phase("Collect");
  const collected = await agent("Return the number 2.", { id: "collect", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "number" }, schemaMode: "strict" });
  phase("Synthesize");
  const summary = await agent("Return a short sentence confirming the collected value is 2.", { id: "synthesize", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "string" }, schemaMode: "strict", input: { collected } });
  return { collected, summary };
 }
});`;

export function promptFor(scenario: Scenario): string {
	const requirements: Record<Scenario, string> = {
		"generate-inspect-approve-run":
			`Stage exactly the program below with workflow_stage using empty args and project scope; do not rewrite it. Wait for interactive approval of the exact displayed hash, report the saved workflow name and hash, then stop. Do not read a skill for workflow_control.\n\n${GENERATED_ACCEPTANCE_SOURCE}`,
		"parallel-scheduling":
			"Start the approved workflow `parallel-scheduling` through workflow_control; prove independent nodes concurrently, dependent nodes wait, stay within configured concurrency, and preserve deterministic result ordering.",
		"structured-failure":
			"Start the approved workflow `structured-failure` through workflow_control; make one recoverable child fail, preserve successful siblings, and report the typed failure and partial results.",
		"pause-resume":
			"Start the approved workflow `pause-resume` through workflow_control, immediately inspect and pause it while active, prove no new dispatches occur while paused, then resume and poll until completed without rerunning accepted calls.",
		"process-recovery":
			"Start the approved workflow `process-recovery` through workflow_control, persist a dispatch boundary, recover after process termination, and prove reconciliation or visible unknown state without duplicate side effects.",
		"approval-invalidation":
			"The version-1 `approval-invalidation` workflow is approved. Edit its saved source to version 2, then try to start it with the old approval and prove the new approval prompt is refused before any child dispatch. Explicitly report that source, args, toolset, model, thinking, isolation, and plugin version are approval-tuple dimensions.",
		"model-facing-control":
			"Start the approved workflow `model-facing-control` through workflow_control; inspect list and status, then invoke only valid pause, resume, stop, and retry transitions through structured control and report the observed terminal state.",
		isolation:
			'Write {"action":"start","workflow":"isolation","args":{},"scope":"project"} to xd://workflow_control. From the returned run id, write {"action":"status","runId":"<returned-id>"} to xd://workflow_control until terminal. Report the capture-only patch/artifact and unavailableIsolationRejected result. Use the exact workflow name "isolation", never the approval id "isolation:1".',
		"session-continuity":
			"Start the approved workflow `session-continuity`, wait for completion, and record its run id. Verify node states and completed outputs remain inspectable after /new, extension reload, and process restart.",
	};
	return `Perform the ${requirements[scenario]} Use production workflow tools; do not claim success without structured evidence.`;
}

/**
 * Exact confirm policy per scenario. The default approves the displayed preview;
 * approval-invalidation approves the first (baseline) preview and refuses every
 * subsequent one, so both extension_ui_response arms are exercised live.
 */
export function uiPolicyFor(scenario: Scenario): (request: ConfirmRequest) => boolean {
	if (scenario === "approval-invalidation") {
		let seen = 0;
		return () => {
			seen += 1;
			return seen === 1;
		};
	}
	return () => true;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd });
	return result.stdout.trim();
}

async function fixture(scratchRoot: string): Promise<string> {
	await mkdir(scratchRoot, { recursive: true });
	const dir = await mkdtemp(join(scratchRoot, "omp-luna-acceptance-"));
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "acceptance@example.invalid"]);
	await git(dir, ["config", "user.name", "Luna Acceptance"]);
	await writeFile(join(dir, "README.txt"), "fresh acceptance fixture\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-qm", "fixture"]);
	return dir;
}

/**
 * Seed an isolated agent dir with only auth/model/config state. Automatic
 * extension discovery roots (agent extensions, plugins, MCP, skills) stay
 * empty, and the child runs with HOME pointed at an empty directory so
 * plugin discovery under ~/.omp/plugins finds nothing. `--no-extensions`
 * is deliberately NOT used: on omp 17.x it drops explicit `-e` paths too,
 * which would unload the extension under test (verified empirically).
 */
const ONE_SHOT_SCENARIOS = new Set<Scenario>(["parallel-scheduling", "structured-failure", "isolation"]);

function controlWorkflowSource(name: Scenario, callCount: number): string {
	return `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({ name: "${name}", version: 1, args: { type: "object", properties: {}, additionalProperties: false }, limits: { maxConcurrency: 1, maxAgents: 8, maxOutputTokens: 24000, maxRuntimeMs: 240000 }, async run({ agent, phase }) {
 phase("Execute controlled calls");
 const outputs = [];
 for (let i = 1; i <= ${callCount}; i++) {
  outputs.push(await agent("Return the number " + i, { id: "step:" + i, agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "number" }, schemaMode: "strict" }));
 }
 return { outputs };
} });`;
}

const deterministicSources: Record<string, string> = {
	"parallel-scheduling": `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({ name: "parallel-scheduling", version: 1, args: { type: "object", properties: {}, additionalProperties: false }, limits: { maxConcurrency: 2, maxAgents: 8, maxOutputTokens: 20000, maxRuntimeMs: 120000 }, async run({ agent, parallel }) {
 const values = await parallel([1, 2].map((i) => () => agent("Return the number " + i, { id: "independent:" + i, agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "number" }, schemaMode: "strict" })), false);
 const dependent = await agent("Summarize " + JSON.stringify(values), { id: "dependent", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "string" }, schemaMode: "strict" });
 return { values, dependent };
} });`,
	"structured-failure": `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({ name: "structured-failure", version: 1, args: { type: "object", properties: {}, additionalProperties: false }, limits: { maxConcurrency: 2, maxAgents: 8, maxOutputTokens: 20000, maxRuntimeMs: 120000 }, async run({ agent, parallel }) {
 const results = await parallel([() => agent("Return 7", { id: "success", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "number" }, schemaMode: "strict" }), () => agent("Return any output", { id: "strict-failure", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "none" }, apply: false, schema: { type: "not-a-real-json-schema-type" }, schemaMode: "strict" })], false);
 return { results };
} });`,
	isolation: `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({ name: "isolation", version: 1, args: { type: "object", properties: {}, additionalProperties: false }, limits: { maxConcurrency: 1, maxAgents: 4, maxOutputTokens: 12000, maxRuntimeMs: 120000 }, async run({ agent }) {
 const captured = await agent("Inspect the fixture, create a real change in the isolated workspace, and return an inspectable patch/artifact; do not modify the parent workspace.", { id: "capture-only", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-write"], isolation: { mode: "worktree" }, apply: false, schema: { type: "object" }, schemaMode: "strict" });
 let unavailableIsolationRejected = false;
 try {
  await agent("This call must not execute because its required worktree is unavailable.", { id: "unavailable-isolation", agent: "typecheck", model: "${MODEL}", effort: "low", toolset: ["repo-read"], isolation: { mode: "required" }, worktree: "./.omp/intentionally-missing-worktree", apply: false, schema: { type: "string" }, schemaMode: "strict" });
 } catch {
  unavailableIsolationRejected = true;
 }
 return { captured, unavailableIsolationRejected };
} });`,
	"pause-resume": controlWorkflowSource("pause-resume", 3),
	"process-recovery": controlWorkflowSource("process-recovery", 1),
	"approval-invalidation": controlWorkflowSource("approval-invalidation", 1),
	"model-facing-control": controlWorkflowSource("model-facing-control", 4),
	"session-continuity": controlWorkflowSource("session-continuity", 1),
};

async function prepareScenarioFixture(fixtureDir: string, scenario: Scenario, packageRoot: string): Promise<void> {
	const source = deterministicSources[scenario];
	if (!source) return;
	const workflows = join(fixtureDir, ".omp", "workflows");
	await mkdir(workflows, { recursive: true });
	await writeFile(join(workflows, `${scenario}.ts`), source);
	const packageLink = join(fixtureDir, "node_modules", "@ramarivera", "omp-workflows");
	await mkdir(join(fixtureDir, "node_modules", "@ramarivera"), { recursive: true });
	await symlink(packageRoot, packageLink, "dir");
}

async function waitForWorkflowMessage(
	client: RawRpcClient,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const response = await client.send(
			{ type: "get_messages" },
			Math.min(timeoutMs, 10_000),
		);
		const data = object(response.data);
		const messages = Array.isArray(data?.messages) ? data.messages : [];
		const message = messages
			.map(object)
			.find(
				(entry) =>
					entry?.customType === "workflow_result" ||
					entry?.customType === "workflow_error",
			);
		if (message) return message;
		const { promise, resolve: resume } = Promise.withResolvers<void>();
		setTimeout(resume, 100);
		await promise;
	}
	throw new Error("timed out waiting for workflow command result");
}

async function preapproveOneShot(
	scenario: Scenario,
	fixtureDir: string,
	profileName: string,
	sessionDir: string,
	extensionPath: string,
	homeDir: string,
	omp: string,
): Promise<SetupEvidence> {
	const client = new RawRpcClient({
		command: omp,
		args: ["--model", MODEL, "--thinking", THINKING, "--profile", profileName, "--cwd", fixtureDir, "--session-dir", sessionDir, "--mode", "rpc"],
		cwd: fixtureDir,
		env: { ...process.env, HOME: homeDir, OMP_PROFILE: profileName, PI_NOTIFICATIONS: "off" },
		uiPolicy: () => true,
		timeoutMs: SCENARIO_TIMEOUT_MS,
	});
	client.start();
	await initializeClient(client);
	const response = await client.prompt(`/workflow approve ${scenario} --args '{}'`);
	const customMessage = await waitForWorkflowMessage(client, READY_TIMEOUT_MS);
	const approval = client.uiRequests.find((request) =>
		extractHashFromApprovalMessage(request.message),
	);
	const approvalFile = join(fixtureDir, ".omp", "workflow-approvals.json");
	const approvalPersisted = await stat(approvalFile)
		.then(() => true)
		.catch(() => false);
	if (
		response.success === false ||
		!approval ||
		!approval.message ||
		customMessage.customType !== "workflow_result" ||
		!approvalPersisted
	)
		throw new Error(
			`setup diagnostics missing for ${scenario}: result=${String(customMessage.customType)}, content=${JSON.stringify(customMessage.content)}, uiRequests=${client.uiRequests.length}, approvalHash=${String(extractHashFromApprovalMessage(approval?.message))}, persisted=${String(approvalPersisted)}`,
		);
	await client.terminate();
	const runRoot = join(fixtureDir, ".omp", "workflow-runs");
	if ((await readdir(runRoot).catch(() => [])).length > 0)
		throw new Error(`setup left lingering workflow run for ${scenario}`);
	return { transcript: client.transcript, uiRequests: client.uiRequests, frames: client.frames };
}

async function seedProfile(homeDir: string, profileName: string): Promise<string> {
	const dir = join(homeDir, ".omp", "profiles", profileName, "agent");
	await mkdir(dir, { recursive: true });
	const source =
		process.env.OMP_LUNA_ACCEPTANCE_SEED_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".omp", "agent");
	for (const name of AGENT_SEED_FILES) {
		try {
			await copyFile(join(source, name), join(dir, name));
		} catch {
			// Seed files are best-effort; missing ones simply stay absent.
		}
	}
	return dir;
}

function launchClient(options: {
	omp: string;
	extensionPath: string;
	fixtureDir: string;
	profileName: string;
	sessionDir: string;
	homeDir: string;
	scenario: Scenario;
}): RawRpcClient {
	const command = commandForScenario(
		options.scenario,
		options.fixtureDir,
		options.profileName,
		options.sessionDir,
		options.extensionPath,
	);
	const args = command.slice(1, -1).filter((arg) => arg !== "-p" && arg !== "json");
	return new RawRpcClient({
		command: options.omp,
		args,
		cwd: options.fixtureDir,
		env: {
			...process.env,
			HOME: options.homeDir,
			OMP_PROFILE: options.profileName,
			PI_NOTIFICATIONS: "off",
		},
		uiPolicy: uiPolicyFor(options.scenario),
		timeoutMs: SCENARIO_TIMEOUT_MS,
	});
}

type ClientInit = {
	extensionRegistered: boolean;
	modelThinkingPinned: boolean;
	sessionId: string | undefined;
};

async function initializeClient(client: RawRpcClient): Promise<ClientInit> {
	await client.waitForReady(READY_TIMEOUT_MS);
	await client.send({ type: "negotiate_protocol", protocolVersion: 2 });
	await client.send({ type: "set_subagent_subscription", level: "events" });
	const commands = await client.send({ type: "get_available_commands" });
	const state = await client.send({ type: "get_state" });
	const commandText = JSON.stringify(commands.data ?? commands);
	const stateData = object(state.data) ?? {};
	const stateText = JSON.stringify(stateData);
	const model = object(stateData.model);
	return {
		extensionRegistered:
			commandText.includes("workflow") &&
			["workflow_stage", "workflow_control"].every((tool) => stateText.includes(tool)),
		modelThinkingPinned:
			model?.provider === "openai-codex" &&
			model.id === "gpt-5.6-luna" &&
			stateData.thinkingLevel === THINKING,
		sessionId: typeof stateData.sessionId === "string" ? stateData.sessionId : undefined,
	};
}

async function pollJournal(
	fixtureDir: string,
	predicate: (entries: Record<string, unknown>[]) => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const entries: Record<string, unknown>[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const name of await readdir(dir).catch(() => [] as string[])) {
				if (name === ".git") continue;
				const path = join(dir, name);
				const info = await stat(path).catch(() => undefined);
				if (!info) continue;
				if (info.isDirectory()) await walk(path);
				else if (name.endsWith("journal.jsonl"))
					entries.push(
						...parseJsonl(
							(await readFile(path, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean),
						),
					);
			}
		};
		await walk(fixtureDir);
		if (predicate(entries)) return true;
		const { promise, resolve: resume } = Promise.withResolvers<void>();
		setTimeout(resume, 250);
		await promise;
	}
	return false;
}

function subagentHandles(frames: RpcFrame[]): string[] {
	const handles = new Set<string>();
	for (const frame of frames) {
		if (typeof frame.type !== "string" || !frame.type.startsWith("subagent_")) continue;
		if (typeof frame.subagentId === "string") handles.add(frame.subagentId);
		else if (typeof frame.id === "string") handles.add(frame.id);
	}
	return [...handles];
}

function outboundConfirmed(transcript: TranscriptEntry[], confirmed: boolean): boolean {
	return transcript.some(
		(entry) =>
			entry.direction === "out" &&
			entry.raw.includes('"type":"extension_ui_response"') &&
			entry.raw.includes(`"confirmed":${confirmed}`),
	);
}

type SpawnedClient = { client: RawRpcClient; init: ClientInit };
type ScenarioOutcome = {
	restarts: SpawnedClient[];
	killExit: { code: number | null; signal: NodeJS.Signals | null } | null;
};

async function driveScenario(
	scenario: Scenario,
	client: RawRpcClient,
	fixtureDir: string,
	restart: () => Promise<SpawnedClient>,
): Promise<ScenarioOutcome> {
	const preapproved = new Set<Scenario>([
		"pause-resume",
		"process-recovery",
		"approval-invalidation",
		"model-facing-control",
		"session-continuity",
	]);
	if (preapproved.has(scenario)) {
		await client.prompt(`/workflow approve ${scenario} --args '{}'`);
		const approval = await waitForWorkflowMessage(client, READY_TIMEOUT_MS);
		if (approval.customType !== "workflow_result") throw new Error(`failed to approve ${scenario}`);
	}
	if (scenario === "generate-inspect-approve-run") {
		await client.prompt(promptFor(scenario));
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		await client.prompt(
			'Write {"action":"start","workflow":"acceptance-generated","args":{},"scope":"project"} to xd://workflow_control. From the returned run id, write {"action":"status","runId":"<returned-id>"} to xd://workflow_control until status is terminal, then inspect and report its durable outputs and artifacts.',
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		return { restarts: [], killExit: null };
	}
	if (scenario === "pause-resume") {
		await client.prompt(
			'Phase one: write {"action":"start","workflow":"pause-resume","args":{},"scope":"project"} to xd://workflow_control, then immediately write {"action":"pause","runId":"<returned-id>"} to xd://workflow_control. Do not inspect status, resume, or issue any other workflow action after the pause; report the run id and stop.',
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		const paused = await pollJournal(
			fixtureDir,
			(entries) => entries.some((entry) => entry.type === "paused"),
			DISPATCH_TIMEOUT_MS,
		);
		if (!paused) throw new Error("pause boundary was not journaled before the resume phase");
		await client.prompt(
			'Phase two: write {"action":"list"} to xd://workflow_control, select the existing paused pause-resume run, then write {"action":"resume","runId":"<listed-id>"} to xd://workflow_control. Poll status until terminal and report completion without starting a new run.',
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		return { restarts: [], killExit: null };
	}
	if (scenario === "approval-invalidation") {
		await client.prompt(
			'Phase one: write {"action":"start","workflow":"approval-invalidation","args":{},"scope":"project"} to xd://workflow_control. From the returned run id, write {"action":"status","runId":"<returned-id>"} to xd://workflow_control until status is terminal. Do not edit the workflow source.',
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		await client.prompt(promptFor(scenario));
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		return { restarts: [], killExit: null };
	}
	if (scenario === "process-recovery") {
		await client.prompt(
			`${promptFor(scenario)} Phase one: start the workflow, wait until at least one node dispatch is durably journaled, then stop issuing new work and report the run id.`,
		);
		const dispatched = await pollJournal(
			fixtureDir,
			(entries) => entries.some((entry) => entry.type === "call.dispatched"),
			DISPATCH_TIMEOUT_MS,
		);
		if (!dispatched) throw new Error("dispatch boundary was not journaled before the kill deadline");
		const killExit = await client.hardKill();
		const phase = await restart();
		await phase.client.prompt(
			'The previous process was killed after a dispatch boundary. Write {"action":"list"} to xd://workflow_control, select the existing process-recovery run, then write {"action":"status","runId":"<listed-id>"} to xd://workflow_control. If it is paused, write {"action":"resume","runId":"<listed-id>"} and poll status until terminal. Never start a new workflow run. Report reconciliation or visible unknown state and the attempt count.',
		);
		await phase.client.waitForIdle(SCENARIO_TIMEOUT_MS);
		return { restarts: [phase], killExit };
	}
	if (scenario === "session-continuity") {
		await client.prompt(
			`${promptFor(scenario)} Phase one: complete a workflow run and record its run id.`,
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		await client.send({ type: "new_session" });
		await client.prompt(
			'Phase two after /new: write {"action":"list"} to xd://workflow_control, take the completed session-continuity run id, then write {"action":"status","runId":"<listed-id>"} to xd://workflow_control. Report persisted node states and outputs. Use no filesystem, process, skill, or shell tools.',
		);
		await client.waitForIdle(SCENARIO_TIMEOUT_MS);
		// Full process boundary: the first process exits cleanly before the restart inspects.
		const firstExit = await client.terminate();
		if (firstExit.code !== 0) throw new Error(`initial continuity phase exited ${firstExit.code ?? firstExit.signal ?? "unknown"}`);
		const phase = await restart();
		await phase.client.prompt(
			'Phase three after a full process restart: write {"action":"list"} to xd://workflow_control, take the completed session-continuity run id, then write {"action":"status","runId":"<listed-id>"} to xd://workflow_control. Report the persisted node states and outputs. Use no filesystem, process, skill, or shell tools.',
		);
		await phase.client.waitForIdle(SCENARIO_TIMEOUT_MS);
		return { restarts: [phase], killExit: null };
	}
	await client.prompt(promptFor(scenario));
	await client.waitForIdle(SCENARIO_TIMEOUT_MS);
	return { restarts: [], killExit: null };
}

const defaultOneShotRunner = async (input: {
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}): Promise<OneShotResult> => {
	try {
		const result = await exec(input.command[0], input.command.slice(1), {
			cwd: input.cwd,
			env: input.env,
			maxBuffer: 50 * 1024 * 1024,
		});
		return { exit: { code: 0, signal: null }, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
		return {
			exit: { code: typeof failure.code === "number" ? failure.code : null, signal: failure.signal ?? null },
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
};

async function runOneShotCase(
	scenario: Scenario,
	iteration: number,
	input: {
		command: string[];
		installationCommand: string[];
		prompt: string;
		fixtureDir: string;
		homeDir: string;
		runner: NonNullable<HarnessOptions["oneShotRunner"]>;
		waitForTerminal: boolean;
		setup?: SetupEvidence;
	},
): Promise<RunResult> {
	const env = { ...process.env, HOME: input.homeDir, OMP_PROFILE: input.command[input.command.indexOf("--profile") + 1], PI_NOTIFICATIONS: "off" };
	const result = await input.runner({ command: input.command, cwd: input.fixtureDir, env });
	const terminalObserved = input.waitForTerminal
		? await pollJournal(
				input.fixtureDir,
				(entries) => entries.some((entry) => ["completed", "failed", "cancelled"].includes(String(entry.type))),
				READY_TIMEOUT_MS,
			)
		: true;
	const stdoutLines = result.stdout.split(/\r?\n/).filter(Boolean);
	const stderrLines = result.stderr.split(/\r?\n/).filter(Boolean);
	const transcript = compactTranscript([
		...(input.setup?.transcript ?? []),
		...stdoutLines.map((raw): TranscriptEntry => ({ direction: "in", stream: "stdout", at: new Date().toISOString(), raw })),
		...stderrLines.map((raw): TranscriptEntry => ({ direction: "in", stream: "stderr", at: new Date().toISOString(), raw })),
	]);
	const frames = [...(input.setup?.frames ?? []), ...parseJsonl(stdoutLines)];
	const collected = await collectScenarioEvidence({ scenario, fixtureDir: input.fixtureDir, transcript, frames, uiRequests: input.setup?.uiRequests ?? [], gitDiff: await git(input.fixtureDir, ["diff", "HEAD"]).catch(() => ""), gitHead: await git(input.fixtureDir, ["rev-parse", "HEAD"]).catch(() => "") });
	const assertions: AssertionMap = { ...assertScenario(collected), oneShotTransport: input.command.includes("-p") && input.command.includes("--mode") && input.command.includes("json"), terminalObserved, modelThinkingPinned: result.stdout.includes(MODEL) || result.stderr.includes(MODEL), agentHandleObserved: frames.some((frame) => typeof frame.sessionId === "string" || typeof frame.id === "string"), noExtensionErrorFrames: !frames.some((frame) => frame.type === "extension_error"), cleanExit: result.exit.code === 0 };
	const passed = Object.values(assertions).every(Boolean);
	return { scenario, iteration, verdict: passed ? "pass" : result.exit.code === null ? "inconclusive" : "fail", nextAction: passed ? "keep" : "block release", evidence: { command: input.command, installationCommand: input.installationCommand, prompt: input.prompt, exit: result.exit.code, stdout: result.stdout, stderr: result.stderr, transcript: transcript.map((entry) => entry.raw), gitDiff: collected.gitDiff, journal: collected.journals, artifacts: collected.files.map((file) => file.relativePath), agentHandles: frames.flatMap((frame) => [frame.sessionId, frame.id].filter((value): value is string => typeof value === "string")), usage: collected.usage ?? {}, assertions } };
}

export async function runAcceptanceCase(
	scenario: Scenario,
	iteration: number,
	options: HarnessOptions = {},
): Promise<RunResult> {
	const scratchRoot = options.scratchRoot ?? SCRATCH_ROOT;
	const omp = options.omp ?? process.env.OMP_BIN ?? "omp";
	const extensionPath = resolve(options.extension ?? process.env.OMP_WORKFLOWS_EXTENSION ?? "dist/extension.js");
	const packageRoot = resolve(options.packageRoot ?? ".");
	const fixtureDir = await fixture(scratchRoot);
	const homeDir = await mkdtemp(join(scratchRoot, "omp-luna-home-"));
	const profileName = `luna-${scenario}-${iteration}`;
	await seedProfile(homeDir, profileName);
	const sessionDir = await mkdtemp(join(scratchRoot, `omp-luna-session-${scenario}-${iteration}-`));
	const installationCommand = pluginLinkCommand(packageRoot, omp);
	const installationEnv = { ...process.env, HOME: homeDir, OMP_PROFILE: profileName };
	if (options.pluginLinkRunner) await options.pluginLinkRunner({ command: installationCommand, env: installationEnv, cwd: fixtureDir });
	else await exec(installationCommand[0], installationCommand.slice(1), { cwd: fixtureDir, env: installationEnv });
	await prepareScenarioFixture(fixtureDir, scenario, packageRoot);
	const prompt = promptFor(scenario);
	if (!RPC_SCENARIOS.has(scenario)) {
		const setupRunner = options.setupRunner ?? (async (input: { scenario: Scenario; fixtureDir: string; profileName: string; sessionDir: string; extensionPath: string; homeDir: string; omp: string }) =>
			preapproveOneShot(input.scenario, input.fixtureDir, input.profileName, input.sessionDir, input.extensionPath, input.homeDir, input.omp));
		const setup = await setupRunner({ scenario, fixtureDir, profileName, sessionDir, extensionPath, homeDir, omp });
		return runOneShotCase(scenario, iteration, {
			command: commandForScenario(scenario, fixtureDir, profileName, sessionDir, extensionPath, omp, prompt),
			installationCommand, prompt, fixtureDir, homeDir, setup: setup ?? undefined,
			runner: options.oneShotRunner ?? defaultOneShotRunner,
			waitForTerminal: options.oneShotRunner === undefined,
		});
	}
	const clients: SpawnedClient[] = [];
	let driverError: Error | undefined;
	let killExit: ScenarioOutcome["killExit"] = null;
	const spawnClient = async (): Promise<SpawnedClient> => {
		const client = launchClient({
			omp,
			extensionPath,
			fixtureDir,
			profileName,
			sessionDir,
			homeDir,
			scenario,
		});
		client.start();
		const init = await initializeClient(client);
		const entry = { client, init };
		clients.push(entry);
		return entry;
	};
	try {
		const first = await spawnClient();
		const outcome = await driveScenario(scenario, first.client, fixtureDir, spawnClient);
		killExit = outcome.killExit;
	} catch (error) {
		driverError = error instanceof Error ? error : new Error(String(error));
	}
	let statsData: unknown;
	const finalEntry = clients.at(-1);
	if (finalEntry && !driverError) {
		statsData = await finalEntry.client
			.send({ type: "get_session_stats" })
			.then((frame) => frame.data)
			.catch(() => undefined);
	}
	const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
	for (const [index, entry] of clients.entries()) {
		if (killExit && index === 0) {
			exits.push(killExit);
			continue;
		}
		exits.push(await entry.client.terminate());
	}
	const transcript = compactTranscript(clients.flatMap((entry) => entry.client.transcript));
	const frames = clients.flatMap((entry) => entry.client.frames);
	const uiRequests = clients.flatMap((entry) => entry.client.uiRequests);
	const gitDiff = await git(fixtureDir, ["diff", "HEAD"]).catch(() => "");
	const gitHead = await git(fixtureDir, ["rev-parse", "HEAD"]).catch(() => "");
	const collected: ScenarioEvidence = await collectScenarioEvidence({
		scenario,
		fixtureDir,
		transcript,
		frames,
		uiRequests,
		gitDiff,
		gitHead,
	});
	const finalExit = exits.at(-1) ?? { code: null, signal: null };
	const handles = new Set<string>();
	for (const entry of clients) if (entry.init.sessionId) handles.add(entry.init.sessionId);
	for (const handle of subagentHandles(frames)) handles.add(handle);
	const assertions: AssertionMap = {
		...assertScenario(collected),
		extensionRegistered:
			clients.length > 0 && clients.every((entry) => entry.init.extensionRegistered),
		modelThinkingPinned:
			clients.length > 0 && clients.every((entry) => entry.init.modelThinkingPinned),
		agentHandleObserved: handles.size > 0,
		noExtensionErrorFrames: !frames.some((frame) => frame.type === "extension_error"),
		cleanExit: finalExit.code === 0,
	};
	if (scenario === "generate-inspect-approve-run")
		assertions.approvalExercised = outboundConfirmed(transcript, true);
	if (scenario === "approval-invalidation") {
		assertions.approvalExercised = outboundConfirmed(transcript, true);
		assertions.refusalExercised = outboundConfirmed(transcript, false);
	}
	if (scenario === "process-recovery")
		assertions.boundaryKillObserved = killExit !== null && killExit.code !== 0;
	if (driverError) assertions.driverCompleted = false;
	const stdout = transcript
		.filter((entry) => entry.stream === "stdout")
		.map((entry) => entry.raw)
		.join("\n");
	const stderr = [
		...transcript.filter((entry) => entry.stream === "stderr").map((entry) => entry.raw),
		...(driverError ? [`[driver] ${driverError.message}`] : []),
	].join("\n");
	const evidence: Evidence = {
		command: commandForScenario(scenario, fixtureDir, profileName, sessionDir, extensionPath, omp),
		installationCommand,
		prompt,
		exit: finalExit.code,
		stdout,
		stderr,
		transcript: transcript.map((entry) => entry.raw),
		gitDiff,
		journal: collected.journals,
		artifacts: collected.files.map((file) => file.relativePath),
		agentHandles: [...handles],
		usage: collected.usage ?? statsData ?? {},
		assertions,
	};
	const allTrue = Object.values(assertions).every(Boolean);
	const verdict: Verdict = allTrue
		? "pass"
		: finalExit.code === null && killExit === null && !driverError
			? "inconclusive"
			: "fail";
	return {
		scenario,
		iteration,
		verdict,
		evidence,
		nextAction: verdict === "pass" ? "keep" : "block release",
	};
}

export async function hashFile(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function buildArtifact(
	runs: RunResult[],
	meta: {
		ompVersion: string;
		extensionPath: string;
		extensionSha256: string;
		gitCommit: string | null;
		gitTag: string | null;
		roundsRequested: number;
		roundsCompleted: number;
	},
): AcceptanceArtifact {
	return {
		schemaVersion: 2,
		harness: HARNESS_ID,
		synthetic: false,
		model: MODEL,
		thinking: THINKING,
		packageVersion: PLUGIN_VERSION,
		ompVersion: meta.ompVersion,
		extension: meta.extensionPath,
		extensionSha256: meta.extensionSha256,
		gitCommit: meta.gitCommit,
		gitTag: meta.gitTag,
		generatedAt: new Date().toISOString(),
		roundsRequested: meta.roundsRequested,
		roundsCompleted: meta.roundsCompleted,
		allPassed: runs.every((run) => run.verdict === "pass"),
		scenarios: SCENARIOS,
		runs,
	};
}

function parseCli(argv: string[]): {
	rounds: number;
	artifactPath: string;
	omp?: string;
	extension?: string;
	scenarios?: Scenario[];
	list: boolean;
} {
	const parsed = {
		rounds: RUNS_PER_SCENARIO,
		artifactPath:
			process.env.OMP_LUNA_ACCEPTANCE_ARTIFACT ??
			join(process.cwd(), ".artifacts", "luna-acceptance.json"),
		omp: undefined as string | undefined,
		extension: undefined as string | undefined,
		scenarios: undefined as Scenario[] | undefined,
		list: false,
	};
	for (const arg of argv) {
		if (arg === "--list-scenarios") {
			parsed.list = true;
		} else if (arg.startsWith("--rounds=")) {
			parsed.rounds = Number(arg.slice("--rounds=".length));
			if (!Number.isInteger(parsed.rounds) || parsed.rounds < 1)
				throw new Error(`invalid --rounds value: ${arg}`);
		} else if (arg.startsWith("--artifact=")) {
			parsed.artifactPath = arg.slice("--artifact=".length);
		} else if (arg.startsWith("--omp=")) {
			parsed.omp = arg.slice("--omp=".length);
		} else if (arg.startsWith("--extension=")) {
			parsed.extension = arg.slice("--extension=".length);
		} else if (arg.startsWith("--scenario=")) {
			const name = arg.slice("--scenario=".length) as Scenario;
			if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario: ${name}`);
			parsed.scenarios = [...(parsed.scenarios ?? []), name];
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return parsed;
}

export async function main(): Promise<void> {
	const cli = parseCli(process.argv.slice(2));
	if (cli.list) {
		console.log(SCENARIOS.join("\n"));
		return;
	}
	if (process.env.OMP_LUNA_ACCEPTANCE_LIVE !== "1")
		throw new Error(
			"Luna acceptance is live-only; set OMP_LUNA_ACCEPTANCE_LIVE=1 (release gate must opt in explicitly)",
		);
	const omp = cli.omp ?? process.env.OMP_BIN ?? "omp";
	const extensionPath = resolve(
		cli.extension ?? process.env.OMP_WORKFLOWS_EXTENSION ?? "dist/extension.js",
	);
	const ompVersion = (await exec(omp, ["--version"])).stdout.trim();
	const extensionSha256 = await hashFile(extensionPath);
	const scenarios = cli.scenarios ?? SCENARIOS;
	const runs: RunResult[] = [];
	const artifactMeta = {
		ompVersion,
		extensionPath,
		extensionSha256,
		gitCommit:
			process.env.GITHUB_SHA ??
			(await git(process.cwd(), ["rev-parse", "HEAD"]).catch(() => null)),
		gitTag:
			process.env.OMP_LUNA_ACCEPTANCE_GIT_TAG ??
			(process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined) ??
			(await git(process.cwd(), ["describe", "--tags", "--exact-match"]).catch(() => null)),
		roundsRequested: cli.rounds,
	};
	await mkdir(dirname(cli.artifactPath), { recursive: true });
	for (const scenario of scenarios) {
		for (let iteration = 1; iteration <= cli.rounds; iteration++) {
			const run = await runAcceptanceCase(scenario, iteration, {
				omp,
				extension: extensionPath,
			});
			runs.push(run);
			console.log(`${scenario}#${iteration}: ${run.verdict}`);
			const roundsCompleted = Math.min(
				...scenarios.map(
					(name) =>
						new Set(
							runs.filter((candidate) => candidate.scenario === name).map((candidate) => candidate.iteration),
						).size,
				),
			);
			const checkpoint = buildArtifact(runs, { ...artifactMeta, roundsCompleted });
			await writeFile(cli.artifactPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
		}
	}
	const artifact = buildArtifact(runs, {
		...artifactMeta,
		roundsCompleted: cli.rounds,
	});
	await writeFile(cli.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log(`Wrote Luna acceptance artifact: ${cli.artifactPath}`);
	if (!artifact.allPassed)
		throw new Error("Luna acceptance gate failed: every scenario must pass three consecutive runs");
}

if (import.meta.main) await main();
