import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const safeArtifactName = (value: string): string => {
	const normalized = [...value]
		.map((character) =>
			character.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(character)
				? "-"
				: character,
		)
		.join("")
		.replace(/[. ]+$/g, "");
	return normalized || "capture";
};

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
	const result = await exec("git", args, { cwd, encoding: "utf8" });
	return String(result.stdout).trim();
}

export interface CapturedPatch {
	patchPath: string;
	baseHead: string;
	branchName?: string;
}

export async function captureGitChanges(
	cwd: string,
	artifactDir: string,
	key: string,
): Promise<CapturedPatch> {
	const baseHead = await git(["rev-parse", "HEAD"], cwd);
	await mkdir(artifactDir, { recursive: true });
	const index = join(
		tmpdir(),
		`.omp-capture-index-${process.pid}-${randomUUID()}`,
	);
	const patchPath = join(artifactDir, `${safeArtifactName(key)}.patch`);
	try {
		await exec("git", ["read-tree", baseHead], {
			cwd,
			env: { ...process.env, GIT_INDEX_FILE: index },
		});
		await exec("git", ["add", "-A"], {
			cwd,
			env: { ...process.env, GIT_INDEX_FILE: index },
		});
		const patch = await exec(
			"git",
			["diff", "--cached", "--binary", "--full-index", baseHead],
			{
				cwd,
				env: { ...process.env, GIT_INDEX_FILE: index },
				encoding: "buffer",
			},
		);
		await writeFile(patchPath, patch.stdout as unknown as Uint8Array);
	} finally {
		await rm(index, { force: true }).catch(() => undefined);
	}
	return { patchPath, baseHead };
}

const locks = new Map<string, Promise<void>>();
export async function withIntegration<T>(
	runId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = locks.get(runId) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = previous.then(() => current);
	locks.set(runId, chained);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(runId) === chained) locks.delete(runId);
	}
}

interface IntegrationState {
	branchName: string;
	baseHead: string;
	head: string;
}

function integrationStatePath(artifactDir: string, runId: string): string {
	return join(
		artifactDir,
		`.integration-state-${safeArtifactName(runId)}.json`,
	);
}

async function readIntegrationState(
	path: string,
): Promise<IntegrationState | undefined> {
	try {
		const value = JSON.parse(
			await readFile(path, "utf8"),
		) as Partial<IntegrationState>;
		if (
			typeof value.branchName !== "string" ||
			typeof value.baseHead !== "string" ||
			typeof value.head !== "string"
		) {
			throw new Error("Malformed integration state");
		}
		return value as IntegrationState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeIntegrationState(
	path: string,
	state: IntegrationState,
): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

async function branchExists(cwd: string, branchName: string): Promise<boolean> {
	try {
		await exec(
			"git",
			["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
			{ cwd },
		);
		return true;
	} catch {
		return false;
	}
}

export async function applyGitPatch(
	cwd: string,
	artifactDir: string,
	runId: string,
	patchPath: string,
	expectedHead: string,
): Promise<{ branchName: string; integrationHead: string }> {
	const branchName = `omp/integration/${runId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	const wt = join(artifactDir, `.integration-${safeArtifactName(runId)}`);
	const stateFile = integrationStatePath(artifactDir, runId);
	await mkdir(artifactDir, { recursive: true });
	const persisted = await readIntegrationState(stateFile);
	const baseHead = persisted?.baseHead ?? expectedHead;
	const actual = await git(["rev-parse", "HEAD"], cwd);
	if (actual !== baseHead || expectedHead !== baseHead) {
		throw new Error(
			`Stale integration head: expected ${baseHead}, found ${actual}`,
		);
	}
	if (persisted && persisted.branchName !== branchName) {
		throw new Error("Integration state branch mismatch");
	}

	await exec("git", ["worktree", "remove", "--force", wt], { cwd }).catch(
		() => undefined,
	);
	await rm(wt, { recursive: true, force: true }).catch(() => undefined);
	try {
		if (persisted) {
			const ref = await git(["rev-parse", branchName], cwd);
			if (ref !== persisted.head)
				throw new Error("Integration branch was tampered with");
			await exec("git", ["worktree", "add", wt, branchName], { cwd });
		} else {
			if (await branchExists(cwd, branchName)) {
				throw new Error(
					"Integration branch exists without matching durable state",
				);
			}
			await exec(
				"git",
				["worktree", "add", "-b", branchName, wt, expectedHead],
				{ cwd },
			);
		}

		const expectedIntegrationHead = persisted?.head ?? expectedHead;
		const check = await git(["rev-parse", "HEAD"], wt);
		if (check !== expectedIntegrationHead) {
			throw new Error("Integration worktree head changed before apply");
		}
		if ((await readFile(patchPath)).byteLength > 0) {
			await exec("git", ["apply", "--binary", patchPath], { cwd: wt });
		}
		await exec("git", ["add", "-A"], { cwd: wt });
		const staged = await git(["diff", "--cached", "--quiet"], wt)
			.then(() => false)
			.catch(() => true);
		if (staged) {
			await exec(
				"git",
				[
					"-c",
					"user.name=OMP Workflow",
					"-c",
					"user.email=omp-workflow@localhost",
					"commit",
					"-m",
					`Apply workflow patch ${runId}`,
				],
				{ cwd: wt },
			);
		}
		const integrationHead = await git(["rev-parse", "HEAD"], wt);
		await writeIntegrationState(stateFile, {
			branchName,
			baseHead,
			head: integrationHead,
		});
		return { branchName, integrationHead };
	} finally {
		await exec("git", ["worktree", "remove", "--force", wt], { cwd }).catch(
			() => undefined,
		);
		await rm(wt, { recursive: true, force: true }).catch(() => undefined);
	}
}
