/**
 * Status renderers for the OMP workflows extension.
 *
 * Two presentation styles live here:
 *  - `summarizeWorkflow(run)` — single-line compact plain text used by the
 *    operator collection view and by machine-watch tools. Intentionally
 *    ANSI-free.
 *  - `renderWorkflowRun(run, mode, options)` — multi-line run card (operator)
 *    or framed Unicode card (dashboard), with semantic styling.
 *  - `renderWorkflowStatus(runs, mode, options)` — collection render.
 *
 * The renderers accept an injectable `SemanticStyler` so tests can use the
 * identity styler and runtime can inject the OMP theme. Width handling is
 * based on visible width (ANSI stripped), never raw string length.
 */

import type {
	WorkflowAttemptStatus,
	WorkflowCall,
	WorkflowCallStatus,
	WorkflowRun,
	WorkflowRunStatus,
} from "../runtime/types.js";
import { DEFAULT_UI_MODE, type WorkflowUiMode } from "./mode.js";
import { createIdentityStyler, type SemanticStyler } from "./style.js";

export interface RenderStatusOptions {
	/**
	 * Maximum column width used by dashboard card line-wrapping. Defaults to
	 * 78 columns. Operator mode is unaffected by this knob.
	 */
	maxWidth?: number;
	/** When false, the empty-state copy is omitted when there are no runs. */
	includeEmptyState?: boolean;
	/** Optional semantic styler; defaults to identity for deterministic tests. */
	styler?: SemanticStyler;
	/**
	 * Workflow definitions known to the extension. Used to build lifecycle-aware
	 * empty states: no definitions points to `/workflow generate`, while
	 * definitions present lists startable workflows.
	 */
	availableWorkflows?: ReadonlyArray<{ name: string; version?: number }>;
}

const DEFAULT_MAX_WIDTH = 78;

const ANSI_PATTERN = new RegExp(
	`${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
	"g",
);

/** Visible width of a string that may contain ANSI escapes. */
function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function countByStatus<T extends { status: string }>(
	items: readonly T[] | undefined,
): Record<string, number> {
	const counts: Record<string, number> = {};
	if (!items) return counts;
	for (const item of items) {
		counts[item.status] = (counts[item.status] ?? 0) + 1;
	}
	return counts;
}

function formatTokens(value: number | undefined): string {
	if (value === undefined || value === null) return "?";
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) {
		const scaled = value / 1_000;
		return `${scaled.toFixed(scaled < 10 ? 1 : 0).replace(/\.0$/, "")}k`;
	}
	const scaled = value / 1_000_000;
	return `${scaled.toFixed(scaled < 10 ? 1 : 0).replace(/\.0$/, "")}M`;
}

function formatMilliseconds(value: number | undefined): string {
	if (value === undefined || value === null) return "?";
	if (value < 1_000) return `${value}ms`;
	if (value < 60_000) {
		const seconds = value / 1_000;
		return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
	}
	if (value < 3_600_000)
		return `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1_000)}s`;
	return `${Math.floor(value / 3_600_000)}h ${Math.floor((value % 3_600_000) / 60_000)}m`;
}

function formatLimit(
	value: number | undefined,
	fallback: string = "∞",
): string {
	if (value === undefined || value === null) return fallback;
	return String(value);
}

function repeatChar(char: string, length: number): string {
	return char.repeat(Math.max(0, length));
}

const STATUS_GLYPHS: Record<WorkflowCallStatus, string> = {
	queued: "·",
	dispatched: "→",
	running: "▶",
	cached: "✓·",
	succeeded: "✓",
	failed: "✗",
	cancelled: "◌",
	unknown: "?",
};

const RUN_STATUS_GLYPHS: Record<WorkflowRunStatus, string> = {
	planned: "·",
	awaiting_approval: "?",
	running: "▶",
	pausing: "▼",
	paused: "‖",
	completed: "✓",
	failed: "✗",
	cancelled: "◌",
	persistence_degraded: "!",
};

type SemanticColorKey =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text";

const RUN_STATUS_STYLES: Record<WorkflowRunStatus, SemanticColorKey> = {
	planned: "dim",
	awaiting_approval: "warning",
	running: "accent",
	pausing: "warning",
	paused: "warning",
	completed: "success",
	failed: "error",
	cancelled: "warning",
	persistence_degraded: "error",
};

function styleForColor(
	styler: SemanticStyler,
	color: SemanticColorKey,
): (text: string) => string {
	switch (color) {
		case "accent":
			return styler.accent;
		case "success":
			return styler.success;
		case "warning":
			return styler.warning;
		case "error":
			return styler.error;
		case "muted":
			return styler.muted;
		case "dim":
			return styler.dim;
		case "text":
			return styler.text;
	}
}

function runStatusStyle(
	styler: SemanticStyler,
	status: WorkflowRunStatus,
): (text: string) => string {
	return styleForColor(styler, RUN_STATUS_STYLES[status] ?? "text");
}

function resolveStyler(options: RenderStatusOptions): SemanticStyler {
	return options.styler ?? createIdentityStyler();
}

function runWarnings(run: WorkflowRun): string[] {
	const warnings: string[] = [];
	if (run.persistenceHealth === "degraded")
		warnings.push("persistence degraded — inspect storage before retrying");
	if (run.blockedReason)
		warnings.push(`blocked: ${run.blockedReason} — resolve before resuming`);
	if (
		run.limits.maxAgents !== undefined &&
		run.totals.agents > run.limits.maxAgents
	)
		warnings.push("agent limit exceeded — reduce fan-out or raise maxAgents");
	return warnings;
}

export function summarizeWorkflow(run: WorkflowRun): string {
	const counts = countByStatus(run.calls);
	const warnings = runWarnings(run);
	return `${run.id} ${run.status} · ${run.definition.name}@${run.definition.version} | phases=${run.phases?.length ?? 0} calls=${run.calls?.length ?? 0} queued=${counts.queued ?? 0} dispatched=${counts.dispatched ?? 0} running=${counts.running ?? 0} succeeded=${counts.succeeded ?? 0} failed=${counts.failed ?? 0} totals=agents:${run.totals?.agents ?? 0},tokens:${formatTokens(run.totals?.outputTokens)},runtime:${formatMilliseconds(run.totals?.runtimeMs)} limits=concurrency:${formatLimit(run.limits?.maxConcurrency)},agents:${formatLimit(run.limits?.maxAgents)}${warnings.length ? ` warning: ${warnings.join("; ")}` : ""}`;
}

type LinePart = {
	text: string;
	style?: (text: string) => string;
};

/** Render plain-text parts through optional style functions, truncating the last
 *  part with an ellipsis if the total would exceed `maxVisible`. */
function renderParts(
	parts: LinePart[],
	styler: SemanticStyler,
	maxVisible: number,
): string {
	let used = 0;
	let out = "";
	for (let i = 0; i < parts.length; i++) {
		const { text, style } = parts[i];
		const apply = style ?? styler.text;
		const width = visibleWidth(text);
		if (used + width > maxVisible) {
			const remaining = Math.max(0, maxVisible - used - 1);
			const keep = text.slice(0, remaining);
			out += apply(`${keep}…`);
			break;
		}
		out += apply(text);
		used += width;
	}
	return out;
}

interface BoxLineOptions {
	prefix: string;
	parts: LinePart[];
	fill: string;
	suffix: string;
	styler: SemanticStyler;
	maxWidth: number;
	minFill?: number;
}

/** Build a framed dashboard line with width-aware fill and truncation. */
function buildBoxLine({
	prefix,
	parts,
	fill,
	suffix,
	styler,
	maxWidth,
	minFill = 0,
}: BoxLineOptions): string {
	const prefixW = visibleWidth(prefix);
	const suffixW = visibleWidth(suffix);
	const budget = Math.max(0, maxWidth - prefixW - suffixW - minFill);
	const content = renderParts(parts, styler, budget);
	const contentW = visibleWidth(content);
	const fillLen = Math.max(minFill, maxWidth - prefixW - contentW - suffixW);
	return (
		styler.dim(prefix) +
		content +
		styler.dim(repeatChar(fill, fillLen)) +
		styler.dim(suffix)
	);
}

function progressBar(fraction: number, width = 20): string {
	if (!Number.isFinite(fraction)) return "░".repeat(width);
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	const empty = width - filled;
	return "▓".repeat(filled) + "░".repeat(empty);
}

function formatOperatorStatusCounts(
	counts: Record<string, number>,
	styler: SemanticStyler,
): string {
	return [
		`${styler.dim("queued")} ${counts.queued ?? 0}`,
		`${styler.dim("dispatched")} ${counts.dispatched ?? 0}`,
		`${styler.dim("running")} ${counts.running ?? 0}`,
		`${styler.dim("succeeded")} ${counts.succeeded ?? 0}`,
		`${styler.dim("failed")} ${counts.failed ?? 0}`,
	].join(" · ");
}

function formatOperatorLimits(
	limits: {
		maxConcurrency?: number;
		maxAgents?: number;
		maxOutputTokens?: number;
		maxRuntimeMs?: number;
	},
	styler: SemanticStyler,
): string {
	return [
		`${styler.dim("concurrency")} ${formatLimit(limits?.maxConcurrency)}`,
		`${styler.dim("agents")} ${formatLimit(limits?.maxAgents)}`,
		`${styler.dim("tokens")} ${limits?.maxOutputTokens === undefined ? "—" : formatTokens(limits.maxOutputTokens)}`,
		`${styler.dim("runtime")} ${limits?.maxRuntimeMs === undefined ? "—" : formatMilliseconds(limits.maxRuntimeMs)}`,
	].join(" · ");
}

function buildOperatorRunCard(
	run: WorkflowRun,
	options: RenderStatusOptions,
): string {
	const styler = resolveStyler(options);
	const counts = countByStatus(run.calls);
	const total = run.calls?.length ?? 0;
	const completed = (counts.succeeded ?? 0) + (counts.failed ?? 0);
	const phase = run.phases?.at(-1) ?? "(no phase)";
	const warnings = runWarnings(run);
	const glyph = RUN_STATUS_GLYPHS[run.status] ?? "·";
	const statusStyle = runStatusStyle(styler, run.status);
	const identity = `${run.definition.name}@${run.definition.version}`;

	const lines = [
		`${styler.dim(glyph)} ${styler.text(run.id)}  ${statusStyle(run.status)} · ${styler.rainbow(identity)} · ${styler.rainbow(phase)}`,
		`  phase: ${styler.rainbow(phase)} · calls ${completed}/${total} · agents ${run.totals?.agents ?? 0}`,
		`  tokens ${formatTokens(run.totals?.outputTokens)} · runtime ${formatMilliseconds(run.totals?.runtimeMs)}`,
		`  ${formatOperatorStatusCounts(counts, styler)}`,
		`  limits: ${formatOperatorLimits(run.limits, styler)}`,
	];

	if (warnings.length > 0) {
		lines.push(
			`${styler.dim("└── ")}${styler.warning(`⚠ ${warnings.join("; ")}`)}`,
		);
	} else {
		lines.push(`${styler.dim("└── ")}${styler.success("ok")}`);
	}

	return lines.join("\n");
}

function buildDashboardRunCard(
	run: WorkflowRun,
	options: RenderStatusOptions,
): string {
	const styler = resolveStyler(options);
	const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
	const counts = countByStatus(run.calls);
	const total = run.calls?.length ?? 0;
	const completed = (counts.succeeded ?? 0) + (counts.failed ?? 0);
	const fraction = total === 0 ? 0 : completed / total;
	const phase = run.phases?.at(-1) ?? "(no phase)";
	const bar = progressBar(fraction);
	const percent = `${Math.round(fraction * 100)}%`;
	const warnings = runWarnings(run);
	const glyph = RUN_STATUS_GLYPHS[run.status] ?? "·";
	const identity = `${run.definition.name}@${run.definition.version}`;

	const header = buildBoxLine({
		prefix: "┌─ ",
		parts: [
			{ text: `${glyph} `, style: styler.dim },
			{ text: run.id, style: styler.text },
			{ text: " · ", style: styler.dim },
			{ text: run.status, style: runStatusStyle(styler, run.status) },
			{ text: " · ", style: styler.dim },
			{ text: `${identity} `, style: styler.rainbow },
		],
		fill: "─",
		suffix: "┐",
		styler,
		maxWidth,
		minFill: 1,
	});

	const summaryText = `calls ${completed}/${total} · agents ${run.totals?.agents ?? 0} · tokens ${formatTokens(run.totals?.outputTokens)} · runtime ${formatMilliseconds(run.totals?.runtimeMs)}`;
	const summary = buildBoxLine({
		prefix: "│ ",
		parts: [
			{ text: phase, style: styler.rainbow },
			{ text: " · ", style: styler.dim },
			{ text: summaryText, style: styler.text },
		],
		fill: " ",
		suffix: "│",
		styler,
		maxWidth,
	});

	const progress = buildBoxLine({
		prefix: "│ ",
		parts: [
			{ text: bar, style: (text) => text },
			{ text: " ", style: styler.dim },
			{ text: percent, style: styler.accent },
			{ text: " · ", style: styler.dim },
			{ text: phase, style: styler.rainbow },
		],
		fill: " ",
		suffix: "│",
		styler,
		maxWidth,
	});

	const budgetText = `agents ${formatLimit(run.limits?.maxAgents, "∞")} · concurrency ${formatLimit(run.limits?.maxConcurrency, "∞")} · tokens ${run.limits?.maxOutputTokens === undefined ? "—" : formatTokens(run.limits.maxOutputTokens)} · runtime ${run.limits?.maxRuntimeMs === undefined ? "—" : formatMilliseconds(run.limits.maxRuntimeMs)}`;
	const budget = buildBoxLine({
		prefix: "│ budget ",
		parts: [{ text: budgetText, style: styler.text }],
		fill: " ",
		suffix: "│",
		styler,
		maxWidth,
	});

	const statusText = `queued ${counts.queued ?? 0} · dispatched ${counts.dispatched ?? 0} · running ${counts.running ?? 0} · succeeded ${counts.succeeded ?? 0} · failed ${counts.failed ?? 0}`;
	const statusLine = buildBoxLine({
		prefix: "│ status ",
		parts: [{ text: statusText, style: styler.text }],
		fill: " ",
		suffix: "│",
		styler,
		maxWidth,
	});

	const footer = buildBoxLine({
		prefix: "└─ ",
		parts: [
			{
				text: `⚠ ${warnings.join(" · ")}`,
				style: styler.warning,
			},
		],
		fill: "─",
		suffix: "┘",
		styler,
		maxWidth,
		minFill: 1,
	});

	const okFooter = buildBoxLine({
		prefix: "└",
		parts: [],
		fill: "─",
		suffix: "┘",
		styler,
		maxWidth,
	});

	return [
		header,
		summary,
		progress,
		budget,
		statusLine,
		warnings.length > 0 ? footer : okFooter,
	].join("\n");
}

export function renderWorkflowRun(
	run: WorkflowRun,
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
	options: RenderStatusOptions = {},
): string {
	if (mode === "dashboard") return buildDashboardRunCard(run, options);
	return buildOperatorRunCard(run, options);
}

export const EMPTY_OPERATOR_STATE =
	"No active workflow runs. Use /workflow start <name> to launch.";
export const EMPTY_DASHBOARD_STATE_LINES = [
	"┌─ omp-workflows · idle ──────────────────────────┐",
	"│ No active workflow runs.                       │",
	"│ Use /workflow start <name> --args '<json>'      │",
	"│ Use --scope <project|user> to control trust.    │",
	"└────────────────────────────────────────────────┘",
];

function renderAvailableList(
	workflows: ReadonlyArray<{ name: string; version?: number }>,
): string {
	return workflows.map((w) => `${w.name}@${w.version ?? 0}`).join(", ");
}

function renderOperatorEmptyState(
	styler: SemanticStyler,
	available?: ReadonlyArray<{ name: string; version?: number }>,
): string {
	if (available === undefined) return EMPTY_OPERATOR_STATE;
	if (available.length === 0) {
		return `${styler.dim("No workflow definitions yet.")} ${styler.warning("Use /workflow generate to create one.")}`;
	}
	return `No active workflow runs. Available: ${renderAvailableList(available)}. Use /workflow start <name> to launch.`;
}

function renderDashboardEmptyState(
	styler: SemanticStyler,
	available: ReadonlyArray<{ name: string; version?: number }> | undefined,
	maxWidth: number,
): string {
	if (available === undefined) return EMPTY_DASHBOARD_STATE_LINES.join("\n");

	if (available.length === 0) {
		return [
			buildBoxLine({
				prefix: "┌─ ",
				parts: [{ text: "no definitions ", style: styler.warning }],
				fill: "─",
				suffix: "┐",
				styler,
				maxWidth,
				minFill: 1,
			}),
			buildBoxLine({
				prefix: "│ ",
				parts: [
					{
						text: "Use /workflow generate to create a workflow.",
						style: styler.text,
					},
				],
				fill: " ",
				suffix: "│",
				styler,
				maxWidth,
			}),
			buildBoxLine({
				prefix: "└",
				parts: [],
				fill: "─",
				suffix: "┘",
				styler,
				maxWidth,
			}),
		].join("\n");
	}

	const list = renderAvailableList(available);
	const intro = "No active runs. Start one with /workflow start <name>.";
	const fitList =
		list.length > maxWidth - 4
			? `${list.slice(0, Math.max(0, maxWidth - 5))}…`
			: list;

	return [
		buildBoxLine({
			prefix: "┌─ ",
			parts: [{ text: "idle ", style: styler.muted }],
			fill: "─",
			suffix: "┐",
			styler,
			maxWidth,
			minFill: 1,
		}),
		buildBoxLine({
			prefix: "│ ",
			parts: [{ text: intro, style: styler.text }],
			fill: " ",
			suffix: "│",
			styler,
			maxWidth,
		}),
		buildBoxLine({
			prefix: "│ ",
			parts: [{ text: `Available: ${fitList}`, style: styler.dim }],
			fill: " ",
			suffix: "│",
			styler,
			maxWidth,
		}),
		buildBoxLine({
			prefix: "└",
			parts: [],
			fill: "─",
			suffix: "┘",
			styler,
			maxWidth,
		}),
	].join("\n");
}

export function renderEmptyState(
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
	options: RenderStatusOptions = {},
): string {
	const styler = resolveStyler(options);
	const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
	if (mode === "dashboard") {
		return renderDashboardEmptyState(
			styler,
			options.availableWorkflows,
			maxWidth,
		);
	}
	return renderOperatorEmptyState(styler, options.availableWorkflows);
}

export function renderWorkflowStatus(
	runs: readonly WorkflowRun[],
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
	options: RenderStatusOptions = {},
): string {
	if (runs.length === 0) {
		if (options.includeEmptyState === false) return "";
		return renderEmptyState(mode, options);
	}
	if (mode === "dashboard") {
		return runs
			.map((run) => renderWorkflowRun(run, mode, options))
			.join("\n\n");
	}
	return runs.map((run) => renderWorkflowRun(run, mode, options)).join("\n\n");
}

/**
 * Renders per-call glyphs in a fixed-width seven-character cell. Useful when
 * tests or alternative presentations want a glance-friendly call list.
 */
export function renderCallGlyphs(
	calls: readonly WorkflowCall[] | undefined,
): string {
	if (!calls || calls.length === 0) return "(no calls)";
	return calls
		.map(
			(call) =>
				`${STATUS_GLYPHS[call.status] ?? "?"} ${call.label ?? call.namespace}`,
		)
		.join(" ");
}

/**
 * Aggregates attempt statuses for a single call. Exposed so other
 * presentation surfaces can build their own views without reimplementing the
 * status vocabulary.
 */
export function summarizeAttemptStatuses(
	attempts: readonly { status: WorkflowAttemptStatus }[] | undefined,
): string {
	if (!attempts || attempts.length === 0) return "no attempts";
	const counts = countByStatus(attempts);
	return [
		`queued=${counts.queued ?? 0}`,
		`dispatched=${counts.dispatched ?? 0}`,
		`running=${counts.running ?? 0}`,
		`succeeded=${counts.succeeded ?? 0}`,
		`failed=${counts.failed ?? 0}`,
		`cancelled=${counts.cancelled ?? 0}`,
		`unknown=${counts.unknown ?? 0}`,
	].join(" ");
}
