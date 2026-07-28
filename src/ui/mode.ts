/**
 * UI mode selection for the OMP workflows extension.
 *
 * Two modes:
 *  - `operator` (default): quiet, compact multi-line run cards, semantic state
 *    markers, progress/count hierarchy, human token/runtime values, actionable
 *    warnings. Designed for engineers piloting the controller.
 *  - `dashboard`: restrained Unicode card with progress bar, counts, budgets,
 *    warnings. Terminal-width-safe with no decorative clutter. Designed for a
 *    passive watcher persona.
 *
 * Mode is sourced from `~/.omp/workflows.json` (top-level key `ui`,
 * value `"operator"` or `"dashboard"`). Any other value (missing file,
 * unparseable JSON, extra keys, unexpected types, unknown strings) is treated
 * as a degraded config: a concise warning is surfaced and the resolver falls
 * back to the operator default. Operator mode is also used when the file is
 * simply absent; absence is not a warning.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkflowUiMode = "operator" | "dashboard";

export const DEFAULT_UI_MODE: WorkflowUiMode = "operator";
export const UI_CONFIG_FILENAME = "workflows.json";
export const UI_CONFIG_RELATIVE_DIR = ".omp";

export const UI_MODE_VALUES: readonly WorkflowUiMode[] = [
	"operator",
	"dashboard",
] as const;

export interface UiModeConfigSource {
	/** Resolve a JSON object from the config path. Returns undefined when the file does not exist. */
	readConfig(home: string): Promise<unknown>;
}

export interface ResolveUiModeOptions {
	/** Override the home directory (defaults to `process.env.HOME` or `cwd`). */
	home?: string;
	/** Override the cwd used for `process.env.HOME` fallback. */
	cwd?: string;
	/** Inject a config source for tests. Defaults to a filesystem-backed reader. */
	source?: UiModeConfigSource;
}

export interface UiModeResolution {
	/** Selected mode (always one of `operator` or `dashboard`). */
	mode: WorkflowUiMode;
	/** Why the resolver picked this mode. */
	source: "config" | "default" | "fallback";
	/** Human-readable warnings to surface once at session start. */
	warnings: string[];
}

class FileSystemConfigSource implements UiModeConfigSource {
	async readConfig(home: string): Promise<unknown> {
		const target = join(home, UI_CONFIG_RELATIVE_DIR, UI_CONFIG_FILENAME);
		try {
			return JSON.parse(await readFile(target, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			// Malformed JSON or other read error: surface as a string so the
			// resolver can report a useful warning instead of a stack trace.
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`unreadable config: ${message}`);
		}
	}
}

export function isWorkflowUiMode(value: unknown): value is WorkflowUiMode {
	return (
		typeof value === "string" &&
		(UI_MODE_VALUES as readonly string[]).includes(value)
	);
}

function formatUnknownUiValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return keys.length === 0 ? "{}" : `{keys: ${keys.join(",")}}`;
	}
	return typeof value;
}

export async function resolveUiMode(
	options: ResolveUiModeOptions = {},
): Promise<UiModeResolution> {
	const envHome = process.env.HOME;
	const home =
		(typeof options.home === "string" && options.home.length > 0
			? options.home
			: typeof envHome === "string" && envHome.length > 0
				? envHome
				: (options.cwd ?? process.cwd())) ?? process.cwd();
	const source = options.source ?? new FileSystemConfigSource();
	let raw: unknown;
	try {
		raw = await source.readConfig(home);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			mode: DEFAULT_UI_MODE,
			source: "fallback",
			warnings: [
				`omp-workflows: failed to read ~/.omp/workflows.json (${message}); using ${DEFAULT_UI_MODE}.`,
			],
		};
	}
	if (raw === undefined) {
		return { mode: DEFAULT_UI_MODE, source: "default", warnings: [] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			mode: DEFAULT_UI_MODE,
			source: "fallback",
			warnings: [
				`omp-workflows: ~/.omp/workflows.json must be a JSON object; using ${DEFAULT_UI_MODE}.`,
			],
		};
	}
	const record = raw as Record<string, unknown>;
	if (!Object.hasOwn(record, "ui")) {
		return { mode: DEFAULT_UI_MODE, source: "default", warnings: [] };
	}
	const value = record.ui;
	if (!isWorkflowUiMode(value)) {
		return {
			mode: DEFAULT_UI_MODE,
			source: "fallback",
			warnings: [
				`omp-workflows: ~/.omp/workflows.json "ui" must be "operator" or "dashboard" (got ${formatUnknownUiValue(value)}); using ${DEFAULT_UI_MODE}.`,
			],
		};
	}
	const extraKeys = Object.keys(record).filter((key) => key !== "ui");
	if (extraKeys.length > 0) {
		return {
			mode: value,
			source: "fallback",
			warnings: [
				`omp-workflows: ~/.omp/workflows.json ignores unknown keys (${extraKeys.join(", ")}); using ${value}.`,
			],
		};
	}
	return { mode: value, source: "config", warnings: [] };
}
