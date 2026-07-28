import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverRunIds, recoverRun } from "../../src/runtime/recovery.js";
import type { WorkflowHost, WorkflowRun } from "../../src/runtime/types.js";
import { runPath } from "../../src/storage/paths.js";

const base = (id: string): WorkflowRun => ({
	schemaVersion: 2,
	id,
	namespace: id,
	controllerGeneration: 1,
	fencingToken: "f",
	definition: { name: "x", version: 1 },
	args: {},
	limits: {},
	status: "running",
	persistenceHealth: "healthy",
	calls: [
		{
			index: 0,
			namespace: id,
			inputHash: "h",
			status: "running",
			attempts: [
				{
					id: "a",
					callIndex: 0,
					childId: "child",
					status: "running",
					inputHash: "h",
				},
			],
		},
	],
	totals: { agents: 1, outputTokens: 0, runtimeMs: 0 },
	phases: [],
	createdAt: 1,
	updatedAt: 1,
});

describe("recovery", () => {
	test("missing root is empty and reconciles without duplicate dispatch", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-recovery-"));
		expect(await discoverRunIds(cwd)).toEqual([]);
		const id = "r1";
		await mkdir(runPath(id, cwd), { recursive: true });
		await writeFile(
			path.join(runPath(id, cwd), "run.json"),
			JSON.stringify(base(id)),
		);
		let inspected = 0;
		const host: WorkflowHost = {
			inspectAgent: async (child) => {
				inspected++;
				expect(child).toBe("child");
				return "completed";
			},
			invokeAgent: async () => {
				throw new Error("must not dispatch");
			},
		};
		const run = await recoverRun(id, host, { cwd });
		expect(inspected).toBe(1);
		expect(run.calls[0]?.status).toBe("succeeded");
	});

	test("valid backup recovers truncated primary", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-recovery-"));
		const id = "r2";
		await mkdir(runPath(id, cwd), { recursive: true });
		const run = base(id);
		await writeFile(
			path.join(runPath(id, cwd), "run.json.bak"),
			JSON.stringify(run),
		);
		await writeFile(path.join(runPath(id, cwd), "run.json"), "{truncated");
		const restored = await recoverRun(
			id,
			{
				inspectAgent: async () => "unknown",
				invokeAgent: async <T>() => ({ value: undefined as T }),
			},
			{ cwd },
		);
		expect(restored.id).toBe(id);
		expect(restored.calls[0]?.status).toBe("unknown");
	});
});
