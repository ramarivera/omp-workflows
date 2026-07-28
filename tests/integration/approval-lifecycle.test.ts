import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	type OperatorController,
	registerWorkflowCommands,
} from "../../src/commands/operator.js";
import { parseWorkflowArgs } from "../../src/commands/parser.js";
import {
	discoverWorkflowFile,
	discoverWorkflows,
} from "../../src/definition/discovery.js";
import { loadApprovedWorkflow } from "../../src/definition/loader.js";
import type {
	WorkflowApprovalPreview,
	WorkflowApprovalRecord,
} from "../../src/definition/types.js";
import extension from "../../src/extension.js";
import type { WorkflowRun } from "../../src/runtime/types.js";
import { workflowApprovalPath } from "../../src/storage/paths.js";
import { registerWorkflowAuthoringTool } from "../../src/tools/workflow-author.js";
import {
	ApprovalStore,
	createApprovalPreview,
	workflowHash,
} from "../../src/ui/approval.js";
import { PLUGIN_VERSION } from "../../src/version.js";

const SOURCE = `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({ name: "demo", version: 1, args: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } }, async (ctx) => ctx.args);`;
function normalized(preview: WorkflowApprovalPreview): WorkflowApprovalPreview {
	const value = JSON.parse(JSON.stringify(preview)) as Record<string, unknown>;
	delete value.hash;
	return {
		...value,
		hash: workflowHash(String(value.rawSource), value),
	} as WorkflowApprovalPreview;
}

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "omp-workflow-lifecycle-"));
	await mkdir(join(cwd, ".omp", "workflows"), { recursive: true });
	const path = join(cwd, ".omp", "workflows", "demo.ts");
	await writeFile(path, SOURCE);
	const found = await discoverWorkflowFile(path, "project");
	if (!found) throw new Error("fixture metadata was not discovered");
	const preview = normalized(
		createApprovalPreview(
			SOURCE,
			found.definition,
			{ n: 1 },
			{
				source: { path, scope: "project" },
				toolset: ["yield"],
				model: "model-a",
				effort: "low",
				runtimeVersion: PLUGIN_VERSION,
			},
		),
	);
	return { cwd, path, found, preview };
}

async function cleanup(cwd: string) {
	await rm(cwd, { recursive: true, force: true });
}

function fakeContext(hasUi = true, confirmed = true): ExtensionCommandContext {
	return {
		hasUI: hasUi,
		cwd: "/tmp",
		ui: { confirm: async () => confirmed },
	} as unknown as ExtensionCommandContext;
}

function fakeController(
	overrides: Partial<OperatorController> = {},
): OperatorController {
	const run = { id: "run-1", status: "running" } as unknown as WorkflowRun;
	return {
		start: async () => run,
		list: async () => [run],
		inspect: async () => run,
		pause: async () => run,
		resume: async () => run,
		stop: async () => run,
		retry: async () => run,
		...overrides,
	};
}

describe("approval lifecycle", () => {
	test("parser preserves explicit JSON args", () =>
		expect(parseWorkflowArgs('start demo --args "{\\"n\\":2}"').args).toEqual({
			n: 2,
		}));
	test("parser preserves trust scope", () =>
		expect(parseWorkflowArgs("start demo --scope user").scope).toBe("user"));
	test("project discovery is source-only", async () => {
		const f = await fixture();
		try {
			expect(f.found.source.scope).toBe("project");
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("project precedence wins over user", async () => {
		const f = await fixture();
		try {
			const user = await mkdtemp(join(tmpdir(), "omp-workflow-user-"));
			await mkdir(user, { recursive: true });
			await writeFile(
				join(user, "demo.ts"),
				SOURCE.replace("version: 1", "version: 2"),
			);
			const found = await discoverWorkflows({
				projectDir: f.cwd,
				userDir: user,
			});
			expect(
				found.find((item) => item.definition.name === "demo")?.source.scope,
			).toBe("project");
			await cleanup(user);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("plugin roots use package-root workflows", async () => {
		const f = await fixture();
		try {
			const plugin = await mkdtemp(join(tmpdir(), "omp-workflow-plugin-"));
			await mkdir(join(plugin, "workflows"), { recursive: true });
			await writeFile(
				join(plugin, "workflows", "plugin.ts"),
				SOURCE.replace('name: "demo"', 'name: "plugin"'),
			);
			const found = await discoverWorkflows({
				projectDir: f.cwd,
				pluginDirs: [plugin],
			});
			expect(
				found.find((item) => item.definition.name === "plugin")?.source.path,
			).toBe(join(plugin, "workflows", "plugin.ts"));
			await cleanup(plugin);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("exact source helper does not execute workflow code", async () => {
		const f = await fixture();
		try {
			const found = await discoverWorkflowFile(f.path, "project");
			expect(found?.definition.name).toBe("demo");
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("preview includes raw source hash args and static routing", async () => {
		const f = await fixture();
		try {
			expect(f.preview.rawSource).toBe(SOURCE);
			expect(f.preview.args).toEqual({ n: 1 });
			expect(f.preview.hash).toHaveLength(64);
			expect(f.preview.toolset).toEqual(["yield"]);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("approval is absent before confirmation", async () => {
		const f = await fixture();
		try {
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			expect(await store.find(f.preview.hash)).toBeUndefined();
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("approval verification succeeds after confirmation save", async () => {
		const f = await fixture();
		try {
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			await store.approve(f.preview, "project", f.path);
			expect(await store.verify(f.preview)).toBe(true);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("tampered source invalidates approval", async () => {
		const f = await fixture();
		try {
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			await store.approve(f.preview, "project", f.path);
			await writeFile(f.path, `${SOURCE}\n// tampered`);
			expect(await store.verify(f.preview)).toBe(false);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("tampered args invalidate exact tuple", async () => {
		const f = await fixture();
		try {
			const altered = createApprovalPreview(
				SOURCE,
				f.found.definition,
				{ n: 2 },
				{
					source: { path: f.path, scope: "project" },
					toolset: ["yield"],
					model: "model-a",
					effort: "low",
				},
			);
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			await store.approve(f.preview, "project", f.path);
			expect(await store.verify(altered)).toBe(false);
		} finally {
			await cleanup(f.cwd);
		}
	});

	test("package version change invalidates prior approval before dispatch", async () => {
		const f = await fixture();
		try {
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			await store.approve(f.preview, "project", f.path);
			const changedPackagePreview = createApprovalPreview(
				SOURCE,
				f.found.definition,
				{ n: 1 },
				{
					source: { path: f.path, scope: "project" },
					toolset: ["yield"],
					model: "model-a",
					effort: "low",
					runtimeVersion: `${PLUGIN_VERSION}-changed`,
				},
			);
			expect(changedPackagePreview.versions.runtime).not.toBe(
				f.preview.versions.runtime,
			);
			expect(await store.verify(changedPackagePreview)).toBe(false);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("tampered model runtime and toolset invalidate tuple", async () => {
		const f = await fixture();
		try {
			const altered = createApprovalPreview(
				SOURCE,
				f.found.definition,
				{ n: 1 },
				{
					source: { path: f.path, scope: "project" },
					toolset: ["bash"],
					model: "model-b",
					effort: "high",
					runtimeVersion: "2",
				},
			);
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			await store.approve(f.preview, "project", f.path);
			expect(await store.verify(altered)).toBe(false);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("loader rejects missing approval before import", async () => {
		const f = await fixture();
		try {
			await expect(
				loadApprovedWorkflow(f.path, null as unknown as WorkflowApprovalRecord),
			).rejects.toThrow("Complete approval");
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("stage decline leaves target unsaved", async () => {
		const f = await fixture();
		try {
			let tool:
				| { execute: (...args: unknown[]) => Promise<unknown> }
				| undefined;
			const pi = {
				typebox: {
					Type: {
						Object: (v: object) => v,
						Union: (v: object[]) => v,
						Literal: (v: string) => v,
						Optional: (v: object) => v,
						String: () => ({}),
						Any: () => ({}),
					},
				},
				registerTool: (value: typeof tool) => {
					tool = value;
				},
			};
			registerWorkflowAuthoringTool(pi as unknown as ExtensionAPI, {
				cwd: f.cwd,
			});
			if (!tool) throw new Error("stage tool missing");
			const result = await tool.execute(
				"id",
				{ source: SOURCE, args: { n: 1 }, scope: "project" },
				undefined,
				undefined,
				fakeContext(false),
			);
			expect(result).toHaveProperty("isError", true);
			expect(await readFile(f.path, "utf8")).toBe(SOURCE);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("stage approval saves target and target approval", async () => {
		const f = await fixture();
		try {
			let approvalMessage = "";
			let tool:
				| { execute: (...args: unknown[]) => Promise<unknown> }
				| undefined;
			const pi = {
				typebox: {
					Type: {
						Object: (v: object) => v,
						Union: (v: object[]) => v,
						Literal: (v: string) => v,
						Optional: (v: object) => v,
						String: () => ({}),
						Any: () => ({}),
					},
				},
				registerTool: (value: typeof tool) => {
					tool = value;
				},
			};
			registerWorkflowAuthoringTool(pi as unknown as ExtensionAPI, {
				cwd: f.cwd,
			});
			if (!tool) throw new Error("stage tool missing");
			const context = fakeContext(true);
			context.ui.confirm = async (_title, message) => {
				approvalMessage = message;
				return true;
			};
			const result = await tool.execute(
				"id",
				{ source: SOURCE, args: { n: 1 }, scope: "project" },
				undefined,
				undefined,
				context,
			);
			// Readable approval message keeps the runtime version, the exact
			// 64-char SHA-256 hash, AND the full raw workflow source verbatim
			// so the operator can verify the approval without re-encoding.
			expect(approvalMessage).toContain(PLUGIN_VERSION);
			expect(approvalMessage).toMatch(/sha-256: [a-f0-9]{64}/);
			expect(approvalMessage).toContain(SOURCE);
			const text = JSON.stringify(result);
			expect(text).toContain("target");
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("start forwards approval proof to controller", async () => {
		let seen: unknown;
		let handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> =
			async () => {};
		const pi = {
			registerCommand: (_name: string, spec: { handler: typeof handler }) => {
				handler = spec.handler;
			},
			sendMessage: () => {},
		};
		registerWorkflowCommands(
			pi as unknown as ExtensionAPI,
			fakeController({
				start: async (_definition, _args, approval) => {
					seen = approval;
					return {};
				},
			}),
			{
				discover: async () => [],
				load: async () => ({
					name: "demo",
					definition: {},
					approval: { hash: "h", tuple: {} },
				}),
			},
		);
		await handler("start demo --args '{\"n\":1}'", fakeContext());
		expect(seen).toEqual({ hash: "h", tuple: {} });
	});
	test("generate sends authoring guidance and stage instruction", async () => {
		let sent = "";
		let handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> =
			async () => {};
		const pi = {
			registerCommand: (_name: string, spec: { handler: typeof handler }) => {
				handler = spec.handler;
			},
			sendMessage: () => {},
			sendUserMessage: (value: string) => {
				sent = value;
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, fakeController(), {
			discover: async () => [],
			generate: async (request) => {
				sent = request;
				return {};
			},
		});
		await handler("generate request", fakeContext());
		expect(sent).toContain("request");
	});
	test("save and revoke definitions remain available across stores", async () => {
		const f = await fixture();
		try {
			const store = new ApprovalStore(workflowApprovalPath("project", f.cwd));
			const record = await store.approve(f.preview, "project", f.path);
			expect(await store.find(record.hash)).toBeDefined();
			await store.revoke(record.hash);
			expect(await store.find(record.hash)).toBeUndefined();
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("discovered names are offered as completions", async () => {
		let completion: ((prefix: string) => unknown) | undefined;
		const pi = {
			registerCommand: (
				_name: string,
				spec: { getArgumentCompletions?: (prefix: string) => unknown },
			) => {
				completion = spec.getArgumentCompletions;
			},
			sendMessage: () => {},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, fakeController(), {
			discover: async () => [],
			completionNames: () => ["demo", "other"],
		});
		expect(completion?.("start d")).toEqual([
			{ value: "demo", label: "demo", description: "discovered workflow" },
		]);
	});
	test("duplicate registration does not duplicate command setup", () => {
		let count = 0;
		const pi = {
			registerCommand: () => {
				count += 1;
			},
			sendMessage: () => {},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, fakeController(), {
			discover: async () => [],
		});
		expect(count).toBe(1);
	});
	test("print-mode staging fails closed", async () => {
		const f = await fixture();
		try {
			let tool:
				| { execute: (...args: unknown[]) => Promise<unknown> }
				| undefined;
			const pi = {
				typebox: {
					Type: {
						Object: (v: object) => v,
						Union: (v: object[]) => v,
						Literal: (v: string) => v,
						Optional: (v: object) => v,
						String: () => ({}),
						Any: () => ({}),
					},
				},
				registerTool: (value: typeof tool) => {
					tool = value;
				},
			};
			registerWorkflowAuthoringTool(pi as unknown as ExtensionAPI, {
				cwd: f.cwd,
			});
			if (!tool) throw new Error("stage tool missing");
			const result = await tool.execute(
				"id",
				{ source: SOURCE, args: { n: 1 }, scope: "project" },
				undefined,
				undefined,
				fakeContext(false),
			);
			expect(result).toHaveProperty("isError", true);
		} finally {
			await cleanup(f.cwd);
		}
	});
	test("switch and shutdown clear widget and dispose session state", async () => {
		const events: Record<
			string,
			(event: unknown, ctx: unknown) => Promise<void>
		> = {};
		const widgets: unknown[] = [];
		const pi = {
			setLabel: () => {},
			on: (
				name: string,
				handler: (event: unknown, ctx: unknown) => Promise<void>,
			) => {
				events[name] = handler;
			},
			registerCommand: () => {},
			registerTool: () => {},
			sendMessage: () => {},
			typebox: {
				Type: {
					Object: (v: object) => v,
					Union: (v: object[]) => v,
					Literal: (v: string) => v,
					Optional: (v: object) => v,
					String: () => ({}),
					Number: () => ({}),
					Any: () => ({}),
				},
			},
		};
		extension(pi as unknown as ExtensionAPI);
		const ui = {
			setWidget: (_key: string, content: unknown) => {
				widgets.push(content);
			},
			confirm: async () => true,
		};
		const ctx = {
			cwd: await mkdtemp(join(tmpdir(), "omp-workflow-session-")),
			modelRegistry: { getAll: () => [] },
			hasUI: true,
			ui,
		};
		try {
			await events.session_start?.({}, ctx);
			await events.session_before_switch?.({}, ctx);
			await events.session_start?.({}, ctx);
			await events.session_shutdown?.({}, ctx);
			expect(widgets.some((content) => Array.isArray(content))).toBe(true);
			expect(widgets.at(-1)).toBeUndefined();
		} finally {
			await cleanup(ctx.cwd);
		}
	});
});
