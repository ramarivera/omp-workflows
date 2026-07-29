/**
 * Workflow activity indicator widget.
 *
 * Renders a persistent, below-editor TUI component with a moving truecolor
 * rainbow across a concise heading and user-supplied detail lines. The clock
 * and timer primitives are fully injectable so tests can drive the animation
 * deterministically.
 */

import type {
	ExtensionUIContext,
	ExtensionUiComponent,
	ExtensionUiComponentFactory,
} from "@oh-my-pi/pi-coding-agent";

export const WORKFLOW_MAGIC_WORD = "workflowz";

const WORKFLOW_MAGIC_RE = new RegExp(
	`(?<![\\p{L}\\p{N}])${WORKFLOW_MAGIC_WORD}(?![\\p{L}\\p{N}])`,
	"u",
);

/** Detect whether `text` contains the magic word as a standalone lowercase token. */
export function containsWorkflowMagicWord(text: string): boolean {
	return WORKFLOW_MAGIC_RE.test(text);
}

/** Injectable clock and repeating-timer boundary. */
export interface WorkflowClock {
	/** Current wall time in milliseconds. */
	now(): number;
	/** Schedule a repeating callback. Returns an opaque handle. */
	setRepeating(callback: () => void, ms: number): unknown;
	/** Cancel a handle returned by {@link setRepeating}. */
	clearRepeating(handle: unknown): void;
}

export interface WorkflowIndicatorOptions {
	/** Widget key passed to `ctx.ui.setWidget`. Defaults to `"workflow-activity"`. */
	key?: string;
	/** Heading line. Defaults to the magic word. */
	heading?: string;
	/** Interval between animation frames in milliseconds. Defaults to `120`. */
	refreshMs?: number;
	/** Period of one full rainbow cycle in milliseconds. Defaults to `1200`. */
	rainbowPeriodMs?: number;
	/** Injectable clock and interval primitives for deterministic tests. */
	clock?: WorkflowClock;
}

export interface WorkflowIndicatorController {
	/** Factory to pass to `ctx.ui.setWidget`. */
	readonly factory: ExtensionUiComponentFactory;
	/** Show the widget below the editor, optionally replacing the detail lines. */
	show(details?: readonly string[]): void;
	/** Update the detail lines without replacing the widget. */
	update(details: readonly string[]): void;
	/** Hide and tear down the widget. */
	clear(): void;
	/** Permanently tear down the widget. */
	dispose(): void;
}

const DEFAULT_KEY = "workflow-activity";
const DEFAULT_REFRESH_MS = 120;
const DEFAULT_RAINBOW_PERIOD_MS = 1200;
const WIDGET_PLACEMENT = "belowEditor";

const SYSTEM_CLOCK: WorkflowClock = {
	now: Date.now,
	setRepeating: (callback, ms) => setInterval(callback, ms),
	clearRepeating: (handle) => clearInterval(handle as number),
};
/** A subset of `ExtensionUIContext` used by the indicator. */
type WidgetHost = Pick<ExtensionUIContext, "setWidget">;

/**
 * Create a controller + component factory that renders a small animated workflow
 * indicator below the editor.
 */
export function createWorkflowIndicator(
	host: WidgetHost,
	options: WorkflowIndicatorOptions,
): WorkflowIndicatorController {
	const key = options.key ?? DEFAULT_KEY;
	const heading = options.heading ?? WORKFLOW_MAGIC_WORD;
	const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
	const rainbowPeriodMs = options.rainbowPeriodMs ?? DEFAULT_RAINBOW_PERIOD_MS;
	const clock = options.clock ?? SYSTEM_CLOCK;

	type TUI = Parameters<ExtensionUiComponentFactory>[0];
	const renderRainbow = (text: string, phase: number): string => {
		const characters = [...text];
		const colored = characters.map((character, index) => {
			if (character.trim().length === 0) return character;
			const hue =
				(phase * 360 + (index / Math.max(1, characters.length)) * 300) % 360;
			const [red, green, blue] = hslToRgb(hue, 0.9, 0.62);
			return `\x1b[38;2;${red};${green};${blue}m${character}`;
		});
		return `${colored.join("")}\x1b[39m`;
	};

	class WorkflowIndicatorComponent implements ExtensionUiComponent {
		#tui: TUI | undefined;
		#details: readonly string[] = [];
		#timer: unknown;
		#disposed = false;

		constructor(initialDetails: readonly string[]) {
			this.#details = initialDetails;
		}

		setTui(tui: TUI): void {
			this.#tui = tui;
			this.#startTimer();
		}

		setDetails(details: readonly string[]): void {
			const changed =
				details.length !== this.#details.length ||
				details.some((line, i) => line !== this.#details[i]);
			this.#details = details;
			if (this.#tui && !this.#disposed && changed) {
				this.#tui.requestRender();
			}
		}

		render(width: number): readonly string[] {
			const lines = [heading, ...this.#details].map((line) =>
				truncateLine(line, width),
			);
			const now = clock.now();
			const basePhase = (now % rainbowPeriodMs) / rainbowPeriodMs;
			return lines.map((line, index) =>
				renderRainbow(line, (basePhase + index / lines.length) % 1),
			);
		}

		dispose(): void {
			if (this.#disposed) return;
			this.#disposed = true;
			if (this.#timer !== undefined) {
				clock.clearRepeating(this.#timer);
				this.#timer = undefined;
			}
			this.#tui = undefined;
		}

		#startTimer(): void {
			if (this.#timer !== undefined || this.#disposed) return;
			this.#timer = clock.setRepeating(() => {
				if (this.#tui && !this.#disposed) {
					this.#tui.requestRender();
				}
			}, refreshMs);
		}
	}

	let component: WorkflowIndicatorComponent | undefined;
	let pendingDetails: readonly string[] = [];
	let visible = false;

	const factory: ExtensionUiComponentFactory = (tui, _theme) => {
		if (component === undefined) {
			component = new WorkflowIndicatorComponent(pendingDetails);
		}
		component.setTui(tui);
		component.setDetails(pendingDetails);
		return component;
	};

	const controller: WorkflowIndicatorController = {
		factory,
		show(details = []) {
			pendingDetails = details;
			if (!visible) {
				visible = true;
				host.setWidget(key, factory, { placement: WIDGET_PLACEMENT });
			} else if (component !== undefined) {
				component.setDetails(details);
			}
		},
		update(details) {
			pendingDetails = details;
			if (component !== undefined) {
				component.setDetails(details);
			}
		},
		clear() {
			if (!visible && component === undefined) return;
			visible = false;
			host.setWidget(key, undefined, { placement: WIDGET_PLACEMENT });
			component?.dispose();
			component = undefined;
		},
		dispose() {
			this.clear();
		},
	};

	return controller;
}

function truncateLine(text: string, width: number): string {
	if (width <= 0) return "";
	const characters = [...text];
	if (characters.length <= width) return text;
	if (width === 1) return "…";
	return `${characters.slice(0, width - 1).join("")}…`;
}

function hslToRgb(
	hue: number,
	saturation: number,
	lightness: number,
): readonly [number, number, number] {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const sector = hue / 60;
	const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
	const [red, green, blue] =
		sector < 1
			? [chroma, secondary, 0]
			: sector < 2
				? [secondary, chroma, 0]
				: sector < 3
					? [0, chroma, secondary]
					: sector < 4
						? [0, secondary, chroma]
						: sector < 5
							? [secondary, 0, chroma]
							: [chroma, 0, secondary];
	const match = lightness - chroma / 2;
	return [
		Math.round((red + match) * 255),
		Math.round((green + match) * 255),
		Math.round((blue + match) * 255),
	];
}
