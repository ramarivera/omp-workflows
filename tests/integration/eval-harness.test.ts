import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { describe, it } from "node:test";
import {
	CASES,
	commandForCase,
	isolatedFixture,
	MODEL,
	runGate,
	THINKING,
} from "../../scripts/eval/harness.js";

const plugin = "/isolated/plugin";
describe("OMP/Luna evaluation harness", () => {
	it("enumerates the complete verification matrix", async () => {
		const matrix = JSON.parse(
			await readFile(
				new URL("../fixtures/verification-matrix.json", import.meta.url),
				"utf8",
			),
		);
		assert.deepEqual(Object.keys(matrix), [...CASES]);
	});
	it("builds safe one-shot and RPC commands with exact Luna routing", () => {
		const oneShot = commandForCase(
			"stable-replay",
			"/fixture",
			"/profile",
			"/session",
			plugin,
		);
		assert.ok(
			oneShot.includes("--model") &&
				oneShot.includes(MODEL) &&
				oneShot.includes("--thinking") &&
				oneShot.includes(THINKING),
		);
		assert.ok(
			oneShot.includes("-p") &&
				oneShot.includes("--mode") &&
				oneShot.includes("json"),
		);
		assert.ok(!oneShot.includes("--auto-approve"));
		assert.ok(
			commandForCase(
				"pause",
				"/fixture",
				"/profile",
				"/session",
				plugin,
			).includes("--rpc"),
		);
	});
	it("requires three repetitions before acceptance execution", async () => {
		await assert.rejects(
			runGate({ pluginDir: plugin, run: true, repetitions: 2 }),
			/three clean repetitions/,
		);
	});
	it("creates isolated fixture state", async () => {
		const dir = await isolatedFixture();
		try {
			assert.equal(await readFile(`${dir}/fixture.txt`, "utf8"), "clean\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
