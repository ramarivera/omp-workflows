import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
	applyGitPatch,
	captureGitChanges,
	withIntegration,
} from "../../src/runtime/git-isolation.js";
import { createWorkflowHost } from "../../src/runtime/subagent-runner.js";
import type { AgentRequest } from "../../src/runtime/types.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd, encoding: "utf8" });
	return String(result.stdout).trim();
}

async function repository(): Promise<{
	root: string;
	artifacts: string;
	base: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "omp-isolation-repo-"));
	const artifacts = await mkdtemp(join(tmpdir(), "omp-isolation-artifacts-"));
	cleanup.push(root, artifacts);
	await git(root, ["init"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(root, ["add", "base.txt"]);
	await git(root, ["commit", "-m", "base"]);
	return { root, artifacts, base: await git(root, ["rev-parse", "HEAD"]) };
}

async function patchFrom(
	root: string,
	artifacts: string,
	key: string,
	mutate: (worktree: string) => Promise<void>,
): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "omp-isolation-child-"));
	await rm(parent, { recursive: true, force: true });
	cleanup.push(parent);
	await git(root, ["worktree", "add", "--detach", parent, "HEAD"]);
	try {
		await mutate(parent);
		return (await captureGitChanges(parent, artifacts, key)).patchPath;
	} finally {
		await exec("git", ["worktree", "remove", "--force", parent], {
			cwd: root,
		}).catch(() => undefined);
	}
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		runId: "run",
		callIndex: 0,
		childId: "run:0:1",
		prompt: "work",
		inputHash: "hash",
		options: {},
		...overrides,
	};
}

describe("Git isolation contract", () => {
	test("captures tracked and untracked files in a durable sanitized binary patch", async () => {
		const { root, artifacts } = await repository();
		await writeFile(join(root, "base.txt"), "changed\n");
		await writeFile(join(root, "new.txt"), "new\n");
		const captured = await captureGitChanges(root, artifacts, "run:0/*bad");
		const patch = await readFile(captured.patchPath, "utf8");
		expect(patch).toContain("base.txt");
		expect(patch).toContain("new.txt");
		expect(basename(captured.patchPath)).toBe("run-0--bad.patch");
	});

	test("serially applies two patches on one hidden integration branch without touching the visible tree", async () => {
		const { root, artifacts, base } = await repository();
		const first = await patchFrom(
			root,
			artifacts,
			"first",
			async (worktree) => {
				await writeFile(join(worktree, "first.txt"), "first\n");
			},
		);
		const second = await patchFrom(
			root,
			artifacts,
			"second",
			async (worktree) => {
				await writeFile(join(worktree, "second.txt"), "second\n");
			},
		);
		const one = await withIntegration("serial", () =>
			applyGitPatch(root, artifacts, "serial", first, base),
		);
		const two = await withIntegration("serial", () =>
			applyGitPatch(root, artifacts, "serial", second, base),
		);
		expect(one.branchName).toBe(two.branchName);
		expect(two.integrationHead).not.toBe(one.integrationHead);
		expect(await git(root, ["show", `${two.branchName}:first.txt`])).toBe(
			"first",
		);
		expect(await git(root, ["show", `${two.branchName}:second.txt`])).toBe(
			"second",
		);
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(base);
		expect(await git(root, ["status", "--porcelain"])).toBe("");
	});

	test("persists an empty integration branch without creating a spurious commit", async () => {
		const { root, artifacts, base } = await repository();
		const empty = await patchFrom(
			root,
			artifacts,
			"empty",
			async () => undefined,
		);
		const result = await applyGitPatch(root, artifacts, "empty", empty, base);
		expect(result.integrationHead).toBe(base);
		expect(await git(root, ["rev-parse", result.branchName])).toBe(base);
	});

	test("rejects a stale visible head before integration", async () => {
		const { root, artifacts, base } = await repository();
		const patch = await patchFrom(
			root,
			artifacts,
			"stale",
			async (worktree) => {
				await writeFile(join(worktree, "stale.txt"), "stale\n");
			},
		);
		await writeFile(join(root, "visible.txt"), "visible\n");
		await git(root, ["add", "visible.txt"]);
		await git(root, ["commit", "-m", "move visible head"]);
		await expect(
			applyGitPatch(root, artifacts, "stale", patch, base),
		).rejects.toThrow("Stale integration head");
	});

	test("rejects a tampered integration branch before a later patch", async () => {
		const { root, artifacts, base } = await repository();
		const first = await patchFrom(
			root,
			artifacts,
			"tamper-one",
			async (worktree) => {
				await writeFile(join(worktree, "one.txt"), "one\n");
			},
		);
		const second = await patchFrom(
			root,
			artifacts,
			"tamper-two",
			async (worktree) => {
				await writeFile(join(worktree, "two.txt"), "two\n");
			},
		);
		const applied = await applyGitPatch(root, artifacts, "tamper", first, base);
		await git(root, ["branch", "-f", applied.branchName, base]);
		await expect(
			applyGitPatch(root, artifacts, "tamper", second, base),
		).rejects.toThrow("tampered");
	});

	test("serializes integration callbacks for the same run", async () => {
		const events: string[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withIntegration("lock", async () => {
			events.push("first:start");
			started.resolve();
			await release.promise;
			events.push("first:end");
		});
		await started.promise;
		const second = withIntegration("lock", async () => {
			events.push("second:start");
			events.push("second:end");
		});
		expect(events).toEqual(["first:start"]);
		release.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual([
			"first:start",
			"first:end",
			"second:start",
			"second:end",
		]);
	});
});

describe("workflow host isolation policy", () => {
	test("maps named policies and removes only its owned worktree after preserving a patch", async () => {
		const { root, artifacts } = await repository();
		let childWorktree = "";
		let mapped: Record<string, unknown> | undefined;
		const host = createWorkflowHost({
			cwd: root,
			subprocess: async (options) => {
				mapped = options as unknown as Record<string, unknown>;
				childWorktree = String(options.worktree);
				await writeFile(join(childWorktree, "child.txt"), "child\n");
				return {
					output: "ok",
					exitCode: 0,
					structuredOutput: { data: { ok: true } },
				} as never;
			},
		});
		const result = await host.invokeAgent(
			request({
				options: {
					model: "coding",
					effort: "high",
					toolset: ["repo-read", "repo-write"],
					isolation: { mode: "worktree" },
					apply: false,
					artifactsDir: artifacts,
				},
			}),
			new AbortController().signal,
		);
		expect(mapped).toMatchObject({
			modelOverride: "@task",
			effort: "hi",
			restrictToolNames: true,
			enableMCP: false,
		});
		expect((mapped?.agent as { tools: string[] }).tools).toEqual(
			expect.arrayContaining(["read", "lsp", "edit", "bash"]),
		);
		expect(await readFile(result.patch as string, "utf8")).toContain(
			"child.txt",
		);
		await expect(access(childWorktree)).rejects.toThrow();
	});

	test("invokes custom capture and apply callbacks and preserves caller-owned worktrees", async () => {
		const { root, artifacts, base } = await repository();
		const external = await mkdtemp(join(tmpdir(), "omp-caller-worktree-"));
		await rm(external, { recursive: true, force: true });
		cleanup.push(external);
		await git(root, ["worktree", "add", "--detach", external, "HEAD"]);
		const calls: string[] = [];
		const host = createWorkflowHost({
			cwd: root,
			currentIntegrationHead: () => base,
			captureChanges: (metadata) => {
				const cwd = (metadata as { cwd: string }).cwd;
				calls.push(`capture:${cwd}`);
				return { patchPath: join(artifacts, "custom.patch"), baseHead: base };
			},
			applyPatch: (_patch, metadata) => {
				calls.push(
					`apply:${String((metadata as { baseHead: string }).baseHead)}`,
				);
				return { branchName: "custom/branch", integrationHead: "custom-head" };
			},
			subprocess: async () => ({ output: "ok", exitCode: 0 }) as never,
		});
		const result = await host.invokeAgent(
			request({
				options: {
					isolation: { mode: "worktree" },
					worktree: external,
					apply: true,
				},
			}),
			new AbortController().signal,
		);
		expect(calls).toEqual([`capture:${external}`, `apply:${base}`]);
		expect(result).toMatchObject({
			patch: join(artifacts, "custom.patch"),
			branch: "custom/branch",
			integrationHead: "custom-head",
		});
		await expect(access(external)).resolves.toBeNull();
		await git(root, ["worktree", "remove", "--force", external]);
	});

	test("does not capture or apply a failed child", async () => {
		const { root } = await repository();
		let captured = 0;
		let applied = 0;
		const host = createWorkflowHost({
			cwd: root,
			captureChanges: () => {
				captured++;
				return {};
			},
			applyPatch: () => {
				applied++;
			},
			subprocess: async () =>
				({ output: "failed", exitCode: 1, stderr: "failed" }) as never,
		});
		await expect(
			host.invokeAgent(
				request({ options: { isolation: { mode: "worktree" }, apply: true } }),
				new AbortController().signal,
			),
		).rejects.toThrow("failed");
		expect({ captured, applied }).toEqual({ captured: 0, applied: 0 });
	});

	test("cancellation during capture fails closed before apply", async () => {
		const { root, artifacts, base } = await repository();
		const controller = new AbortController();
		let applied = 0;
		const host = createWorkflowHost({
			cwd: root,
			captureChanges: async () => {
				controller.abort();
				return { patchPath: join(artifacts, "cancel.patch"), baseHead: base };
			},
			applyPatch: () => {
				applied++;
			},
			subprocess: async () => ({ output: "ok", exitCode: 0 }) as never,
		});
		await expect(
			host.invokeAgent(
				request({ options: { isolation: { mode: "worktree" }, apply: true } }),
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(applied).toBe(0);
	});
});
