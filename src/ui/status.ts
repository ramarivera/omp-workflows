/**
 * Status renderers for the OMP workflows extension.
 *
 * Two presentation styles live here:
 *  - `summarizeWorkflow(run)` — single-line compact summary used by the
 *    operator default and by machine-watch tools.
 *  - `renderWorkflowRun(run, mode)` — multi-line run card (operator) or
 *    framed Unicode card (dashboard), with progress bar in dashboard mode.
 *  - `renderWorkflowStatus(runs, mode)` — collection render; defaults to the
 *    compact one-line-per-run layout (operator) for back-compat.
 *
 * The renderers are pure: same input → same output, no clock or random
 * dependencies. They tolerate arbitrary run shapes (the controller snapshots
 * often omit fields during recovery), so every accessor that reads
 * counts/totals defends with `?? 0`.
 */

import type {
	WorkflowAttemptStatus,
	WorkflowCall,
	WorkflowCallStatus,
	WorkflowRun,
	WorkflowRunStatus,
} from "../runtime/types.js";
import { DEFAULT_UI_MODE, type WorkflowUiMode } from "./mode.js";

export interface RenderStatusOptions {
	/**
	 * Maximum column width used by dashboard card line-wrapping. Defaults to
	 * 78 columns. Operator mode is unaffected by this knob.
	 */
	maxWidth?: number;
	/** When false, the empty-state copy is omitted when there are no runs. */
	includeEmptyState?: boolean;
}

const DEFAULT_MAX_WIDTH = 78;

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

export function summarizeWorkflow(run: WorkflowRun): string {
	const counts = countByStatus(run.calls);
	const warnings = runWarnings(run);
	return `${run.id} ${run.status} · ${run.definition.name}@${run.definition.version} | phases=${run.phases?.length ?? 0} calls=${run.calls?.length ?? 0} queued=${counts.queued ?? 0} dispatched=${counts.dispatched ?? 0} running=${counts.running ?? 0} succeeded=${counts.succeeded ?? 0} failed=${counts.failed ?? 0} totals=agents:${run.totals?.agents ?? 0},tokens:${formatTokens(run.totals?.outputTokens)},runtime:${formatMilliseconds(run.totals?.runtimeMs)} limits=concurrency:${formatLimit(run.limits?.maxConcurrency)},agents:${formatLimit(run.limits?.maxAgents)}${warnings.length ? ` warning: ${warnings.join("; ")}` : ""}`;
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

function buildOperatorRunCard(run: WorkflowRun): string {
	const counts = countByStatus(run.calls);
	const phase = run.phases?.at(-1) ?? "(no phase)";
	const completed = (counts.succeeded ?? 0) + (counts.failed ?? 0);
	const total = run.calls?.length ?? 0;
	const throughput = total === 0 ? "0/0" : `${completed}/${total}`;
	const warnings = runWarnings(run);
	const counters = [
		`${counts.queued ?? 0} queued`,
		`${counts.dispatched ?? 0} dispatched`,
		`${counts.running ?? 0} running`,
		`${counts.succeeded ?? 0} succeeded`,
		`${counts.failed ?? 0} failed`,
	].join(" · ");
	const limits = [
		`concurrency ${formatLimit(run.limits?.maxConcurrency)}`,
		`agents ${formatLimit(run.limits?.maxAgents)}`,
		`tokens ${run.limits?.maxOutputTokens === undefined ? "—" : formatTokens(run.limits.maxOutputTokens)}`,
		`runtime ${run.limits?.maxRuntimeMs === undefined ? "—" : formatMilliseconds(run.limits.maxRuntimeMs)}`,
	].join(" · ");
	const lines = [
		`${run.id}  ${run.status} · ${run.definition.name}@${run.definition.version}`,
		`├── phase: ${phase} · calls ${throughput} · agents ${run.totals?.agents ?? 0}`,
		`│   tokens ${formatTokens(run.totals?.outputTokens)} · runtime ${formatMilliseconds(run.totals?.runtimeMs)}`,
		`├── status: ${counters}`,
		`├── limits: ${limits}`,
	];
	if (warnings.length > 0) {
		lines.push(`└── ⚠ ${warnings.join("; ")}`);
	} else {
		lines.push("└── ok");
	}
	return lines.join("\n");
}

function progressBar(fraction: number, width = 20): string {
	if (!Number.isFinite(fraction)) return "░".repeat(width);
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	const empty = width - filled;
	return "▓".repeat(filled) + "░".repeat(empty);
}

function clampLine(line: string, maxWidth: number): string {
	if (line.length <= maxWidth) return line;
	return `${line.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function repeatChar(char: string, length: number): string {
	return char.repeat(Math.max(0, length));
}

function buildDashboardRunCard(
	run: WorkflowRun,
	options: RenderStatusOptions,
): string {
	const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
	const innerWidth = Math.max(20, maxWidth - 4);
	const counts = countByStatus(run.calls);
	const total = run.calls?.length ?? 0;
	const completed = (counts.succeeded ?? 0) + (counts.failed ?? 0);
	const fraction = total === 0 ? 0 : completed / total;
	const phaseTitle = run.phases?.at(-1) ?? "(no phase)";
	const bar = progressBar(fraction);
	const percent = `${Math.round(fraction * 100)}%`;
	const phaseCount = run.phases?.length ?? 0;
	const phaseLabel = `phase ${phaseCount === 0 ? "—" : `${phaseCount}/${phaseCount}`}`;
	const counters = [
		`calls ${completed}/${total}`,
		`agents ${run.totals?.agents ?? 0}`,
		`tokens ${formatTokens(run.totals?.outputTokens)}`,
		`runtime ${formatMilliseconds(run.totals?.runtimeMs)}`,
	].join(" · ");
	const budget = [
		`agents ${formatLimit(run.limits?.maxAgents, "∞")}`,
		`concurrency ${formatLimit(run.limits?.maxConcurrency, "∞")}`,
		`tokens ${run.limits?.maxOutputTokens === undefined ? "—" : formatTokens(run.limits.maxOutputTokens)}`,
		`runtime ${run.limits?.maxRuntimeMs === undefined ? "—" : formatMilliseconds(run.limits.maxRuntimeMs)}`,
	].join(" · ");
	const warnings = runWarnings(run);
	const glyph = RUN_STATUS_GLYPHS[run.status] ?? "·";
	const header = `${glyph} ${run.id} · ${run.status} · ${run.definition.name}@${run.definition.version}`;
	const ruleLength = Math.max(1, innerWidth - header.length - 1);
	const headerLine = clampLine(
		`┌─ ${header} ${repeatChar("─", ruleLength)}┐`,
		maxWidth,
	);
	const summaryLine = clampLine(`│ ${phaseTitle} · ${counters}`, maxWidth);
	const progressLine = clampLine(
		`│ ${bar} ${percent} · ${phaseLabel}`,
		maxWidth,
	);
	const budgetLine = clampLine(`│ budget ${budget}`, maxWidth);
	const statusLine = clampLine(
		`│ status ${counts.queued ?? 0}q ${counts.dispatched ?? 0}d ${counts.running ?? 0}r ${counts.succeeded ?? 0}s ${counts.failed ?? 0}f`,
		maxWidth,
	);
	const lines = [headerLine, summaryLine, progressLine, budgetLine, statusLine];
	if (warnings.length > 0) {
		const warningLine = clampLine(
			`└─ ⚠ ${warnings.join(" · ")} ${repeatChar("─", ruleLength)}┘`,
			maxWidth,
		);
		lines.push(warningLine);
	} else {
		const okRule = repeatChar("─", Math.max(1, innerWidth - 1));
		lines.push(clampLine(`└${okRule}┘`, maxWidth));
	}
	return lines.join("\n");
}

export function renderWorkflowRun(
	run: WorkflowRun,
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
	options: RenderStatusOptions = {},
): string {
	if (mode === "dashboard") return buildDashboardRunCard(run, options);
	return buildOperatorRunCard(run);
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

export function renderEmptyState(
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
): string {
	if (mode === "dashboard") return EMPTY_DASHBOARD_STATE_LINES.join("\n");
	return EMPTY_OPERATOR_STATE;
}

export function renderWorkflowStatus(
	runs: readonly WorkflowRun[],
	mode: WorkflowUiMode = DEFAULT_UI_MODE,
	options: RenderStatusOptions = {},
): string {
	if (runs.length === 0) {
		if (options.includeEmptyState === false) return "";
		return renderEmptyState(mode);
	}
	if (mode === "dashboard") {
		return runs.map((run) => renderWorkflowRun(run, mode, options)).join("\n");
	}
	return runs.map(summarizeWorkflow).join("\n");
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
	const counts: Record<string, number> = {};
	for (const attempt of attempts) {
		counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
	}
	return Object.entries(counts)
		.map(([status, count]) => `${count} ${status}`)
		.join(", ");
}
