import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ApprovalError,
	type ControllerJournal,
	RecoveryBlockedError,
	WorkflowController,
} from "../../src/runtime/controller.js";
import { RunJournal } from "../../src/runtime/journal.js";
import type {
	AgentRequest,
	AgentResult,
	WorkflowDefinition,
	WorkflowHost,
} from "../../src/runtime/types.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(error?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function definition<A = Record<string, unknown>, R = unknown>(
	run: WorkflowDefinition<A, R>["run"],
	limits: WorkflowDefinition["limits"] = {},
): WorkflowDefinition<A, R> {
	return {
		name: "contract",
		version: 3,
		sourceHash: "source-sha",
		sourcePath: "contract.ts",
		limits: {
			maxConcurrency: 2,
			maxAgents: 8,
			maxOutputTokens: 100,
			maxRuntimeMs: 1_000,
			...limits,
		},
		run,
	};
}

async function temporaryCwd(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "omp-controller-"));
}

interface FakeHost {
	host: WorkflowHost;
	requests: AgentRequest[];
	cancelled: string[];
}

function fakeHost(
	handler: (
		request: AgentRequest,
		signal: AbortSignal,
	) => Promise<unknown> = async (request) => request.prompt,
): FakeHost {
	const requests: AgentRequest[] = [];
	const cancelled: string[] = [];
	const host: WorkflowHost = {
		invokeAgent: async <T>(
			request: AgentRequest,
			signal: AbortSignal,
		): Promise<AgentResult<T>> => {
			requests.push(request);
			return {
				value: (await handler(request, signal)) as T,
				childId: request.childId,
				usage: { outputTokens: 1 },
			};
		},
		cancel: (childId) => {
			cancelled.push(childId);
		},
	};
	return { host, requests, cancelled };
}

function failingCompletedJournal(
	runId: string,
	cwd: string,
): ControllerJournal {
	const journal = new RunJournal(runId, cwd);
	return {
		append: (event) => journal.append(event),
		load: () => journal.load(),
		restore: () => journal.restore(),
		persistRun: (run) => journal.persistRun(run),
		snapshot: (run) => {
			if (run.status === "completed")
				throw new Error("injected snapshot failure");
			return journal.snapshot(run);
		},
	};
}

describe("WorkflowController public contract", () => {
	test("approval rejection creates no run and dispatches no child", async () => {
		const cwd = await temporaryCwd();
		const fake = fakeHost();
		const controller = new WorkflowController(fake.host, {
			cwd,
			validateApproval: () => false,
		});

		await expect(
			controller.start(
				definition(async (context) => context.agent("x")),
				{},
			),
		).rejects.toBeInstanceOf(ApprovalError);
		expect(
			await readdir(path.join(cwd, ".omp", "workflow-runs")).catch(() => []),
		).toHaveLength(0);
		expect(fake.requests).toHaveLength(0);
	});

	test("start persists the immutable tuple and returns before child completion", async () => {
		const cwd = await temporaryCwd();
		const started = deferred<void>();
		const release = deferred<unknown>();
		const fake = fakeHost(async () => {
			started.resolve();
			return release.promise;
		});
		const controller = new WorkflowController(fake.host, {
			cwd,
			validateApproval: () => true,
			resolveToolset: () => ["read"],
		});

		const run = await controller.start(
			definition((context) =>
				context.agent("x", {
					model: "m",
					effort: "high",
					toolset: "safe",
					isolation: { mode: "none" },
				}),
			),
			{ a: 1 },
			{ hash: "approved", tuple: { version: 1 } },
		);
		const persisted = await readFile(
			path.join(cwd, ".omp", "workflow-runs", run.id, "run.json"),
			"utf8",
		);
		expect(persisted).toContain("sourceHash");
		expect(persisted).toContain("fencingToken");
		expect(persisted).toContain("approved");
		await started.promise;
		let settled = false;
		const waiting = controller.wait(run.id).then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve("ok");
		expect((await waiting)?.status).toBe("completed");
		await controller.dispose();
	});

	test("subscriber observes a snapshot that already contains the transition", async () => {
		const cwd = await temporaryCwd();
		const controller = new WorkflowController(fakeHost().host, { cwd });
		const observed = deferred<void>();
		controller.subscribe(async (event) => {
			if (event.type !== "running") return;
			const persisted = await readFile(
				path.join(cwd, ".omp", "workflow-runs", event.runId, "run.json"),
				"utf8",
			);
			expect(persisted).toContain('"status":"running"');
			observed.resolve();
		});

		const run = await controller.start(
			definition(async () => "ok"),
			{},
		);
		await observed.promise;
		await controller.wait(run.id);
		await controller.dispose();
	});

	test("snapshot failure surfaces persistence_degraded and never completed", async () => {
		const controller = new WorkflowController(fakeHost().host, {
			cwd: await temporaryCwd(),
			journalFactory: failingCompletedJournal,
		});
		const run = await controller.start(
			definition(async () => "ok"),
			{},
		);
		const result = await controller.wait(run.id);
		expect(result?.status).toBe("persistence_degraded");
		expect(result?.persistenceHealth).toBe("degraded");
		await controller.dispose();
	});

	test("list and inspect return safe clones", async () => {
		const controller = new WorkflowController(fakeHost().host, {
			cwd: await temporaryCwd(),
		});
		const run = await controller.start(
			definition<{ nested: { x: number } }, object>(async () => ({})),
			{ nested: { x: 1 } },
		);
		const inspected = await controller.inspect(run.id);
		(inspected?.args as { nested: { x: number } }).nested.x = 9;
		const listed = await controller.list();
		(listed[0]?.args as { nested: { x: number } }).nested.x = 7;
		expect(
			((await controller.inspect(run.id))?.args as { nested: { x: number } })
				.nested.x,
		).toBe(1);
		await controller.wait(run.id);
		await controller.dispose();
	});

	test("parallel fanout allocates unique indexes and obeys maxConcurrency", async () => {
		let active = 0;
		let maximum = 0;
		const fake = fakeHost(async () => {
			active += 1;
			maximum = Math.max(maximum, active);
			await Promise.resolve();
			active -= 1;
			return 1;
		});
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
		});
		const run = await controller.start(
			definition((context) =>
				context.parallel(
					Array.from({ length: 8 }, () => () => context.agent("x")),
				),
			),
			{},
		);
		const result = await controller.wait(run.id);
		expect(
			new Set(fake.requests.map((request) => request.callIndex)).size,
		).toBe(8);
		expect(maximum).toBeLessThanOrEqual(2);
		expect(result?.calls).toHaveLength(8);
		await controller.dispose();
	});

	test("retry replays a cached undefined prefix and redispatches only the suffix", async () => {
		const promptCounts = new Map<string, number>();
		const fake = fakeHost(async (request) => {
			const count = (promptCounts.get(request.prompt) ?? 0) + 1;
			promptCounts.set(request.prompt, count);
			if (request.prompt === "first") return undefined;
			if (count === 1) throw new Error("second failed once");
			return "recovered";
		});
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
		});
		const workflow = definition(async (context) => [
			await context.agent("first"),
			await context.agent("second"),
		]);
		const run = await controller.start(workflow, {});
		expect((await controller.wait(run.id))?.status).toBe("failed");
		await controller.retry(run.id);
		const recovered = await controller.wait(run.id);

		expect(promptCounts.get("first")).toBe(1);
		expect(promptCounts.get("second")).toBe(2);
		expect(recovered?.calls).toHaveLength(2);
		expect(recovered?.calls[0]?.status).toBe("cached");
		expect(recovered?.calls[0]?.result).toBeUndefined();
		expect(recovered?.calls[1]?.status).toBe("succeeded");
		expect(recovered?.status).toBe("completed");
		await controller.dispose();
	});

	test("pause lets the active child finish, blocks the next dispatch, and resume completes", async () => {
		const firstStarted = deferred<void>();
		const firstRelease = deferred<unknown>();
		const paused = deferred<void>();
		const fake = fakeHost(async (request) => {
			if (request.callIndex === 0) {
				firstStarted.resolve();
				return firstRelease.promise;
			}
			return "second";
		});
		const cwd = await temporaryCwd();
		const controller = new WorkflowController(fake.host, { cwd });
		controller.subscribe((event) => {
			if (event.type === "paused") paused.resolve();
		});
		const run = await controller.start(
			definition(async (context) => [
				await context.agent("first"),
				await context.agent("second"),
			]),
			{},
		);
		await firstStarted.promise;
		await controller.pause(run.id);
		firstRelease.resolve("first");
		await paused.promise;
		expect(fake.requests).toHaveLength(1);
		expect((await controller.inspect(run.id))?.status).toBe("paused");
		expect(
			await readFile(
				path.join(cwd, ".omp", "workflow-runs", run.id, "run.json"),
				"utf8",
			),
		).toContain('"status":"paused"');
		await controller.resume(run.id);
		expect((await controller.wait(run.id))?.status).toBe("completed");
		expect(fake.requests).toHaveLength(2);
		await controller.dispose();
	});

	test("stop cancels every exact active child and fences late success", async () => {
		const allStarted = deferred<void>();
		const releases = [deferred<unknown>(), deferred<unknown>()];
		const fake = fakeHost((request) => {
			if (fake.requests.length === 2) allStarted.resolve();
			return releases[request.callIndex]?.promise;
		});
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
		});
		const run = await controller.start(
			definition((context) =>
				context.parallel([() => context.agent("a"), () => context.agent("b")]),
			),
			{},
		);
		await allStarted.promise;
		await controller.stop(run.id);
		expect(fake.cancelled.sort()).toEqual(
			fake.requests.map((request) => request.childId).sort(),
		);
		releases[0].resolve("late-a");
		releases[1].resolve("late-b");
		await controller.wait(run.id);
		expect((await controller.inspect(run.id))?.status).toBe("cancelled");
		await controller.dispose();
	});

	test("restore reconciles unknown children without redispatch", async () => {
		const cwd = await temporaryCwd();
		const fake = fakeHost();
		const first = new WorkflowController(fake.host, { cwd });
		const started = await first.start(
			definition((context) => context.agent("only")),
			{},
		);
		const completed = await first.wait(started.id);
		if (!completed) throw new Error("completed run missing");
		await first.dispose();

		const call = completed.calls[0];
		const attempt = call?.attempts[0];
		if (!call || !attempt) throw new Error("completed attempt missing");
		completed.status = "running";
		call.status = "running";
		attempt.status = "running";
		await new RunJournal(started.id, cwd).snapshot(completed);
		let inspected = 0;
		fake.host.inspectAgent = async () => {
			inspected += 1;
			return "unknown";
		};
		const second = new WorkflowController(fake.host, { cwd, generation: 2 });
		await second.restore();
		const restored = await second.inspect(started.id);
		expect(inspected).toBe(1);
		expect(fake.requests).toHaveLength(1);
		expect(restored?.calls[0]?.status).toBe("unknown");
		await second.dispose();
	});

	test("a live lease fences another controller until ownership is released", async () => {
		const cwd = await temporaryCwd();
		const first = new WorkflowController(fakeHost().host, {
			cwd,
			generation: 1,
		});
		const run = await first.start(
			definition(async () => 1),
			{},
		);
		await first.wait(run.id);
		const second = new WorkflowController(fakeHost().host, {
			cwd,
			generation: 2,
		});
		await expect(second.restore()).rejects.toBeInstanceOf(RecoveryBlockedError);
		await first.dispose();
		await second.restore();
		expect((await second.inspect(run.id))?.controllerGeneration).toBe(2);
		await second.dispose();
	});

	test("hard timeout cancels the exact child and fails the run", async () => {
		const fake = fakeHost(() => new Promise(() => undefined));
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
		});
		const run = await controller.start(
			definition((context) => context.agent("x", { timeoutMs: 2 })),
			{},
		);
		const result = await controller.wait(run.id);
		expect(fake.cancelled).toEqual([fake.requests[0]?.childId]);
		expect(result?.status).toBe("failed");
		await controller.dispose();
	});

	test("named toolsets resolve per dispatch and supported isolation is preserved", async () => {
		const fake = fakeHost();
		fake.host.supportsIsolation = async () => true;
		const resolved: string[] = [];
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
			resolveToolset: (name) => {
				resolved.push(name);
				return ["read"];
			},
		});
		const run = await controller.start(
			definition(async (context) => [
				await context.agent("a", {
					toolset: "safe",
					isolation: { mode: "required" },
				}),
				await context.agent("b", {
					toolset: "safe",
					isolation: { mode: "required" },
				}),
			]),
			{},
		);
		expect((await controller.wait(run.id))?.status).toBe("completed");
		expect(resolved).toEqual(["safe", "safe"]);
		expect(fake.requests[0]?.options.isolation).toEqual({ mode: "required" });
		await controller.dispose();
	});

	test("unavailable isolation and capture-head mismatch fail closed", async () => {
		const unavailable = fakeHost();
		unavailable.host.supportsIsolation = async () => false;
		const first = new WorkflowController(unavailable.host, {
			cwd: await temporaryCwd(),
		});
		const isolated = await first.start(
			definition((context) =>
				context.agent("x", { isolation: { mode: "required" } }),
			),
			{},
		);
		expect((await first.wait(isolated.id))?.status).toBe("failed");
		expect(unavailable.requests).toHaveLength(0);
		await first.dispose();

		const mismatch = fakeHost();
		mismatch.host.currentIntegrationHead = () => "before";
		mismatch.host.invokeAgent = async <T>(
			request: AgentRequest,
		): Promise<AgentResult<T>> => {
			mismatch.requests.push(request);
			return { value: "ok" as T, integrationHead: "after" };
		};
		const second = new WorkflowController(mismatch.host, {
			cwd: await temporaryCwd(),
		});
		const captured = await second.start(
			definition((context) => context.agent("x", { apply: false })),
			{},
		);
		const result = await second.wait(captured.id);
		expect(result?.status).toBe("failed");
		expect(result?.error).toContain("integration head mismatch");
		await second.dispose();
	});

	test("dispose aborts and awaits every owned task", async () => {
		const started = deferred<void>();
		const release = deferred<unknown>();
		const fake = fakeHost(async () => {
			started.resolve();
			return release.promise;
		});
		const controller = new WorkflowController(fake.host, {
			cwd: await temporaryCwd(),
		});
		const run = await controller.start(
			definition((context) => context.agent("x")),
			{},
		);
		await started.promise;
		const disposing = controller.dispose();
		release.resolve("late");
		await disposing;
		expect((await controller.inspect(run.id))?.status).toBe("paused");
	});
});
