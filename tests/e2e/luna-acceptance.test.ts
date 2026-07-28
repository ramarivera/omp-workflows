import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	buildArtifact,
	compactTranscript,
	hashFile,
	MODEL,
	parseAcceptanceEvents,
	promptFor,
	type RunResult,
	runAcceptanceCase,
	SCENARIOS,
	THINKING,
	uiPolicyFor,
} from "../../scripts/run-luna-acceptance.js";
import {
	EXPECTED_MODEL,
	EXPECTED_SCENARIOS,
	EXPECTED_THINKING,
	RUNS_PER_SCENARIO,
	verifyLunaAcceptanceArtifact,
} from "../../scripts/verify-luna-acceptance.js";
import { PLUGIN_VERSION } from "../../src/version.js";

function syntheticRun(
	scenario: (typeof SCENARIOS)[number],
	iteration: number,
): RunResult {
	return {
		scenario,
		iteration,
		verdict: "pass",
		nextAction: "keep",
		evidence: {
			command: ["omp", "--mode", "rpc"],
			installationCommand: ["omp", "plugin", "link", "/package"],
			prompt: promptFor(scenario),
			exit: 0,
			stdout: '{"type":"ready"}',
			stderr: "",
			transcript: ['{"type":"ready"}'],
			gitDiff: "",
			journal: [],
			artifacts: [],
			agentHandles: ["session-synthetic"],
			usage: {},
			assertions: { contract: true },
		},
	};
}

function syntheticArtifact(runs: RunResult[], extensionSha256: string) {
	return buildArtifact(runs, {
		ompVersion: "omp/17.1.6",
		extensionPath: resolve("dist/extension.js"),
		extensionSha256,
		gitCommit: "0".repeat(40),
		gitTag: null,
		roundsRequested: RUNS_PER_SCENARIO,
		roundsCompleted: RUNS_PER_SCENARIO,
	});
}

describe("Luna acceptance contract", () => {
	test("parses provider, xdev execution, empty list result, and ignores non-NDJSON", () => {
		const summary = parseAcceptanceEvents([
			"not json",
			JSON.stringify({
				type: "message_start",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-5.6-luna",
				},
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "write",
				args: {
					path: "xd://workflow_control",
					content: '{"action":"list"}',
				},
			}),
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "write",
				result: {
					content: [{ type: "text", text: "[]" }],
					details: {
						xdev: {
							tool: "workflow_control",
							mode: "execute",
							args: { action: "list" },
						},
					},
				},
				isError: false,
			}),
		]);
		expect(summary.provider).toBe("openai-codex");
		expect(summary.model).toBe("gpt-5.6-luna");
		expect(summary.workflowStart).toBe(true);
		expect(summary.workflowEnd).toBe(true);
		expect(summary.listResult).toEqual([]);
	});
	test("artifact transcript drops routine state polls and bounds oversized frames", () => {
		const compacted = compactTranscript([
			{
				direction: "out",
				stream: "stdin",
				at: "now",
				raw: "poll",
				frame: { id: "state", type: "get_state" },
			},
			{
				direction: "in",
				stream: "stdout",
				at: "now",
				raw: "state",
				frame: { id: "state", type: "response", command: "get_state" },
			},
			{
				direction: "in",
				stream: "stdout",
				at: "now",
				raw: "delta",
				frame: { type: "message_update" },
			},
			{
				direction: "in",
				stream: "stdout",
				at: "now",
				raw: "kept",
				frame: { type: "message_end" },
			},
			{ direction: "in", stream: "stderr", at: "now", raw: "x".repeat(70_000) },
		]);
		expect(compacted).toHaveLength(2);
		expect(compacted[0]?.raw).toBe("kept");
		expect(compacted[1]?.raw).toContain("chars omitted");
		expect(compacted[1]?.raw.length).toBeLessThan(70_000);
	});

	test("harness scenarios, model, and thinking exactly match the verifier contract", () => {
		expect([...SCENARIOS]).toEqual([...EXPECTED_SCENARIOS]);
		expect(SCENARIOS).toHaveLength(9);
		expect(MODEL).toBe(EXPECTED_MODEL);
		expect(THINKING).toBe(EXPECTED_THINKING);
	});

	test("every scenario has a nonempty production prompt", () => {
		for (const scenario of SCENARIOS) {
			const prompt = promptFor(scenario);
			expect(prompt.length).toBeGreaterThan(40);
			expect(prompt).toContain("structured evidence");
		}
	});

	test("confirm policy approves by default and refuses after the baseline for approval-invalidation", () => {
		const approve = uiPolicyFor("generate-inspect-approve-run");
		expect(approve({ id: "a", method: "confirm" })).toBe(true);
		expect(approve({ id: "b", method: "confirm" })).toBe(true);
		const invalidation = uiPolicyFor("approval-invalidation");
		expect(invalidation({ id: "a", method: "confirm" })).toBe(true);
		expect(invalidation({ id: "b", method: "confirm" })).toBe(false);
		expect(invalidation({ id: "c", method: "confirm" })).toBe(false);
	});

	test("schema v2 artifact with 27 passing runs satisfies the release verifier", async () => {
		const extensionSha256 = await hashFile(resolve("dist/extension.js"));
		const runs = SCENARIOS.flatMap((scenario) =>
			[1, 2, 3].map((iteration) => syntheticRun(scenario, iteration)),
		);
		const artifact = syntheticArtifact(runs, extensionSha256);
		expect(artifact.schemaVersion).toBe(2);
		expect(artifact.harness).toBe("omp-rpc-live");
		expect(artifact.synthetic).toBe(false);
		expect(artifact.allPassed).toBe(true);
		expect(artifact.packageVersion).toBe(PLUGIN_VERSION);
		await verifyLunaAcceptanceArtifact(artifact, {
			extensionPath: resolve("dist/extension.js"),
		});
	});
	test("verifier binds artifacts to the release commit and tag", async () => {
		const extensionSha256 = await hashFile(resolve("dist/extension.js"));
		const runs = SCENARIOS.flatMap((scenario) =>
			[1, 2, 3].map((iteration) => syntheticRun(scenario, iteration)),
		);
		const artifact = {
			...syntheticArtifact(runs, extensionSha256),
			gitTag: "v0.1.1",
		};
		await verifyLunaAcceptanceArtifact(artifact, {
			extensionPath: resolve("dist/extension.js"),
			expectedGitCommit: "0".repeat(40),
			expectedGitTag: "v0.1.1",
		});
		await expect(
			verifyLunaAcceptanceArtifact(artifact, {
				extensionPath: resolve("dist/extension.js"),
				expectedGitCommit: "1".repeat(40),
				expectedGitTag: "v0.1.2",
			}),
		).rejects.toThrow(/gitCommit.*gitTag/s);
	});

	test("verifier rejects artifacts missing any of the 27 runs", async () => {
		const extensionSha256 = await hashFile(resolve("dist/extension.js"));
		const runs = SCENARIOS.flatMap((scenario) =>
			[1, 2, 3].map((iteration) => syntheticRun(scenario, iteration)),
		).slice(1);
		const artifact = syntheticArtifact(runs, extensionSha256);
		await expect(
			verifyLunaAcceptanceArtifact(artifact, {
				extensionPath: resolve("dist/extension.js"),
			}),
		).rejects.toThrow(/27 scenario runs/);
	});

	test("verifier rejects artifacts whose assertions are not all true", async () => {
		const extensionSha256 = await hashFile(resolve("dist/extension.js"));
		const runs = SCENARIOS.flatMap((scenario) =>
			[1, 2, 3].map((iteration) => syntheticRun(scenario, iteration)),
		);
		runs[0] = {
			...runs[0],
			evidence: {
				...runs[0].evidence,
				assertions: { contract: true, cleanExit: false },
			},
		};
		const artifact = syntheticArtifact(runs, extensionSha256);
		await expect(
			verifyLunaAcceptanceArtifact(artifact, {
				extensionPath: resolve("dist/extension.js"),
			}),
		).rejects.toThrow(/assertions must all be true/);
	});
	test("runAcceptanceCase links the package into the isolated profile before one-shot evaluation", async () => {
		const packageRoot = resolve("/built/package");
		let received: string[] = [];
		let installEnv: NodeJS.ProcessEnv | undefined;
		let evaluated: string[] = [];
		const run = await runAcceptanceCase("parallel-scheduling", 1, {
			scratchRoot: await Bun.$`mktemp -d`.text().then((value) => value.trim()),
			omp: "omp-under-test",
			packageRoot,
			extension: "dist/extension.js",
			pluginLinkRunner: async ({ command, env }) => {
				received = command;
				installEnv = env;
			},
			setupRunner: async () => {},
			oneShotRunner: async ({ command }) => {
				evaluated = command;
				return {
					exit: { code: 0, signal: null },
					stdout: '{"sessionId":"test-session"}\n',
					stderr: "",
				};
			},
		});
		expect(received).toEqual(["omp-under-test", "plugin", "link", packageRoot]);
		expect(installEnv?.HOME).toBeString();
		expect(installEnv?.OMP_PROFILE).toBeString();
		expect(evaluated).not.toContain("--plugin-dir");
		expect(evaluated).not.toContain("--extension");
		expect(run.evidence.installationCommand).toEqual(received);
		expect(run.evidence.command).toEqual(evaluated);
	}, 15_000);

	test.skipIf(process.env.OMP_LUNA_ACCEPTANCE_LIVE !== "1")(
		"live smoke is opt-in",
		async () => {
			const { main } = await import("../../scripts/run-luna-acceptance.js");
			await main();
		},
	);
});
