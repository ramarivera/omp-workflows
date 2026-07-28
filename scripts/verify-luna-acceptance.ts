import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PLUGIN_VERSION } from "../src/version.js";

export const EXPECTED_MODEL = "openai-codex/gpt-5.6-luna";
export const EXPECTED_THINKING = "low";
export const EXPECTED_SCENARIOS = [
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
export const RUNS_PER_SCENARIO = 3;


type UnknownRecord = Record<string, unknown>;

export type LunaVerificationOptions = {
	artifactPath?: string;
	cwd?: string;
	extensionPath?: string;
	packageVersion?: string;
	expectedGitCommit?: string;
	expectedGitTag?: string;
};

function record(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => nonEmptyString(entry));
}

function nonEmptyStringArray(value: unknown): value is string[] {
	return stringArray(value) && value.length > 0;
}

function failure(errors: string[]): never {
	throw new Error(`Luna acceptance artifact verification failed:\n- ${errors.join("\n- ")}`);
}


function assertEvidence(evidence: unknown, label: string, errors: string[]): void {
	const value = record(evidence);
	if (!value) {
		errors.push(`${label}.evidence must be an object`);
		return;
	}
	if (!nonEmptyStringArray(value.command)) errors.push(`${label}.evidence.command must be nonempty`);
	if (!nonEmptyString(value.prompt)) errors.push(`${label}.evidence.prompt must be nonempty`);
	if (!nonEmptyStringArray(value.installationCommand)) errors.push(`${label}.evidence.installationCommand must be nonempty`);
	if (value.exit !== 0) errors.push(`${label}.evidence.exit must be 0`);
	if (!nonEmptyString(value.stdout) && !nonEmptyString(value.stderr)) {
		errors.push(`${label}.evidence must include nonempty stdout or stderr`);
	}
	if (!nonEmptyStringArray(value.transcript)) errors.push(`${label}.evidence.transcript must be nonempty`);
	if (typeof value.gitDiff !== "string") errors.push(`${label}.evidence.gitDiff must be present`);
	if (value.journal === undefined || value.journal === null) errors.push(`${label}.evidence.journal must be present`);
	if (!Array.isArray(value.artifacts)) errors.push(`${label}.evidence.artifacts must be present`);
	if (!stringArray(value.agentHandles)) errors.push(`${label}.evidence.agentHandles must be present`);
	if (value.usage === undefined || value.usage === null) errors.push(`${label}.evidence.usage must be present`);
	const assertions = record(value.assertions);
	if (!assertions || Object.keys(assertions).length === 0) {
		errors.push(`${label}.evidence.assertions must be nonempty`);
	} else if (Object.entries(assertions).some(([, assertion]) => assertion !== true)) {
		errors.push(`${label}.evidence.assertions must all be true`);
	}
}

function normalizedRuns(value: UnknownRecord): UnknownRecord[] | undefined {
	const runs = value.runs;
	if (Array.isArray(runs)) {
		return runs.flatMap((entry) => {
			const run = record(entry);
			return run ? [run] : [];
		});
	}
	const scenarios = value.scenarios;
	if (!Array.isArray(scenarios)) return undefined;
	const normalized: UnknownRecord[] = [];
	for (const entry of scenarios) {
		const scenario = record(entry);
		if (!scenario) continue;
		const iterations = scenario.iterations;
		if (Array.isArray(iterations)) {
			for (const iteration of iterations) {
				const run = record(iteration);
				if (run) normalized.push({ ...run, scenario: scenario.name ?? run.scenario });
			}
			continue;
		}
		if (Array.isArray(scenario.evidence)) {
			for (const [index, evidence] of scenario.evidence.entries()) {
				normalized.push({
					scenario: scenario.name,
					iteration: index + 1,
					verdict: scenario.passed === true ? "pass" : "fail",
					nextAction: scenario.passed === true ? "keep" : "block release",
					evidence,
				});
			}
			continue;
		}
		normalized.push({
			...scenario,
			scenario: scenario.name ?? scenario.scenario,
			verdict: scenario.verdict ?? (scenario.passed === true ? "pass" : "fail"),
			nextAction: scenario.nextAction ?? (scenario.passed === true ? "keep" : "block release"),
		});
	}
	return normalized;
}

export async function verifyLunaAcceptanceArtifact(
	artifact: unknown,
	options: LunaVerificationOptions = {},
): Promise<void> {
	const errors: string[] = [];
	const value = record(artifact);
	if (!value) failure(["artifact must be a JSON object"]);
	if (value.schemaVersion !== 2) errors.push("artifact.schemaVersion must be 2");
	if (value.harness !== "omp-rpc-live") errors.push("artifact.harness must be omp-rpc-live");
	if (value.synthetic !== false) errors.push("artifact.synthetic must be false");
	if (!nonEmptyString(value.ompVersion)) errors.push("artifact.ompVersion must be nonempty");
	if (
		!nonEmptyString(value.extensionSha256) ||
		!/^[0-9a-f]{64}$/i.test(value.extensionSha256)
	) {
		errors.push("artifact.extensionSha256 must be a nonempty SHA-256");
	}
	if (nonEmptyString(value.extensionSha256)) {
		const extensionPath = options.extensionPath ?? `${options.cwd ?? process.cwd()}/dist/extension.js`;
		try {
			const actualHash = createHash("sha256")
				.update(await readFile(extensionPath))
				.digest("hex");
			if (value.extensionSha256 !== actualHash) {
				errors.push(`artifact.extensionSha256 must match ${extensionPath}`);
			}
		} catch {
			errors.push(`artifact extension build is missing: ${extensionPath}`);
		}
	}
	if (value.model !== EXPECTED_MODEL) errors.push(`artifact.model must be ${EXPECTED_MODEL}`);
	if (value.thinking !== EXPECTED_THINKING) errors.push(`artifact.thinking must be ${EXPECTED_THINKING}`);
	if (value.packageVersion !== (options.packageVersion ?? PLUGIN_VERSION)) {
		errors.push(`artifact.packageVersion must match installed package version ${(options.packageVersion ?? PLUGIN_VERSION)}`);
	}
	const expectedGitCommit = options.expectedGitCommit;
	if (expectedGitCommit && value.gitCommit !== expectedGitCommit) {
		errors.push(`artifact.gitCommit must match ${expectedGitCommit}`);
	}
	const expectedGitTag = options.expectedGitTag;
	if (expectedGitTag && value.gitTag !== expectedGitTag) {
		errors.push(`artifact.gitTag must match ${expectedGitTag}`);
	}
	const scenarioList = value.scenarios;
	if (!Array.isArray(scenarioList)) {
		errors.push("artifact.scenarios must be present");
	} else if (
		scenarioList.every((entry) => typeof entry === "string") &&
		JSON.stringify(scenarioList) !== JSON.stringify(EXPECTED_SCENARIOS)
	) {
		errors.push("artifact.scenarios must exactly name the nine required scenarios");
	}
	const runs = normalizedRuns(value);
	if (!runs || runs.length !== EXPECTED_SCENARIOS.length * RUNS_PER_SCENARIO) {
		errors.push("artifact must contain exactly 27 scenario runs");
	} else {
		const seen = new Set<string>();
		const occurrences = new Map<string, number>();
		for (const [index, run] of runs.entries()) {
			const label = `runs[${index}]`;
			const scenario = run.scenario;
			if (!EXPECTED_SCENARIOS.includes(scenario as (typeof EXPECTED_SCENARIOS)[number])) {
				errors.push(`${label}.scenario is not a required scenario`);
			}
			const scenarioKey = String(scenario);
			const iteration =
				typeof run.iteration === "number" && Number.isInteger(run.iteration)
					? run.iteration
					: (occurrences.get(scenarioKey) ?? 0) + 1;
			occurrences.set(scenarioKey, iteration);
			const key = `${scenarioKey}:${String(iteration)}`;
			if (seen.has(key)) errors.push(`${label} duplicates ${key}`);
			seen.add(key);
			if (!Number.isInteger(iteration) || iteration < 1 || iteration > RUNS_PER_SCENARIO) {
				errors.push(`${label}.iteration must be 1, 2, or 3`);
			}
			if (run.nextAction !== "keep") errors.push(`${label}.nextAction must be keep`);
			if (run.verdict !== "pass" && run.passed !== true) errors.push(`${label} must pass`);
			assertEvidence(run.evidence, label, errors);
		}
		for (const scenario of EXPECTED_SCENARIOS) {
			for (let iteration = 1; iteration <= RUNS_PER_SCENARIO; iteration++) {
				if (!seen.has(`${scenario}:${iteration}`)) errors.push(`missing run ${scenario}:${iteration}`);
			}
		}
	}
	if (value.allPassed !== true) errors.push("artifact.allPassed must be true");
	if (value.roundsRequested !== RUNS_PER_SCENARIO) errors.push("artifact.roundsRequested must be 3");
	if (value.roundsCompleted !== RUNS_PER_SCENARIO) errors.push("artifact.roundsCompleted must be 3");
	if (errors.length > 0) failure(errors);
}

export async function main(): Promise<void> {
	const artifactPath = process.env.OMP_LUNA_ACCEPTANCE_ARTIFACT ?? ".artifacts/luna-acceptance.json";
	const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
	await verifyLunaAcceptanceArtifact(artifact, {
		artifactPath,
		expectedGitCommit: process.env.GITHUB_SHA,
		expectedGitTag: process.env.OMP_LUNA_ACCEPTANCE_GIT_TAG,
	});
	console.log(`Verified Luna acceptance artifact: ${artifactPath}`);
}

if (import.meta.main) await main();
