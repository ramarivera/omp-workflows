import { describe, expect, test } from "bun:test";
import { runWorkflowProbe } from "../../src/probe.js";

describe("public workflow probe", () => {
	test("launches two named strict agents concurrently", async () => {
		const ids: string[] = [];
		const result = await runWorkflowProbe({
			cwd: "/repo",
			model: "m",
			subprocess: async (options) => {
				ids.push(String(options.id));
				return {
					output: "ok",
					exitCode: 0,
					structuredOutput: { value: { ok: true } },
					resolvedModel: "m",
					usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
				} as never;
			},
		});
		expect(ids).toEqual(expect.arrayContaining(["probe-a", "probe-b"]));
		expect(result.evidence).toMatchObject({
			strictSchema: true,
			concurrent: true,
		});
	});
	test("captures lifecycle events and usage/model metadata", async () => {
		const result = await runWorkflowProbe({
			cwd: "/repo",
			model: "m",
			subprocess: async () =>
				({
					output: "ok",
					exitCode: 0,
					structuredOutput: { value: { ok: true } },
					resolvedModel: "m",
					usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
				}) as never,
		});
		expect(result.events.length).toBeGreaterThan(0);
		expect(
			result.records.some(
				(record) =>
					record.usage?.totalTokens === 5 && record.requestedModel === "m",
			),
		).toBe(true);
	});
	test("records exact cancellation and rejects late success", async () => {
		let aborted = false;
		const result = await runWorkflowProbe({
			cwd: "/repo",
			model: "m",
			subprocess: async (options) => {
				if (options.id === "probe-b") {
					options.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
						},
						{ once: true },
					);
					await new Promise<void>((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(), {
							once: true,
						}),
					);
				}
				return {
					output: "ok",
					exitCode: 0,
					structuredOutput: { value: { ok: true } },
				} as never;
			},
		});
		expect(aborted).toBe(true);
		expect(result.cancellationProved).toBe(true);
		expect(result.evidence.noLateSuccess).toBe(true);
	});
	test("keeps terminal records for fallback and failed subprocesses", async () => {
		const result = await runWorkflowProbe({
			cwd: "/repo",
			model: "fallback",
			subprocess: async () => ({ output: "bad", exitCode: 1 }) as never,
		});
		expect(result.records).toHaveLength(2);
		expect(
			result.records.every((record) =>
				["aborted", "failed", "completed"].includes(record.terminal),
			),
		).toBe(true);
	});
});
