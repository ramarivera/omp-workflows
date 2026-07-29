import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "../src/extension.js";

test("package metadata exposes the public OMP extension contract", async () => {
	const packageJson = JSON.parse(
		await readFile(resolve("package.json"), "utf8"),
	) as {
		name: string;
		version: string;
		license: string;
		publishConfig: { access: string };
		exports: Record<string, unknown>;
		omp: { extensions: string[]; workflows: string };
		peerDependencies: Record<string, string>;
	};

	assert.equal(packageJson.name, "@ramarivera/omp-workflows");
	assert.equal(packageJson.license, "MIT");
	assert.equal(packageJson.publishConfig.access, "public");
	assert.equal(packageJson.version, "0.1.3");
	assert.deepEqual(Object.keys(packageJson.exports).sort(), [
		".",
		"./extension",
		"./workflows/*",
	]);
	assert.equal(packageJson.omp.workflows, "./workflows");
	assert.deepEqual(packageJson.omp.extensions, ["./dist/extension.js"]);
	assert.equal(
		packageJson.peerDependencies["@oh-my-pi/pi-coding-agent"],
		">=17.1.6 <18",
	);
});

test("extension registers the lifecycle without eager commands", () => {
	let label: string | undefined;
	const registeredEvents: string[] = [];
	const api: Partial<ExtensionAPI> = {
		setLabel(value: string) {
			label = value;
		},
		on(event: string) {
			registeredEvents.push(event);
		},
	};

	extension(api as ExtensionAPI);

	assert.equal(label, "OMP Workflows");
	assert.deepEqual(registeredEvents, ["session_start", "session_shutdown"]);
});
