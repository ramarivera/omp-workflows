import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "../../src/definition/discovery.js";
import { loadApprovedWorkflow } from "../../src/definition/loader.js";
import type { WorkflowApprovalRecord } from "../../src/definition/types.js";
import {
	validateArguments,
	validateDefinition,
} from "../../src/definition/validation.js";
import {
	generateStaged,
	validateSourcePolicy,
} from "../../src/generation/index.js";
import type { WorkflowDefinition } from "../../src/runtime/types.js";
import {
	ApprovalStore,
	createApprovalPreview,
	workflowHash,
} from "../../src/ui/approval.js";

const def = (extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
	name: "demo",
	version: 1,
	args: {
		type: "object",
		properties: { count: { type: "integer" } },
		required: ["count"],
		additionalProperties: false,
	},
	run: () => 1,
	...extra,
});
const source =
	"import { defineWorkflow } from '@ramarivera/omp-workflows'; export const workflow = defineWorkflow({ name: 'demo', version: 1 });";
const details = (
	path = "/tmp/demo.ts",
	scope: "project" | "user" | "plugin" = "project",
) => ({
	model: "m",
	effort: "high",
	toolset: ["x"],
	isolation: "worktree",
	apply: false,
	fallbacks: ["f"],
	runtimeVersion: "r",
	source: { path, scope },
	filesystem: ["/tmp"],
});
const previewSource = `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({
  name: "demo",
  version: 1,
  args: { type: "object" },
  limits: {},
  async run({ phase, agent }) {
    phase("Inspect");
    return agent("Do the work", {
      id: "worker",
      agent: "task",
      model: "model/primary",
      effort: "lo",
      fallbacks: ["model/fallback"],
      toolset: ["read"],
      isolation: { mode: "none" },
      apply: false
    });
  }
});`;

const temp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("definition/security contracts", () => {
	test("discovery is source-only, canonical, sorted and precedence-aware", async () => {
		const root = await temp("omp-def-");
		await mkdir(join(root, ".omp/workflows"), { recursive: true });
		const user = join(root, "user");
		const plugin = join(root, "plugin");
		await mkdir(user);
		await mkdir(join(plugin, "workflows"), { recursive: true });
		await writeFile(join(root, ".omp/workflows", "z.ts"), source);
		await writeFile(
			join(root, ".omp/workflows", "a.ts"),
			source.replaceAll("demo", "alpha"),
		);
		await writeFile(join(user, "demo.ts"), source.replace("demo", "user"));
		await writeFile(join(plugin, "workflows", "demo.ts"), source);
		const found = await discoverWorkflows({
			projectDir: root,
			userDir: user,
			pluginDirs: [plugin],
		});
		expect(found.map((x) => x.definition.name)).toEqual([
			"alpha",
			"demo",
			"user",
		]);
		expect(found.find((x) => x.definition.name === "demo")?.source.scope).toBe(
			"project",
		);
		expect(found.diagnostics.length).toBeGreaterThan(0);
	});
	test("discovers metadata from the canonical run method shape", async () => {
		const root = await temp("omp-canonical-");
		await mkdir(join(root, ".omp/workflows"), { recursive: true });
		await writeFile(join(root, ".omp/workflows", "demo.ts"), previewSource);
		const found = await discoverWorkflows({ projectDir: root });
		expect(found.map((entry) => entry.definition.name)).toEqual(["demo"]);
		expect(found.diagnostics).toEqual([]);
	});
	test("missing project, user, and plugin directories are harmless", async () => {
		const root = await temp("omp-missing-");
		const found = await discoverWorkflows({
			projectDir: root,
			userDir: join(root, "none"),
			pluginDirs: [join(root, "plugin")],
		});
		expect([...found]).toEqual([]);
		expect(found.diagnostics).toEqual([]);
	});
	test("symlink workflow sources are rejected", async () => {
		const root = await temp("omp-link-");
		const dir = join(root, ".omp/workflows");
		await mkdir(dir, { recursive: true });
		await mkdir(join(root, "u"));
		const target = join(root, "target.ts");
		await writeFile(target, source);
		await symlink(target, join(dir, "link.ts"));
		const found = await discoverWorkflows({
			projectDir: root,
			userDir: join(root, "u"),
		});
		expect([...found]).toEqual([]);
		expect(found.diagnostics.map((x) => x.message).join(" ")).toContain(
			"Symlink",
		);
	});
	test("project, user, and plugin collisions retain precedence and diagnostics", async () => {
		const root = await temp("omp-collide-");
		await mkdir(join(root, ".omp/workflows"), { recursive: true });
		const u = join(root, "u");
		const p = join(root, "p");
		await mkdir(u);
		await mkdir(join(p, "workflows"), { recursive: true });
		await writeFile(join(root, ".omp/workflows/a.ts"), source);
		await writeFile(join(u, "a.ts"), source);
		await writeFile(join(p, "workflows/a.ts"), source);
		const found = await discoverWorkflows({
			projectDir: root,
			userDir: u,
			pluginDirs: [p],
		});
		expect(found).toHaveLength(1);
		expect(found.diagnostics.map((x) => x.message).join(" ")).toContain(
			"Collision",
		);
	});
	test("invalid definition metadata is reported by validation", async () => {
		const root = await temp("omp-meta-");
		await mkdir(join(root, ".omp/workflows"), { recursive: true });
		await writeFile(
			join(root, ".omp/workflows/bad.ts"),
			source.replace("name: 'demo'", "name: 'Bad Name'"),
		);
		const found = await discoverWorkflows({
			projectDir: root,
			userDir: join(root, "u"),
		});
		expect(found).toHaveLength(1);
		expect(validateDefinition(found[0].definition)).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "name" })]),
		);
	});
	test("definition validation rejects metadata and callable violations", () => {
		const invalidRun = Object.assign(def(), { run: 1 });
		expect(validateDefinition(def({ name: "Bad Name" }))).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "name" })]),
		);
		expect(validateDefinition(def({ version: 0 }))).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "version" })]),
		);
		expect(validateDefinition(invalidRun)).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "run" })]),
		);
	});
	test("Ajv rejects wrong, missing, extra and invalid composite arguments", () => {
		const schema = {
			type: "object",
			properties: {
				n: { type: "integer" },
				pair: {
					type: "array",
					items: { type: "string" },
					minItems: 2,
					maxItems: 2,
				},
			},
			required: ["n", "pair"],
			additionalProperties: false,
		};
		for (const value of [
			{ n: "1", pair: ["a", "b"] },
			{ n: 1 },
			{ n: 1, pair: ["a", "b"], extra: true },
			{ n: 1, pair: ["a"] },
		])
			expect(validateArguments(schema, value).length).toBeGreaterThan(0);
		expect(validateArguments(schema, { n: 1, pair: ["a", "b"] })).toEqual([]);
	});
	test("invalid JSON schemas and args produce validation issues", () => {
		expect(validateArguments({ type: "not-a-schema" }, {})[0].path).toBe(
			"$schema",
		);
		expect(
			validateArguments({ type: "object", required: ["x"] }, {}).length,
		).toBeGreaterThan(0);
	});
	test("AST policy rejects imports, re-exports, dynamic import, require and host escapes", () => {
		for (const fragment of [
			"import x from 'fs'",
			"export * from './x.js'",
			"export { x } from './x.js'",
			"import('./x.js')",
			"const r = require('x')",
			"process.env.X",
			"fs.readFileSync('x')",
			"fetch('x')",
			"new Date()",
			"Date.now()",
			"Math.random()",
			"crypto.randomUUID()",
			"performance.now()",
			"WebSocket",
		])
			expect(() =>
				validateSourcePolicy(`${fragment}; export const workflow = 1;`),
			).toThrow();
	});
	test("AST policy permits SDK import and deterministic source", () => {
		expect(() => validateSourcePolicy(source)).not.toThrow();
	});
	test("generation stages unique contained files and never executes", async () => {
		const dir = await temp("omp-stage-");
		let calls = 0;
		const generator = {
			generate: async () => {
				calls++;
				return source;
			},
		};
		const a = await generateStaged("x", generator, dir);
		const b = await generateStaged("x", generator, dir);
		expect(a.path).not.toBe(b.path);
		expect(a.path.startsWith(dir)).toBe(true);
		expect(calls).toBe(2);
	});
	test("generation rejects empty or unsafe output without execution", async () => {
		const dir = await temp("omp-gen-");
		let calls = 0;
		await expect(
			generateStaged(
				"x",
				{
					generate: async () => {
						calls++;
						return "";
					},
				},
				dir,
			),
		).rejects.toThrow();
		await expect(
			generateStaged("x", { generate: async () => "import 'fs'" }, dir),
		).rejects.toThrow();
		expect(calls).toBe(1);
	});
	test("approval preview contains phases calls routing source version limits and filesystem", () => {
		const preview = createApprovalPreview(
			previewSource,
			def({ limits: { maxRuntimeMs: 2_000 } }),
			{ count: 1 },
			details(),
		);
		expect(preview.phases).toEqual(["Inspect"]);
		expect(preview.calls).toEqual([
			expect.objectContaining({
				id: "worker",
				prompt: "Do the work",
				agent: "task",
				model: "model/primary",
				effort: "lo",
				fallbacks: ["model/fallback"],
				toolset: ["read"],
				apply: false,
			}),
		]);
		expect(preview.routing).toEqual(
			expect.objectContaining({ model: "m", effort: "high", fallbacks: ["f"] }),
		);
		expect(preview.source.path).toBe("/tmp/demo.ts");
		expect(preview.versions).toEqual({ runtime: "r", definition: 1 });
		expect(preview.limits).toEqual({ maxRuntimeMs: 2_000 });
		expect(preview.filesystem).toEqual(["/tmp"]);
	});
	test("approval hash changes for every tuple dimension", () => {
		const preview = createApprovalPreview(
			previewSource,
			def(),
			{ count: 1 },
			details(),
		);
		const { hash: _hash, ...original } = preview;
		for (const key of [
			"rawSource",
			"args",
			"phases",
			"calls",
			"routing",
			"metadata",
			"model",
			"effort",
			"fallbacks",
			"toolset",
			"isolation",
			"apply",
			"source",
			"pluginSource",
			"versions",
			"limits",
			"filesystem",
		]) {
			const tuple: Record<string, unknown> = {
				...original,
				[key]: key === "args" ? { count: 2 } : `${key}-changed`,
			};
			expect(workflowHash(previewSource, tuple)).not.toBe(preview.hash);
		}
	});
	test("approval store supports exact approve, lookup and revoke", async () => {
		const root = await temp("omp-store-");
		const sourcePath = join(root, "demo.ts");
		await writeFile(sourcePath, previewSource);
		const preview = createApprovalPreview(
			previewSource,
			def(),
			{ count: 1 },
			details(sourcePath),
		);
		const store = new ApprovalStore(join(root, "approvals.json"));
		const record = await store.approve(preview, "project", sourcePath);
		expect(await store.isApproved(record.hash)).toBe(true);
		expect(await store.get(record.hash)).toEqual(record);
		await store.revoke(record.hash);
		expect(await store.isApproved(record.hash)).toBe(false);
	});
	test("malformed approval store is rejected", async () => {
		const path = join(await temp("omp-malformed-"), "approvals.json");
		await writeFile(path, "{}");
		await expect(new ApprovalStore(path).isApproved("x")).rejects.toThrow(
			"Malformed approval store",
		);
	});
	test("plugin workflows are read-only and malicious names are rejected", async () => {
		const root = await temp("omp-plugin-");
		const sourcePath = join(root, "plugin.ts");
		await writeFile(sourcePath, previewSource);
		const preview = createApprovalPreview(
			previewSource,
			def(),
			{ count: 1 },
			details(sourcePath, "plugin"),
		);
		const store = new ApprovalStore(join(root, "approvals.json"));
		await store.approve(preview, "user", sourcePath);
		await expect(
			store.saveApproved(preview, await temp("omp-target-")),
		).rejects.toThrow("read-only");
		expect(() =>
			createApprovalPreview(
				previewSource,
				def({ name: "../escape" }),
				{ count: 1 },
				details(sourcePath),
			),
		).toThrow("kebab-case");
	});
	test("load rejects path, hash, and tuple tampering before import", async () => {
		const root = await temp("omp-load-");
		const path = join(root, "workflow.ts");
		const explosive = `${previewSource}\nthrow new Error("EXECUTED");`;
		await writeFile(path, explosive);
		const preview = createApprovalPreview(
			explosive,
			def(),
			{ count: 1 },
			details(path),
		);
		const base: WorkflowApprovalRecord = {
			workflowId: "demo:1",
			hash: preview.hash,
			approvedAt: new Date().toISOString(),
			scope: "project",
			sourcePath: path,
			toolset: preview.toolset,
			runtimeVersion: "r",
			tuple: preview,
		};
		const tamperedTuple = {
			...preview,
			source: { ...preview.source, path: join(root, "other.ts") },
		};
		const variants: WorkflowApprovalRecord[] = [
			{ ...base, hash: "0".repeat(64) },
			{ ...base, sourcePath: join(root, "other.ts") },
			{ ...base, tuple: tamperedTuple },
		];
		for (const record of variants)
			await expect(loadApprovedWorkflow(path, record)).rejects.toThrow();
	});
	test("load rejects source tampering and accepts an exact approved load", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-test-load-"));
		await mkdir(join(root, "node_modules", "@ramarivera"), { recursive: true });
		await symlink(
			process.cwd(),
			join(root, "node_modules", "@ramarivera", "omp-workflows"),
		);
		try {
			const path = join(root, "workflow.ts");
			await writeFile(path, previewSource);
			const preview = createApprovalPreview(
				previewSource,
				def(),
				{ count: 1 },
				details(path),
			);
			const record: WorkflowApprovalRecord = {
				workflowId: "demo:1",
				hash: preview.hash,
				approvedAt: new Date().toISOString(),
				scope: "project",
				sourcePath: path,
				toolset: preview.toolset,
				runtimeVersion: "r",
				tuple: preview,
			};
			await writeFile(path, `${previewSource}\n// tampered`);
			await expect(loadApprovedWorkflow(path, record)).rejects.toThrow();
			await writeFile(path, previewSource);
			const loaded = await loadApprovedWorkflow(path, record);
			expect(loaded.name).toBe("demo");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
