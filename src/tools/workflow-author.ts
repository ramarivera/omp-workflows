import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { discoverWorkflowFile } from "../definition/discovery.js";
import { authoringGuidance, generateStaged } from "../generation/index.js";
import {
	workflowApprovalPath,
	workflowScopePath,
	workflowStagingRoot,
} from "../storage/paths.js";
import {
	APPROVAL_CONFIRM_TITLE,
	ApprovalStore,
	createApprovalPreview,
	formatApprovalMessage,
} from "../ui/approval.js";
import { DEFAULT_UI_MODE, type WorkflowUiMode } from "../ui/mode.js";
import { PLUGIN_VERSION } from "../version.js";

export interface WorkflowAuthoringOptions {
	cwd: string;
	projectStore?: ApprovalStore;
	userStore?: ApprovalStore;
	mode?: () => WorkflowUiMode;
	onSaved?: () => Promise<void> | void;
}

function stores(options: WorkflowAuthoringOptions): {
	project: ApprovalStore;
	user: ApprovalStore;
} {
	return {
		project:
			options.projectStore ??
			new ApprovalStore(workflowApprovalPath("project", options.cwd)),
		user:
			options.userStore ??
			new ApprovalStore(workflowApprovalPath("user", options.cwd)),
	};
}

export function registerWorkflowAuthoringTool(
	pi: ExtensionAPI,
	options: WorkflowAuthoringOptions,
): void {
	const Type = pi.typebox.Type;
	const anySchema =
		typeof Type.Any === "function" ? Type.Any() : Type.Object({});
	const scopeSchema = Type.Union([
		Type.Literal("project"),
		Type.Literal("user"),
	]);
	pi.registerTool({
		name: "workflow_stage",
		label: "Stage workflow",
		description:
			'Stage a complete TypeScript workflow for explicit approval. Source must import defineWorkflow from @ramarivera/omp-workflows and export `workflow = defineWorkflow({ name, version, args, limits, async run({ args, agent, parallel, pipeline, phase }) { ... } })`. Agent calls require stable `id`, prompt, agent/model/effort/toolset/isolation/apply, JSON `schema`, and `schemaMode: "strict"`. No shell/filesystem/network imports or invented DSL functions. Shows the full source and exact approval hash before saving.',
		loadMode: "essential",
		approval: "write",
		parameters: Type.Object({
			source: Type.String(),
			args: Type.Optional(anySchema),
			scope: scopeSchema,
		}),
		execute: async (
			_toolCallId: string,
			rawParams: unknown,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			if (!ctx.hasUI)
				return failure(
					"workflow_stage requires interactive approval; print and RPC modes fail closed",
				);
			if (!rawParams || typeof rawParams !== "object")
				return failure("workflow_stage input must be an object");
			const params = rawParams as {
				source?: unknown;
				args?: unknown;
				scope?: unknown;
			};
			if (
				typeof params.source !== "string" ||
				(params.scope !== "project" && params.scope !== "user")
			) {
				return failure(
					"workflow_stage requires source, args, and project or user scope",
				);
			}
			const scope = params.scope as "project" | "user";
			const source = await generateStaged(
				"stage the supplied workflow source",
				{ generate: async () => params.source as string },
				workflowStagingRoot(options.cwd),
			);
			const discovered = await discoverWorkflowFile(source.path, "project");
			if (!discovered)
				return failure(
					"staged source has no statically discoverable workflow metadata",
				);
			const preview = createApprovalPreview(
				source.source,
				discovered.definition,
				params.args ?? {},
				{
					source: { path: source.path, scope: "project" },
					runtimeVersion: PLUGIN_VERSION,
					filesystem: [workflowScopePath(scope, options.cwd)],
				},
			);
			const message = `${formatApprovalMessage(preview, options.mode?.() ?? DEFAULT_UI_MODE)}\n\n${authoringGuidance}`;
			if (!(await ctx.ui.confirm(APPROVAL_CONFIRM_TITLE, message))) {
				return failure("workflow staging declined");
			}
			const selectedStore = stores(options)[scope];
			const stagedApproval = await selectedStore.approve(
				preview,
				scope,
				source.path,
			);
			const targetDir = workflowScopePath(scope, options.cwd);
			const target = await selectedStore.saveApproved(preview, targetDir);
			const targetSource = await discoverWorkflowFile(target, scope);
			if (!targetSource)
				throw new Error(
					"saved workflow has no statically discoverable metadata",
				);
			const targetPreview = createApprovalPreview(
				source.source,
				targetSource.definition,
				params.args ?? {},
				{
					source: { path: target, scope },
					runtimeVersion: preview.versions.runtime,
					filesystem: preview.filesystem,
				},
			);
			const targetApproval = await selectedStore.approve(
				targetPreview,
				scope,
				target,
			);
			await selectedStore.revoke(stagedApproval.hash);
			await options.onSaved?.();
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ target, hash: targetApproval.hash }),
					},
				],
			};
		},
	});
}

export const registerWorkflowStageTool = registerWorkflowAuthoringTool;

function failure(message: string) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify({ error: message }) },
		],
		isError: true as const,
	};
}
