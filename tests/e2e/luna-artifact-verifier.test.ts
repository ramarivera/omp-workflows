import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXPECTED_MODEL,
	EXPECTED_SCENARIOS,
	EXPECTED_THINKING,
	RUNS_PER_SCENARIO,
	verifyLunaAcceptanceArtifact,
} from "../../scripts/verify-luna-acceptance.js";

const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{
	artifact: Record<string, unknown>;
	extensionPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "omp-luna-verifier-"));
	cleanup.push(root);
	const extensionPath = join(root, "extension.js");
	const extension = "export default () => undefined;\n";
	await writeFile(extensionPath, extension);
	const runs = EXPECTED_SCENARIOS.flatMap((scenario) =>
		Array.from({ length: RUNS_PER_SCENARIO }, (_, index) => ({
			scenario,
			iteration: index + 1,
			verdict: "pass",
			nextAction: "keep",
			evidence: {
				command: ["omp", "--mode", "rpc"],
				installationCommand: ["omp", "plugin", "link", "/package"],
				prompt: `exercise ${scenario}`,
				exit: 0,
				stdout: '{"type":"ready"}',
				stderr: "",
				transcript: ['{"type":"ready"}'],
				gitDiff: "",
				journal: [],
				artifacts: [],
				agentHandles: [],
				usage: {},
				assertions: { contract: true },
			},
		})),
	);
	return {
		extensionPath,
		artifact: {
			schemaVersion: 2,
			harness: "omp-rpc-live",
			synthetic: false,
			ompVersion: "17.1.7",
			extensionSha256: createHash("sha256").update(extension).digest("hex"),
			model: EXPECTED_MODEL,
			thinking: EXPECTED_THINKING,
			packageVersion: "0.1.0",
			scenarios: [...EXPECTED_SCENARIOS],
			runs,
			allPassed: true,
			roundsRequested: RUNS_PER_SCENARIO,
			roundsCompleted: RUNS_PER_SCENARIO,
		},
	};
}

async function verify(artifact: unknown, extensionPath: string): Promise<void> {
	await verifyLunaAcceptanceArtifact(artifact, {
		extensionPath,
		packageVersion: "0.1.0",
	});
}

describe("Luna acceptance artifact verifier", () => {
	test("accepts exactly nine real RPC scenarios with three clean runs each", async () => {
		const { artifact, extensionPath } = await fixture();
		await expect(verify(artifact, extensionPath)).resolves.toBeUndefined();
	});

	test("rejects missing live-harness and synthetic markers", async () => {
		const { artifact, extensionPath } = await fixture();
		delete artifact.harness;
		artifact.synthetic = true;
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"harness must be omp-rpc-live",
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"synthetic must be false",
		);
	});

	test("rejects missing scenarios or duplicate iterations", async () => {
		const { artifact, extensionPath } = await fixture();
		const runs = artifact.runs as Array<Record<string, unknown>>;
		runs.pop();
		runs.push(structuredClone(runs[0]));
		await expect(verify(artifact, extensionPath)).rejects.toThrow("duplicates");
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"missing run session-continuity:3",
		);
	});

	test("rejects wrong model thinking package version and extension hash", async () => {
		const { artifact, extensionPath } = await fixture();
		artifact.model = "other";
		artifact.thinking = "high";
		artifact.packageVersion = "9.9.9";
		artifact.extensionSha256 = "0".repeat(64);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			`model must be ${EXPECTED_MODEL}`,
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			`thinking must be ${EXPECTED_THINKING}`,
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"packageVersion must match",
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"extensionSha256 must match",
		);
	});

	test("rejects inconclusive verdicts, non-keep actions, failed assertions, and nonzero exits", async () => {
		const { artifact, extensionPath } = await fixture();
		const run = (artifact.runs as Array<Record<string, unknown>>)[0];
		run.verdict = "inconclusive";
		run.nextAction = "iterate";
		const evidence = run.evidence as Record<string, unknown>;
		evidence.exit = 1;
		evidence.assertions = { contract: false };
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"nextAction must be keep",
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow("must pass");
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"exit must be 0",
		);
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"assertions must all be true",
		);
	});

	test("rejects unrecognized scenario names", async () => {
		const { artifact, extensionPath } = await fixture();
		(artifact.runs as Array<Record<string, unknown>>)[0].scenario =
			"surface-smoke";
		await expect(verify(artifact, extensionPath)).rejects.toThrow(
			"scenario is not a required scenario",
		);
	});
});
