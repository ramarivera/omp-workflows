import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type OperatorController,
	type OperatorDefinitions,
	registerWorkflowCommands,
} from "./commands/operator.js";
import {
	discoverWorkflowFile,
	discoverWorkflows,
} from "./definition/discovery.js";
import { loadApprovedWorkflow } from "./definition/loader.js";
import type {
	WorkflowApprovalPreview,
	WorkflowApprovalRecord,
} from "./definition/types.js";
import { authoringGuidance } from "./generation/index.js";
import { runWorkflowProbe } from "./probe.js";
import { WorkflowController } from "./runtime/controller.js";
import { applyGitPatch, captureGitChanges } from "./runtime/git-isolation.js";
import { createWorkflowHost } from "./runtime/subagent-runner.js";
import type { WorkflowDefinition } from "./runtime/types.js";
import { workflowApprovalPath, workflowScopePath } from "./storage/paths.js";
import {
	registerWorkflowAuthoringTool,
	type WorkflowAuthoringOptions,
} from "./tools/workflow-author.js";
import { registerWorkflowControlTool } from "./tools/workflow-control.js";
import {
	APPROVAL_CONFIRM_TITLE,
	ApprovalStore,
	createApprovalPreview,
	formatApprovalMessage,
	workflowHash,
} from "./ui/approval.js";
import {
	DEFAULT_UI_MODE,
	resolveUiMode,
	type WorkflowUiMode,
} from "./ui/mode.js";
import { renderWorkflowStatus } from "./ui/status.js";
import { createOmpStyler, type SemanticStyler } from "./ui/style.js";
import { PLUGIN_VERSION } from "./version.js";

type SessionState = {
	ctx: ExtensionContext;
	controller: WorkflowController;
	definitions: OperatorDefinitions;
	unsubscribe?: () => void;
	mode: WorkflowUiMode;
	warnings: readonly string[];
	styler: SemanticStyler;
	workflows: Array<{ name: string; version?: number }>;
};

function stores(cwd: string): { project: ApprovalStore; user: ApprovalStore } {
	return {
		project: new ApprovalStore(workflowApprovalPath("project", cwd)),
		user: new ApprovalStore(workflowApprovalPath("user", cwd)),
	};
}
const gitExec = promisify(execFile);
async function currentGitHead(cwd: string): Promise<string | undefined> {
	try {
		const result = await gitExec("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
		});
		return String(result.stdout).trim() || undefined;
	} catch {
		return undefined;
	}
}

function pluginDirs(ctx: ExtensionContext): string[] {
	const context = ctx as ExtensionContext & {
		pluginDirs?: Array<string | { path: string }>;
		extensionRoots?: Array<string | { path: string }>;
	};
	const values = context.pluginDirs ?? context.extensionRoots ?? [];
	const fromContext = values
		.map((value) => (typeof value === "string" ? value : value.path))
		.filter(Boolean);
	const fromEnvironment = (process.env.OMP_PLUGIN_DIRS ?? "")
		.split(delimiter)
		.filter(Boolean);
	const bundledPluginRoot = resolve(import.meta.dir, "..");
	return [...new Set([bundledPluginRoot, ...fromContext, ...fromEnvironment])];
}

const TOOLSET_PROFILES: Readonly<Record<string, readonly string[]>> = {
	"repo-read": ["read", "grep", "glob", "lsp"],
	"repo-write": ["read", "grep", "glob", "lsp", "edit", "write", "bash"],
	"web-research": ["read", "web_search"],
};

function resolveToolset(pi: ExtensionAPI, name: string): string[] | undefined {
	const active = new Set(pi.getActiveTools());
	if (active.has(name)) return [name];
	const profile = TOOLSET_PROFILES[name];
	if (!profile) return undefined;
	const resolved = profile.filter((tool) => active.has(tool));
	return resolved.length > 0 ? resolved : undefined;
}

function approvalMatches(
	record: WorkflowApprovalRecord,
	proof: unknown,
	tuple: unknown,
): boolean {
	if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
	if (!tuple || typeof tuple !== "object" || Array.isArray(tuple)) return false;
	const candidate = proof as Partial<WorkflowApprovalRecord>;
	const invocation = tuple as {
		name?: unknown;
		version?: unknown;
		sourceHash?: unknown;
		sourcePath?: unknown;
		args?: unknown;
		limits?: unknown;
	};
	if (
		candidate.hash !== record.hash ||
		!candidate.tuple ||
		workflowHash("", candidate.tuple) !== workflowHash("", record.tuple)
	) {
		return false;
	}
	const preview = record.tuple as Partial<WorkflowApprovalPreview>;
	const approvedSourceHash =
		typeof preview.rawSource === "string"
			? createHash("sha256").update(preview.rawSource).digest("hex")
			: undefined;
	return (
		preview.metadata?.name === invocation.name &&
		preview.metadata?.version === invocation.version &&
		preview.source?.path === invocation.sourcePath &&
		approvedSourceHash === invocation.sourceHash &&
		workflowHash("", preview.args) === workflowHash("", invocation.args) &&
		workflowHash("", preview.limits) === workflowHash("", invocation.limits)
	);
}

export default function ompWorkflowsExtension(pi: ExtensionAPI): void {
	pi.setLabel("OMP Workflows");
	const state: { current?: SessionState } = {};
	const styler = createOmpStyler();
	const authoringOptions: WorkflowAuthoringOptions = {
		cwd: process.cwd(),
		mode: () => state.current?.mode ?? DEFAULT_UI_MODE,
	};
	const canRegister = typeof pi.registerCommand === "function";
	const delegatedController: OperatorController = {
		start: async (definition, args, approval) => {
			if (!state.current)
				throw new Error("workflow session is not initialized");
			return state.current.controller.start(
				definition as WorkflowDefinition,
				args,
				approval,
			);
		},
		list: async () => state.current?.controller.list() ?? [],
		inspect: async (id) => state.current?.controller.inspect(id),
		pause: async (id) => {
			if (!state.current)
				throw new Error("workflow session is not initialized");
			return state.current.controller.pause(id);
		},
		resume: async (id) => {
			if (!state.current)
				throw new Error("workflow session is not initialized");
			return state.current.controller.resume(id);
		},
		stop: async (id) => {
			if (!state.current)
				throw new Error("workflow session is not initialized");
			return state.current.controller.stop(id);
		},
		retry: async (id, index) => {
			if (!state.current)
				throw new Error("workflow session is not initialized");
			return state.current.controller.retry(id, index);
		},
		subscribe: (listener) =>
			state.current?.controller.subscribe(listener) ?? (() => undefined),
	};
	const delegatedDefinitions: OperatorDefinitions = {
		discover: async () => state.current?.definitions.discover() ?? [],
		load: async (name, scope, args, commandCtx) => {
			if (!state.current?.definitions.load)
				throw new Error("workflow session is not initialized");
			return state.current.definitions.load(name, scope, args, commandCtx);
		},
		generate: async (request, ctx) =>
			state.current?.definitions.generate?.(request, ctx),
		create: async (request, ctx) =>
			state.current?.definitions.create?.(request, ctx),
		save: async (run, scope, ctx) =>
			state.current?.definitions.save?.(run, scope, ctx),
		revoke: async (id) => state.current?.definitions.revoke?.(id),
		probe: async () => state.current?.definitions.probe?.(),
	};

	if (canRegister) {
		registerWorkflowCommands(pi, delegatedController, delegatedDefinitions, {
			getMode: () => state.current?.mode ?? DEFAULT_UI_MODE,
			getRenderOptions: () => ({
				maxWidth: 78,
				styler,
				availableWorkflows: state.current?.workflows ?? [],
			}),
		});
		registerWorkflowControlTool(pi, delegatedController, delegatedDefinitions);
		registerWorkflowAuthoringTool(pi, authoringOptions);
	}

	const pauseRunning = async (session: SessionState): Promise<void> => {
		const runs = await session.controller.list();
		await Promise.allSettled(
			runs
				.filter((run) => run.status === "running")
				.map((run) => session.controller.pause(run.id)),
		);
	};
	const clearWidget = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget("omp-workflow-status", undefined);
	};
	const refreshWidget = async (session: SessionState): Promise<void> => {
		if (!session.ctx.hasUI) return;
		const runs = await session.controller.list();
		const body = renderWorkflowStatus(runs, session.mode, {
			maxWidth: 78,
			styler: session.styler,
			availableWorkflows: session.workflows,
		});
		const header = session.warnings.length
			? `${session.warnings.join("\n")}\n`
			: "";
		session.ctx.ui.setWidget("omp-workflow-status", [`${header}${body}`], {
			placement: "belowEditor",
		});
	};

	if (canRegister) {
		pi.on("session_before_switch", async (_event, ctx) => {
			if (!state.current) return;
			await pauseRunning(state.current);
			state.current.unsubscribe?.();
			state.current.unsubscribe = undefined;
			clearWidget(ctx);
			await state.current.controller.dispose();
			state.current = undefined;
		});
	}
	pi.on("session_start", async (_event, ctx) => {
		if (state.current) return;
		authoringOptions.cwd = ctx.cwd;
		const approvalStores = stores(ctx.cwd);
		const resolveModeResult = await resolveUiMode({ cwd: ctx.cwd });
		const mode: WorkflowUiMode = resolveModeResult.mode;
		const warnings: readonly string[] = resolveModeResult.warnings;
		const validateApproval = async (
			proof: unknown,
			tuple: unknown,
		): Promise<boolean> => {
			if (!proof || typeof proof !== "object" || Array.isArray(proof))
				return false;
			const hash = (proof as Record<string, unknown>).hash;
			if (typeof hash !== "string") return false;
			for (const store of [approvalStores.project, approvalStores.user]) {
				const record = await store.find(hash);
				if (record && approvalMatches(record, proof, tuple)) {
					return store.isApproved(
						hash,
						record.tuple as WorkflowApprovalPreview,
					);
				}
			}
			return false;
		};
		const host = createWorkflowHost({
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			resolveAgent: (name) => ({
				name: name ?? "workflow",
				description: `Workflow agent ${name ?? "workflow"}`,
				systemPrompt:
					"Complete the workflow assignment and return the requested structured result.",
				source: "project",
			}),
			supportsIsolation: async (isolation) =>
				isolation.mode === "none" ||
				(await currentGitHead(ctx.cwd)) !== undefined,
			currentIntegrationHead: () => currentGitHead(ctx.cwd),
			captureChanges: async (metadata) => {
				if (!metadata || typeof metadata !== "object")
					throw new Error("Isolation capture metadata unavailable");
				const value = metadata as Record<string, unknown>;
				if (
					typeof value.cwd !== "string" ||
					typeof value.artifactDir !== "string" ||
					typeof value.childId !== "string"
				)
					throw new Error("Isolation capture metadata invalid");
				return captureGitChanges(value.cwd, value.artifactDir, value.childId);
			},
			applyPatch: async (patch, metadata) => {
				if (
					typeof patch !== "string" ||
					!metadata ||
					typeof metadata !== "object"
				)
					throw new Error("Isolation apply metadata unavailable");
				const value = metadata as Record<string, unknown>;
				if (
					typeof value.artifactDir !== "string" ||
					typeof value.runId !== "string" ||
					typeof value.baseHead !== "string"
				)
					throw new Error("Isolation apply metadata invalid");
				return applyGitPatch(
					ctx.cwd,
					value.artifactDir,
					value.runId,
					patch,
					value.baseHead,
				);
			},
		});
		const controller = new WorkflowController(host, {
			cwd: ctx.cwd,
			validateApproval,
			resolveToolset: (name) => resolveToolset(pi, name),
			resolveDefinition: async (run) => {
				const hash = run.approval?.hash;
				let sourcePath = run.definition.sourcePath;
				if (
					!sourcePath &&
					run.approval?.tuple &&
					typeof run.approval.tuple === "object"
				) {
					const source = (run.approval.tuple as Record<string, unknown>).source;
					if (
						source &&
						typeof source === "object" &&
						typeof (source as Record<string, unknown>).path === "string"
					)
						sourcePath = (source as Record<string, unknown>).path as string;
				}
				for (const store of [approvalStores.project, approvalStores.user]) {
					const record = hash ? await store.find(hash) : undefined;
					if (record && record.sourcePath === sourcePath && sourcePath) {
						try {
							return await loadApprovedWorkflow(sourcePath, record);
						} catch {
							return undefined;
						}
					}
				}
				return undefined;
			},
		});
		const definitions: OperatorDefinitions = {
			discover: async () => {
				const found = await discoverWorkflows({
					projectDir: ctx.cwd,
					pluginDirs: pluginDirs(ctx),
				});
				return found.map((item) => ({
					name: item.definition.name,
					path: item.source.path,
					definition: item.definition,
				}));
			},
			completionNames: () => [],
			load: async (nameOrPath, requestedScope, argsOrScope, commandCtx) => {
				const args =
					argsOrScope &&
					typeof argsOrScope === "object" &&
					!Array.isArray(argsOrScope)
						? argsOrScope
						: {};
				const trustScope: "project" | "user" =
					requestedScope === "user" ? "user" : "project";
				const found = (
					await discoverWorkflows({
						projectDir: ctx.cwd,
						pluginDirs: pluginDirs(ctx),
					})
				).find(
					(item) =>
						item.definition.name === nameOrPath ||
						item.source.path === nameOrPath,
				);
				if (!found) throw new Error(`workflow not found: ${nameOrPath}`);
				const source = await readFile(found.source.path, "utf8");
				const model = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: undefined;
				const preview = createApprovalPreview(source, found.definition, args, {
					model,
					toolset: pi.getActiveTools(),
					pluginSource: found.source.plugin,
					runtimeVersion: PLUGIN_VERSION,
					source: found.source,
					filesystem: [workflowScopePath(trustScope, ctx.cwd)],
				});
				const approvalStores = stores(ctx.cwd);
				let approval: WorkflowApprovalRecord | undefined;
				for (const store of [approvalStores.project, approvalStores.user]) {
					if (await store.verify(preview)) {
						approval = await store.find(preview.hash);
						break;
					}
				}
				if (!approval) {
					if (!commandCtx?.hasUI)
						throw new Error("workflow approval requires interactive UI");
					const confirmed = await commandCtx.ui.confirm(
						APPROVAL_CONFIRM_TITLE,
						formatApprovalMessage(preview, mode),
					);
					if (!confirmed) throw new Error("workflow execution declined");
					approval = await approvalStores[trustScope].approve(
						preview,
						trustScope,
						found.source.path,
					);
				}
				if (!approval)
					throw new Error("workflow approval proof is unavailable");
				const definition = await loadApprovedWorkflow(
					found.source.path,
					approval,
				);
				return { name: definition.name, definition, approval };
			},
			generate: async (request) => {
				pi.sendUserMessage(
					`Author a workflow for this request:\\n${request}\\n\\n${authoringGuidance}\\nAfter authoring, call the essential workflow_stage tool with the complete source, args, and project or user scope for explicit approval.`,
				);
				return { queued: true };
			},
			create: async (request) => {
				pi.sendUserMessage(
					`Create a workflow for this request:\\n${request}\\n\\n${authoringGuidance}\\nAfter authoring, call the essential workflow_stage tool with the complete source, args, and project or user scope for explicit approval.`,
				);
				return { queued: true };
			},
			save: async (run, targetScope) => {
				if (targetScope !== "project" && targetScope !== "user")
					throw new Error("plugin workflows are read-only");
				if (!run || typeof run !== "object")
					throw new Error("invalid workflow run");
				const approvalInfo = (run as Record<string, unknown>).approval;
				if (!approvalInfo || typeof approvalInfo !== "object")
					throw new Error("run has no approval proof");
				const hash = (approvalInfo as Record<string, unknown>).hash;
				if (typeof hash !== "string")
					throw new Error("run approval proof is malformed");
				const approvalStores = stores(ctx.cwd);
				for (const store of [approvalStores.project, approvalStores.user]) {
					const record = await store.find(hash);
					if (!record || !record.tuple || typeof record.tuple !== "object")
						continue;
					const preview = record.tuple as WorkflowApprovalPreview;
					const target = await store.saveApproved(
						preview,
						workflowScopePath(targetScope, ctx.cwd),
					);
					const targetFound = await discoverWorkflowFile(target, targetScope);
					if (!targetFound)
						throw new Error("saved workflow metadata could not be discovered");
					const targetPreview = createApprovalPreview(
						preview.rawSource,
						targetFound.definition,
						preview.args,
						{
							...preview,
							source: { path: target, scope: targetScope },
						},
					);
					await approvalStores[targetScope].approve(
						targetPreview,
						targetScope,
						target,
					);
					return target;
				}
				throw new Error(
					"approval proof is not present in project or user stores",
				);
			},
			revoke: async (hash) => {
				await Promise.all([
					approvalStores.project.revoke(hash),
					approvalStores.user.revoke(hash),
				]);
				return { revoked: hash };
			},
			probe: async () =>
				runWorkflowProbe({ cwd: ctx.cwd, modelRegistry: ctx.modelRegistry }),
		};
		definitions.completionNames = () => [];
		const found = await definitions.discover();
		const workflows = found.map((item) => {
			const definition =
				item.definition && typeof item.definition === "object"
					? (item.definition as { version?: unknown })
					: undefined;
			return {
				name: item.name,
				version:
					typeof definition?.version === "number"
						? definition.version
						: undefined,
			};
		});
		definitions.completionNames = () =>
			state.current?.workflows.map((item) => item.name) ??
			workflows.map((item) => item.name);
		const session: SessionState = {
			ctx,
			controller,
			definitions,
			mode,
			warnings,
			styler,
			workflows,
		};
		state.current = session;
		session.unsubscribe = controller.subscribe(() => {
			void refreshWidget(session);
		});
		await controller.initialize();
		await refreshWidget(session);
		authoringOptions.onSaved = async () => {
			const current = state.current;
			if (!current) return;
			const discovered = await current.definitions.discover();
			current.workflows = discovered.map((item) => {
				const definition =
					item.definition && typeof item.definition === "object"
						? (item.definition as { version?: unknown })
						: undefined;
				return {
					name: item.name,
					version:
						typeof definition?.version === "number"
							? definition.version
							: undefined,
				};
			});
			await refreshWidget(current);
		};
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const session = state.current;
		if (!session) return;
		await pauseRunning(session);
		session.unsubscribe?.();
		session.unsubscribe = undefined;
		clearWidget(ctx);
		await session.controller.dispose();
		state.current = undefined;
	});
}
