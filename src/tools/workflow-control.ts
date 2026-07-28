import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	OperatorController,
	OperatorDefinitions,
} from "../commands/operator.js";
import type { WorkflowScope } from "../commands/parser.js";

const ACTIONS = [
	"list",
	"start",
	"status",
	"pause",
	"resume",
	"stop",
	"retry",
] as const;
export function registerWorkflowControlTool(
	pi: ExtensionAPI,
	controller: OperatorController,
	definitions?: OperatorDefinitions,
): void {
	pi.registerTool({
		name: "workflow_control",
		label: "Workflow control",
		description: "List and control durable workflow runs.",
		parameters: pi.typebox.Type.Object({
			action: pi.typebox.Type.Union(
				ACTIONS.map((x) => pi.typebox.Type.Literal(x)),
			),
			workflow: pi.typebox.Type.Optional(pi.typebox.Type.String()),
			args: pi.typebox.Type.Optional(pi.typebox.Type.Object({})),
			scope: pi.typebox.Type.Optional(
				pi.typebox.Type.Union([
					pi.typebox.Type.Literal("project"),
					pi.typebox.Type.Literal("user"),
					pi.typebox.Type.Literal("plugin"),
				]),
			),
			runId: pi.typebox.Type.Optional(pi.typebox.Type.String()),
			callIndex: pi.typebox.Type.Optional(pi.typebox.Type.Number()),
		}),
		execute: async (
			_id: string,
			rawParams: unknown,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) => {
			if (
				!rawParams ||
				typeof rawParams !== "object" ||
				!("action" in rawParams) ||
				typeof rawParams.action !== "string"
			)
				return fail("invalid_input", "action is required", ["list", "start"]);
			const params = rawParams as {
				action: string;
				workflow?: string;
				args?: Record<string, unknown>;
				scope?: WorkflowScope;
				runId?: string;
				callIndex?: number;
			};
			const allowedActions = params.runId
				? ["start", "status", "pause", "resume", "stop", "retry"]
				: ["list", "start"];
			if (!ACTIONS.includes(params.action as (typeof ACTIONS)[number]))
				return fail(
					"invalid_action",
					`unknown action: ${params.action}`,
					allowedActions,
				);
			if (params.action === "list") return ok(await controller.list());
			if (params.action === "start") {
				if (!params.workflow)
					return fail(
						"workflow_required",
						"workflow name or path is required",
						allowedActions,
					);
				try {
					if (!definitions?.load)
						return fail(
							"workflow_not_found",
							`workflow not found: ${params.workflow}`,
							allowedActions,
						);
					const loaded = await definitions.load(
						params.workflow,
						params.scope,
						params.args ?? {},
						ctx as Parameters<NonNullable<OperatorDefinitions["load"]>>[3],
					);
					if (!loaded)
						return fail(
							"workflow_not_found",
							`workflow not found: ${params.workflow}`,
							allowedActions,
						);
					return ok(
						await controller.start(
							loaded.definition,
							params.args ?? {},
							loaded.approval,
						),
					);
				} catch (error) {
					const e = error as {
						code?: string;
						allowedActions?: string[];
						message?: string;
					};
					return fail(
						e.code ?? "workflow_control_failed",
						e.message ?? String(error),
						e.allowedActions ?? allowedActions,
					);
				}
			}
			if (!params.runId)
				return fail(
					"runId_required",
					"runId is required for this action",
					allowedActions,
				);
			if (!ACTIONS.includes(params.action as (typeof ACTIONS)[number]))
				return fail(
					"invalid_action",
					`unknown action: ${params.action}`,
					allowedActions,
				);
			if (params.action === "list") return ok(await controller.list());
			if (!params.runId)
				return fail(
					"runId_required",
					"runId is required for this action",
					allowedActions,
				);
			try {
				const value =
					params.action === "status"
						? await controller.inspect(params.runId)
						: params.action === "pause"
							? await controller.pause(params.runId)
							: params.action === "resume"
								? await controller.resume(params.runId)
								: params.action === "stop"
									? await controller.stop(params.runId)
									: await controller.retry(params.runId, params.callIndex);
				return ok(value ?? null);
			} catch (error) {
				const e = error as {
					code?: string;
					allowedActions?: string[];
					message?: string;
				};
				return fail(
					e.code ?? "workflow_control_failed",
					e.message ?? String(error),
					e.allowedActions ?? [],
				);
			}
		},
	});
}
function ok(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fail(error: string, message: string, allowedActions: string[]) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ error, message, allowedActions }),
			},
		],
		isError: true as const,
	};
}
