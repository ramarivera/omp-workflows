import { describe, expect, test } from "bun:test";
import { canonicalInputHash } from "../../src/runtime/cache.js";
import {
	executeWorkflow,
	WorkflowExecution,
} from "../../src/runtime/executor.js";
import { SharedLimits } from "../../src/runtime/limits.js";
import type {
	AgentRequest,
	AgentResult,
	WorkflowDefinition,
	WorkflowHost,
	WorkflowRun,
} from "../../src/runtime/types.js";

function run(calls: WorkflowRun["calls"] = []): WorkflowRun<{ x: number }> {
	return {
		schemaVersion: 2,
		id: "r",
		namespace: "n",
		controllerGeneration: 1,
		fencingToken: "f",
		definition: { name: "d", version: 1 },
		args: { x: 1 },
		limits: {},
		status: "planned",
		persistenceHealth: "healthy",
		calls,
		totals: { agents: 0, outputTokens: 0, runtimeMs: 0 },
		phases: [],
		createdAt: 0,
		updatedAt: 0,
	};
}
function host(fn: (request: AgentRequest) => Promise<unknown>): WorkflowHost {
	return {
		invokeAgent: async <T>(request: AgentRequest): Promise<AgentResult<T>> => ({
			value: (await fn(request)) as T,
			childId: request.childId,
			usage: { outputTokens: 1 },
		}),
	};
}
const def: WorkflowDefinition<{ x: number }, unknown> = {
	name: "d",
	version: 1,
	run: async (ctx) => [
		await ctx.agent("p", { model: "m" }),
		await ctx.agent("q"),
	],
};

describe("workflow executor", () => {
	test("allocates indexes synchronously and replays undefined prefix", async () => {
		const calls = [
			{
				index: 0,
				namespace: "n",
				inputHash: canonicalInputHash({
					definition: { name: "d", version: 1 },
					args: { x: 1 },
					prompt: "p",
					options: { model: "m" },
				}),
				status: "cached" as const,
				attempts: [],
				result: undefined,
			},
		];
		let invoked = 0;
		const result = await executeWorkflow(def, {
			run: run(calls),
			host: host(async () => {
				invoked++;
				return 3;
			}),
		});
		expect(result).toEqual([undefined, 3]);
		expect(invoked).toBe(1);
	});
	test("parallel all-settled and fatal stop", async () => {
		const execution = new WorkflowExecution(
			{
				name: "p",
				version: 1,
				run: async (ctx) =>
					ctx.parallel([
						() => ctx.agent("a"),
						() => Promise.reject(new Error("x")),
					]),
			},
			{ run: run(), host: host(async (r) => r.prompt) },
		);
		expect(await execution.execute()).toEqual(["a", undefined]);
		const fatal = new WorkflowExecution(
			{
				name: "p",
				version: 1,
				run: async (ctx) =>
					ctx.parallel(
						[() => ctx.agent("a"), () => Promise.reject(new Error("x"))],
						true,
					),
			},
			{ run: run(), host: host(async (r) => r.prompt) },
		);
		await expect(fatal.execute()).rejects.toThrow();
	});
	test("timeout cancels exact child and isolation fails closed", async () => {
		const cancelled: string[] = [];
		const h: WorkflowHost = {
			invokeAgent: (_r, signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
			cancel: (id) => {
				cancelled.push(id);
			},
		};
		const timeout = new WorkflowExecution(
			{
				name: "d",
				version: 1,
				run: async (ctx) => ctx.agent("x", { timeoutMs: 2 }),
			},
			{ run: run(), host: h },
		);
		await expect(timeout.execute()).rejects.toThrow();
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]).toContain(":0:");
		const iso = new WorkflowExecution(
			{
				name: "d",
				version: 1,
				run: async (ctx) => ctx.agent("x", { isolation: { mode: "required" } }),
			},
			{ run: run(), host: h },
		);
		await expect(iso.execute()).rejects.toThrow("isolation unavailable");
	});
	test("capture-only validates integration head and shared limits", async () => {
		const h = host(async () => "ok");
		const r = run();
		await expect(
			executeWorkflow(
				{ name: "d", version: 1, run: async (ctx) => ctx.agent("x") },
				{
					run: r,
					host: {
						...h,
						invokeAgent: (async <T>() => ({
							value: "ok" as T,
							integrationHead: "bad",
							usage: { outputTokens: 1 },
						})) as WorkflowHost["invokeAgent"],
					},
					captureOnly: true,
					capturedIntegrationHead: "good",
					limits: new SharedLimits({ maxOutputTokens: 0 }),
				},
			),
		).rejects.toThrow();
	});
});
