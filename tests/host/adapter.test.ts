import { describe, expect, test } from "bun:test";
import { runWorkflowProbe } from "../../src/probe.js";
import { createWorkflowHost } from "../../src/runtime/subagent-runner.js";
import type { AgentRequest } from "../../src/runtime/types.js";

describe("public workflow host seam", () => {
	test("maps executor policy and normalizes stable metadata", async () => {
		let seen: Record<string, unknown> | undefined;
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async (options) => {
				seen = options as unknown as Record<string, unknown>;
				options.onProgress?.({
					index: 3,
					id: "child-1",
					agent: "workflow",
					status: "running",
				} as never);
				return {
					output: "ok",
					structuredOutput: { value: { ok: true } },
					exitCode: 0,
					usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
					resolvedModel: "provider/resolved",
					outputPath: "/tmp/out",
					patchPath: "/tmp/p.patch",
					branchName: "omp/task/child-1",
					branchBaseSha: "abc",
				} as never;
			},
		});
		const request: AgentRequest = {
			runId: "r",
			callIndex: 3,
			childId: "child-1",
			prompt: "do",
			inputHash: "h",
			options: {
				model: "provider/requested",
				fallbacks: ["provider/fallback"],
				effort: "hi",
				schema: { type: "object" },
				schemaMode: "strict",
				toolset: ["yield"],
				worktree: "/repo-wt",
				isolation: { mode: "worktree" },
				detached: true,
				persistArtifacts: true,
				artifactsDir: "/tmp/artifacts",
				timeoutMs: 1234,
			},
		};
		const events: unknown[] = [];
		host.subscribe?.((event) => events.push(event));
		const result = await host.invokeAgent(
			request,
			new AbortController().signal,
		);
		expect(seen).toMatchObject({
			cwd: "/repo",
			id: "child-1",
			index: 3,
			modelOverride: ["provider/requested", "provider/fallback"],
			effort: "hi",
			outputSchema: request.options.schema,
			outputSchemaMode: "strict",
			worktree: "/repo-wt",
			detached: true,
			restrictToolNames: true,
			enableMCP: false,
			persistArtifacts: true,
			artifactsDir: "/tmp/artifacts",
			maxRuntimeMs: 1234,
		});
		expect(result).toMatchObject({
			childId: "child-1",
			sessionId: "child-1",
			handle: "child-1",
			requestedModel: "provider/requested",
			resolvedModel: "provider/resolved",
			requestedEffort: "hi",
			patch: "/tmp/p.patch",
			branch: "omp/task/child-1",
			integrationHead: "abc",
		});
		expect(
			events.some((event) => (event as { type: string }).type === "progress"),
		).toBe(true);
		expect(await host.inspectAgent?.("child-1")).toBe("completed");
	});

	test("cancellation aborts underlying child and late completion cannot succeed", async () => {
		const late = Promise.withResolvers<never>();
		let aborted = false;
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async (options) => {
				options.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return late.promise;
			},
		});
		const request: AgentRequest = {
			runId: "r",
			callIndex: 0,
			childId: "exact",
			prompt: "wait",
			inputHash: "h",
			options: {},
		};
		const pending = host.invokeAgent(request, new AbortController().signal);
		await Promise.resolve();
		let cancellationSettled = false;
		const cancelling = Promise.resolve(host.cancel?.("exact")).then(() => {
			cancellationSettled = true;
		});
		await Promise.resolve();
		expect(cancellationSettled).toBe(false);
		late.resolve({
			output: "late",
			exitCode: 0,
			structuredOutput: { value: true },
		} as never);
		await cancelling;
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(aborted).toBe(true);
		expect(await host.inspectAgent?.("exact")).toBe("cancelled");
	});

	test("probe records concurrent strict-schema calls and exact cancellation", async () => {
		const result = await runWorkflowProbe({
			cwd: "/repo",
			model: "provider/model",
			subprocess: async (options) => {
				if (options.id === "probe-b") {
					await new Promise<void>((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(), {
							once: true,
						}),
					);
					return {
						output: "late",
						exitCode: 0,
						structuredOutput: { value: { ok: true } },
					} as never;
				}
				return {
					output: "ok",
					exitCode: 0,
					structuredOutput: { value: { ok: true } },
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					resolvedModel: "provider/model",
				} as never;
			},
		});
		expect(result.evidence).toEqual({
			strictSchema: true,
			concurrent: true,
			namedAgents: true,
			fallback: true,
			effort: true,
			toolset: true,
			exactCancellation: true,
			noLateSuccess: true,
		});
		expect(result.records).toHaveLength(2);
		expect(
			result.records.find((record) => record.childId === "probe-b")?.terminal,
		).toBe("aborted");
		expect(
			result.events.some(
				(event) => event.type === "progress" || event.type === "completed",
			),
		).toBe(true);
	});
	test("normalizes structured value, usage, handle, artifact, patch, branch, and metadata", async () => {
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async () =>
				({
					output: "fallback",
					structuredOutput: { value: { answer: 42 } },
					exitCode: 0,
					usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
					sessionId: "sess",
					handle: "hdl",
					outputPath: "/tmp/out.json",
					patchPath: "/tmp/change.patch",
					branchName: "feature/x",
					branchBaseSha: "head",
				}) as never,
		});
		const result = await host.invokeAgent(
			{
				runId: "r",
				callIndex: 1,
				childId: "c",
				prompt: "x",
				inputHash: "h",
				options: { model: "m", effort: "medium" },
			},
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			value: { answer: 42 },
			usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
			sessionId: "sess",
			handle: "hdl",
			artifacts: { output: "/tmp/out.json", patch: "/tmp/change.patch" },
			patch: "/tmp/change.patch",
			branch: "feature/x",
			integrationHead: "head",
		});
	});

	test("normalizes failed and cancelled lifecycle events", async () => {
		const events: unknown[] = [];
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async () =>
				({ output: "bad", exitCode: 2, stderr: "oops" }) as never,
		});
		host.subscribe?.((event) => events.push(event));
		await expect(
			host.invokeAgent(
				{
					runId: "r",
					callIndex: 2,
					childId: "bad",
					prompt: "x",
					inputHash: "h",
					options: {},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("oops");
		expect(await host.inspectAgent?.("bad")).toBe("failed");
		expect(
			events.some((event) => (event as { type: string }).type === "failed"),
		).toBe(true);
	});

	test("supports isolation and change callbacks are exposed", async () => {
		const calls: string[] = [];
		const host = createWorkflowHost({
			cwd: "/repo",
			supportsIsolation: () => true,
			captureChanges: () => {
				calls.push("capture");
				return { files: 1 };
			},
			applyPatch: () => {
				calls.push("apply");
				return true;
			},
		});
		expect(await host.supportsIsolation?.({ mode: "worktree" })).toBe(true);
		expect(await host.captureChanges?.({})).toEqual({ files: 1 });
		expect(await host.applyPatch?.("patch", {})).toBe(true);
		expect(calls).toEqual(["capture", "apply"]);
	});

	test("fails closed when isolation support and change callbacks are absent or throw", async () => {
		const host = createWorkflowHost({ cwd: "/repo" });
		expect(await host.supportsIsolation?.({ mode: "required" })).toBe(false);
		expect(host.captureChanges).toBeUndefined();
		expect(host.applyPatch).toBeUndefined();
		const throwing = createWorkflowHost({
			cwd: "/repo",
			supportsIsolation: () => {
				throw new Error("no");
			},
		});
		await expect(
			(async () => throwing.supportsIsolation?.({ mode: "required" }))(),
		).rejects.toThrow("no");
	});

	test("maps permissive schema mode and string toolset without enabling MCP", async () => {
		let seen: Record<string, unknown> | undefined;
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async (options) => {
				seen = options as never;
				return { output: "ok", exitCode: 0 } as never;
			},
		});
		await host.invokeAgent(
			{
				runId: "r",
				callIndex: 3,
				childId: "map",
				prompt: "x",
				inputHash: "h",
				options: {
					schema: { type: "string" },
					schemaMode: "permissive",
					toolset: "yield",
				},
			},
			new AbortController().signal,
		);
		expect(seen).toMatchObject({
			outputSchemaMode: "permissive",
			restrictToolNames: true,
			enableMCP: false,
		});
	});

	test("cleanup removes active child after terminal completion", async () => {
		const host = createWorkflowHost({
			cwd: "/repo",
			subprocess: async () => ({ output: "ok", exitCode: 0 }) as never,
		});
		await host.invokeAgent(
			{
				runId: "r",
				callIndex: 4,
				childId: "done",
				prompt: "x",
				inputHash: "h",
				options: {},
			},
			new AbortController().signal,
		);
		await host.cancel?.("done");
		expect(await host.inspectAgent?.("done")).toBe("completed");
	});
});
