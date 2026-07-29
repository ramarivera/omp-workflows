/**
 * Semantic styling adapter for workflow status rendering.
 *
 * Exposes a tiny, test-friendly `SemanticStyler` interface. Tests use
 * `createIdentityStyler()` for deterministic, ANSI-free output. Runtime code can
 * `createOmpStyler()` to inject OMP `theme` colors and a static rainbow
 * gradient via `createGradientHighlighter`.
 *
 * Pre-init safety: every call guards `typeof theme` before touching the global
 * theme, so headless/tests never crash when the theme has not been assigned.
 */

import { theme } from "@oh-my-pi/pi-coding-agent";
import {
	createGradientHighlighter,
	type KeywordHighlighter,
} from "@oh-my-pi/pi-coding-agent/modes/gradient-highlight";

export interface SemanticStyler {
	accent(text: string): string;
	success(text: string): string;
	warning(text: string): string;
	error(text: string): string;
	muted(text: string): string;
	dim(text: string): string;
	text(text: string): string;
	bold(text: string): string;
	rainbow(text: string, phase?: number): string;
}

/** Identity styler: returns every string unchanged. Useful for tests. */
export function createIdentityStyler(): SemanticStyler {
	return {
		accent: (text) => text,
		success: (text) => text,
		warning: (text) => text,
		error: (text) => text,
		muted: (text) => text,
		dim: (text) => text,
		text: (text) => text,
		bold: (text) => text,
		rainbow: (text) => text,
	};
}

/** Runtime styler backed by the global OMP `theme` and `createGradientHighlighter`. */
export function createOmpStyler(): SemanticStyler {
	let highlighter: KeywordHighlighter | undefined;

	const maybeHighlight = (text: string, phase = 0): string => {
		if (typeof theme === "undefined") return text;
		if (highlighter === undefined) {
			highlighter = createGradientHighlighter({
				probe: /./,
				highlight: /.+/g,
				stops: 16,
				hue: (t) => t * 360,
				saturation: 90,
				lightness: 62,
			});
		}
		return highlighter(text, undefined, phase);
	};

	return {
		accent: (text) =>
			typeof theme === "undefined" ? text : theme.fg("accent", text),
		success: (text) =>
			typeof theme === "undefined" ? text : theme.fg("success", text),
		warning: (text) =>
			typeof theme === "undefined" ? text : theme.fg("warning", text),
		error: (text) =>
			typeof theme === "undefined" ? text : theme.fg("error", text),
		muted: (text) =>
			typeof theme === "undefined" ? text : theme.fg("muted", text),
		dim: (text) =>
			typeof theme === "undefined" ? text : theme.fg("dim", text),
		text: (text) =>
			typeof theme === "undefined" ? text : theme.fg("text", text),
		bold: (text) => (typeof theme === "undefined" ? text : theme.bold(text)),
		rainbow: maybeHighlight,
	};
}
