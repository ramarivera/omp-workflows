import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalInputHash, ReplayCache } from "../../src/runtime/cache.js";
import { RunJournal } from "../../src/runtime/journal.js";
import { SharedLimits } from "../../src/runtime/limits.js";
import {
	atomicWrite,
	readJsonWithBackup,
} from "../../src/storage/atomic-write.js";
import { Lease } from "../../src/storage/lease.js";

describe("runtime primitives", () => {
	test("canonical hash is stable", () =>
		expect(canonicalInputHash({ b: 2, a: 1 })).toBe(
			canonicalInputHash({ a: 1, b: 2 }),
		));
	test("replay preserves undefined and stops at miss", () => {
		const cache = new ReplayCache(
			[
				{
					index: 0,
					namespace: "n",
					inputHash: "h",
					status: "cached",
					attempts: [],
					result: undefined,
				},
				{
					index: 1,
					namespace: "n",
					inputHash: "x",
					status: "succeeded",
					attempts: [],
					result: 2,
				},
			],
			"n",
		);
		expect(cache.lookup(0, "h")).toBeUndefined();
		expect(cache.longestPrefix).toBe(0);
		expect(cache.lookup(1, "bad")).toBeUndefined();
		expect(cache.longestPrefix).toBe(0);
	});
	test("atomic write distinguishes missing and recovers backup", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-"));
		const file = path.join(dir, "run.json");
		expect((await readJsonWithBackup(file)).source).toBe("missing");
		await atomicWrite(file, '{"ok":true}');
		await atomicWrite(file, '{"ok":false}');
		await writeFile(file, "broken");
		expect((await readJsonWithBackup<{ ok: boolean }>(file)).source).toBe(
			"backup",
		);
	});
	test("journal validates monotonic sequence", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-"));
		const j = new RunJournal("r", dir);
		await j.append({ type: "x", runId: "r", at: 1 });
		expect((await j.load())[0]?.seq).toBe(1);
	});
	test("lease rejects wrong token", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-"));
		const lease = await Lease.acquire(path.join(dir, "lease"), 3);
		await expect(lease.release("wrong")).rejects.toThrow("wrong lease token");
		await lease.release();
	});
	test("shared limiter totals agents", async () => {
		const limits = new SharedLimits({ maxConcurrency: 1 });
		const release = await limits.acquireAgent();
		expect(limits.snapshot().agents).toBe(1);
		release();
	});
});
