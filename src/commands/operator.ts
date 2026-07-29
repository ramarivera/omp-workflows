import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import type { WorkflowRun } from "../runtime/types.js";
import { DEFAULT_UI_MODE, type WorkflowUiMode } from "../ui/mode.js";
import {
	type RenderStatusOptions,
	renderEmptyState,
	renderWorkflowRun,
} from "../ui/status.js";
import {
	parseWorkflowArgs,
	WORKFLOW_COMMANDS,
	type WorkflowScope,
} from "./parser.js";

export interface OperatorController {
	start(
		definition: unknown,
		args: unknown,
		approval?: unknown,
	): Promise<unknown>;
	list(): Promise<unknown[]>;
	inspect(id: string): Promise<unknown | undefined>;
	pause(id: string): Promise<unknown>;
	resume(id: string): Promise<unknown>;
	stop(id: string): Promise<unknown>;
	retry(id: string, callIndex?: number): Promise<unknown>;
	subscribe?(listener: (event: unknown) => void): () => void;
	restore?(): Promise<unknown[]>;
	initialize?(): Promise<unknown[]>;
	dispose?(): Promise<void>;
}
export interface OperatorDefinitions {
	discover(): Promise<
		Array<{ name: string; path?: string; definition?: unknown }>
	>;
	completionNames?(): string[];
	load?(
		nameOrPath: string,
		scope?: WorkflowScope,
		args?: unknown,
		ctx?: ExtensionCommandContext,
	): Promise<{ name: string; definition: unknown; approval?: unknown }>;
	create?(request: string, ctx?: ExtensionCommandContext): Promise<unknown>;
	generate?(request: string, ctx?: ExtensionCommandContext): Promise<unknown>;
	save?(
		run: unknown,
		scope: WorkflowScope,
		ctx?: ExtensionCommandContext,
	): Promise<unknown>;
	revoke?(id: string): Promise<unknown>;
	probe?(): Promise<unknown>;
}
export interface RegisterWorkflowCommandsOptions {
	/** UI mode for slash-command result and error copy. Defaults to operator. */
	mode?: WorkflowUiMode;
	/** Width budget for dashboard mode cards. Defaults to 78 columns. */
	maxWidth?: number;
	/** Optional resolver used to refresh mode at command time. Overrides `mode`. */
	getMode?: () => WorkflowUiMode;
	/** Dynamic presentation options, including OMP styling and discovered workflows. */
	getRenderOptions?: () => RenderStatusOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
	if (!isPlainObject(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.status === "string" &&
		typeof record.namespace === "string" &&
		record.totals !== undefined &&
		typeof record.totals === "object"
	);
}

/**
 * Format a "success" command message into the requested UI mode.
 *  - operator (default): one-line summary per run; JSON fallback keeps the
 *    original payload recoverable for engineers inspecting transcripts.
 *  - dashboard: framed card per run; otherwise identical semantics.
 */
function formatSuccess(
	value: unknown,
	command: string,
	mode: WorkflowUiMode,
	options: RenderStatusOptions,
): string {
	if (value === undefined || value === null) {
		return `/workflow ${command}: ok`;
	}
	if (Array.isArray(value)) {
		const runs: WorkflowRun[] = [];
		for (const item of value) {
			if (!isWorkflowRun(item)) return fallbackPayload(command, value);
			runs.push(item);
		}
		return runs.length === 0
			? renderEmptyState(mode, options)
			: runs.map((run) => renderWorkflowRun(run, mode, options)).join("\n\n");
	}
	if (isWorkflowRun(value)) {
		return renderWorkflowRun(value, mode, options);
	}
	return fallbackPayload(command, value);
}

function fallbackPayload(command: string, value: unknown): string {
	return `/workflow ${command}: ok · payload below\n${JSON.stringify(value, null, 2)}`;
}

/**
 * Format a thrown error (or string) into a mode-aware user-facing line.
 * The original message is preserved verbatim so the operator can search
 * transcripts; the prefix indicates the failing command for clarity.
 */
function formatError(
	error: unknown,
	command: string,
	mode: WorkflowUiMode,
): string {
	const message = error instanceof Error ? error.message : String(error);
	if (mode === "dashboard") {
		return `┌─ /workflow ${command} failed ──────────────────────┐\n│ ${message}\n└──────────────────────────────────────────────────┘`;
	}
	return `/workflow ${command}: ${message}`;
}

export function registerWorkflowCommands(
	pi: ExtensionAPI,
	controller: OperatorController,
	definitions: OperatorDefinitions,
	options: RegisterWorkflowCommandsOptions = {},
): void {
	const resolveMode =
		options.getMode ?? (() => options.mode ?? DEFAULT_UI_MODE);
	const resolveRenderOptions =
		options.getRenderOptions ??
		((): RenderStatusOptions => ({ maxWidth: options.maxWidth }));
	pi.registerCommand("workflow", {
		description: "Create, run, inspect, and control durable workflows",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trim().split(/\s+/);
			if (parts.length <= 1) {
				return WORKFLOW_COMMANDS.filter((x) =>
					x.startsWith(parts[0] ?? ""),
				).map((value) => ({ value, label: value, description: value }));
			}
			const command = parts[0] === "run" ? "start" : parts[0];
			if (command === "start") {
				const needle = parts.at(-1) ?? "";
				return (definitions.completionNames?.() ?? [])
					.filter((name) => name.startsWith(needle))
					.map((value) => ({
						value,
						label: value,
						description: "discovered workflow",
					}));
			}
			return null;
		},
		handler: async (raw, ctx) => {
			const mode = resolveMode();
			const renderOptions = resolveRenderOptions();
			try {
				await handleWorkflow(
					raw,
					ctx,
					controller,
					definitions,
					pi,
					mode,
					renderOptions,
				);
			} catch (error) {
				const parsed = safeParse(raw);
				const command = parsed?.command ?? "workflow";
				pi.sendMessage(
					{
						customType: "workflow_error",
						content: [
							{ type: "text", text: formatError(error, command, mode) },
						],
					},
					{ deliverAs: "nextTurn" },
				);
			}
		},
	});
}

function safeParse(raw: string): { command: string } | undefined {
	try {
		return parseWorkflowArgs(raw);
	} catch {
		return undefined;
	}
}

async function handleWorkflow(
	raw: string,
	ctx: ExtensionCommandContext,
	controller: OperatorController,
	defs: OperatorDefinitions,
	pi: ExtensionAPI,
	mode: WorkflowUiMode,
	renderOptions: RenderStatusOptions,
): Promise<void> {
	const parsed = parseWorkflowArgs(raw);
	const [target, extra] = parsed.positionals;
	let result: unknown;
	switch (parsed.command) {
		case "help":
			result = { commands: WORKFLOW_COMMANDS };
			break;
		case "list":
			result = await controller.list();
			break;
		case "status":
			result = target
				? await controller.inspect(target)
				: await controller.list();
			break;
		case "inspect":
			if (!target) throw new Error("/workflow inspect requires run-id");
			result = await controller.inspect(target);
			break;
		case "pause":
		case "resume":
		case "stop":
			if (!target)
				throw new Error(`/workflow ${parsed.command} requires run-id`);
			result = await controller[parsed.command](target);
			break;
		case "retry":
			if (!target) throw new Error("/workflow retry requires run-id");
			if (extra !== undefined && !/^\d+$/.test(extra))
				throw new Error("retry call-index must be an integer");
			result = await controller.retry(
				target,
				extra === undefined ? undefined : Number(extra),
			);
			break;
		case "revoke":
			if (!target) throw new Error("/workflow revoke requires approval-id");
			if (!defs.revoke) throw new Error("approval revocation is unavailable");
			result = await defs.revoke(target);
			break;
		case "approve": {
			if (!target)
				throw new Error("/workflow approve requires workflow name or path");
			const load = defs.load;
			if (!load) throw new Error(`workflow not found: ${target}`);
			const loaded = await load(target, parsed.scope, parsed.args ?? {}, ctx);
			if (!loaded) throw new Error(`workflow not found: ${target}`);
			result = { name: loaded.name, approved: true, approval: loaded.approval };
			break;
		}
		case "generate":
		case "create": {
			if (!target)
				throw new Error(`/workflow ${parsed.command} requires a request`);
			const fn = defs.generate ?? defs.create;
			if (!fn) throw new Error("workflow authoring is unavailable");
			result = await fn(parsed.positionals.join(" "), ctx);
			break;
		}
		case "save": {
			if (!target) throw new Error("/workflow save requires run-id");
			const run = await controller.inspect(target);
			if (!run) throw new Error(`run not found: ${target}`);
			if (!defs.save) throw new Error("workflow saving is unavailable");
			result = await defs.save(run, parsed.scope ?? "project", ctx);
			break;
		}
		case "probe":
			result = await defs.probe?.();
			break;
		case "start": {
			if (!target)
				throw new Error("/workflow start requires workflow name or path");
			const load = defs.load;
			if (!load) throw new Error(`workflow not found: ${target}`);
			const loaded = await load(target, parsed.scope, parsed.args ?? {}, ctx);
			if (!loaded) throw new Error(`workflow not found: ${target}`);
			result = await controller.start(
				loaded.definition,
				parsed.args ?? {},
				loaded.approval,
			);
			break;
		}
	}
	pi.sendMessage(
		{
			customType: "workflow_result",
			content: [
				{
					type: "text",
					text: formatSuccess(result, parsed.command, mode, renderOptions),
				},
			],
		},
		{ deliverAs: "nextTurn" },
	);
}
