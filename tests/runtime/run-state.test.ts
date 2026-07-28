import { describe, expect, test } from "bun:test";
import { RunStateCoordinator } from "../../src/runtime/run-state.js";
import type { WorkflowRun } from "../../src/runtime/types.js";

const makeRun = (): WorkflowRun => ({
	schemaVersion: 2,
	id: "r1",
	namespace: "n",
	controllerGeneration: 1,
	fencingToken: "t",
	definition: { name: "x", version: 1 },
	args: {},
	limits: {},
	status: "planned",
	persistenceHealth: "healthy",
	calls: [],
	totals: { agents: 0, outputTokens: 0, runtimeMs: 0 },
	phases: [],
	createdAt: 0,
	updatedAt: 0,
});
const setup = (failure = false) => {
	const order: string[] = [];
	const journal = {
		append: async (e: { type: string }) => {
			order.push(`journal:${e.type}`);
			if (failure && e.type === "status_changed") throw new Error("disk");
			return { ...e, schemaVersion: 2, seq: 1, runId: "r1", at: 1 } as never;
		},
		snapshot: async () => {
			order.push("snapshot");
		},
	};
	const c = new RunStateCoordinator(
		makeRun(),
		journal,
		1,
		"t",
		async (e) => {
			order.push(`event:${e.type}`);
		},
		{ clock: () => 1, leasePath: `/tmp/omp-run-state-${Math.random()}` },
	);
	return { c, order, journal };
};
describe("RunStateCoordinator", () => {
	test("orders journal, snapshot, event", async () => {
		const { c, order } = setup();
		await c.transition("running");
		expect(order).toEqual([
			"journal:status_changed",
			"snapshot",
			"event:status_changed",
		]);
	});
	test("degrades on persistence failure", async () => {
		const { c, order } = setup(true);
		await expect(c.transition("running")).rejects.toThrow("disk");
		expect(c.snapshot.status).toBe("persistence_degraded");
		expect(order).toEqual([
			"journal:status_changed",
			"journal:persistence_degraded",
			"event:persistence_degraded",
		]);
	});
	test("rejects stale generation", async () => {
		const { journal } = setup();
		const c = new RunStateCoordinator(
			{ ...makeRun(), controllerGeneration: 2 },
			journal,
			1,
			"t",
			() => {},
		);
		await expect(c.transition("running")).rejects.toThrow("stale fencing");
	});
	test("lease exclusivity and wrong token", async () => {
		const path = `/tmp/omp-run-state-lease-${Math.random()}`;
		const { journal } = setup();
		const a = new RunStateCoordinator(makeRun(), journal, 1, "t", () => {}, {
			leasePath: path,
		});
		const b = new RunStateCoordinator(makeRun(), journal, 1, "t", () => {}, {
			leasePath: path,
		});
		const lease = await a.acquire();
		await expect(b.acquire()).rejects.toBeDefined();
		await expect(a.release("wrong")).rejects.toThrow("wrong lease token");
		await a.release(lease.record.token);
	});
});
