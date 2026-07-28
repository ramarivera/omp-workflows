import { describe, expect, test } from "bun:test";
import type {
	WorkflowCall,
	WorkflowLimits,
	WorkflowRun,
} from "../../src/runtime/types.js";
import {
	EMPTY_DASHBOARD_STATE_LINES,
	EMPTY_OPERATOR_STATE,
	renderEmptyState,
	renderWorkflowRun,
	renderWorkflowStatus,
	summarizeWorkflow,
} from "../../src/ui/status.js";

function makeCall(overrides: Partial<WorkflowCall> = {}): WorkflowCall {
	return {
		index: 0,
		namespace: "phase",
		inputHash: "h",
		status: "succeeded",
		attempts: [],
		label: "phase",
		...overrides,
	};
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	const limits: WorkflowLimits = { maxConcurrency: 2, maxAgents: 3 };
	return {
		schemaVersion: 2,
		id: "run-test",
		namespace: "demo",
		controllerGeneration: 1,
		fencingToken: "token",
		status: "running",
		persistenceHealth: "healthy",
		limits,
		calls: [makeCall()],
		totals: { agents: 1, outputTokens: 1500, runtimeMs: 12_500 },
		phases: ["phase-a", "phase-b"],
		createdAt: 1,
		updatedAt: 2,
		definition: { name: "demo", version: 1 },
		args: {},
		...overrides,
	} as WorkflowRun;
}

describe("renderEmptyState", () => {
	test("operator mode uses one deliberate line", () => {
		expect(renderEmptyState("operator")).toBe(EMPTY_OPERATOR_STATE);
		expect(EMPTY_OPERATOR_STATE).toContain("/workflow start");
	});

	test("dashboard mode uses a framed idle card", () => {
		const text = renderEmptyState("dashboard");
		expect(text.split("\n")).toEqual(EMPTY_DASHBOARD_STATE_LINES);
		expect(EMPTY_DASHBOARD_STATE_LINES[0]).toContain("idle");
	});
});

describe("summarizeWorkflow (operator single-line)", () => {
	test("emits counts, totals, limits, and concatenated warnings", () => {
		const text = summarizeWorkflow(
			makeRun({
				persistenceHealth: "degraded",
				blockedReason: "approval",
				totals: { agents: 4, outputTokens: 9_500, runtimeMs: 11_000 },
			}),
		);
		expect(text).toContain("run-test running");
		expect(text).toContain("totals=agents:4,tokens:9.5k,runtime:11s");
		expect(text).toContain("persistence degraded");
		expect(text).toContain("blocked: approval");
		expect(text).toContain("agent limit exceeded");
	});
});

describe("renderWorkflowRun (operator)", () => {
	test("multi-line card with hierarchy, human tokens, actionable warnings", () => {
		const text = renderWorkflowRun(
			makeRun({
				persistenceHealth: "degraded",
				blockedReason: "upstream stage",
			}),
			"operator",
		);
		const lines = text.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(5);
		expect(lines[0]).toContain("run-test");
		expect(lines[0]).toContain("running");
		expect(lines[1]).toContain("phase: phase-b");
		expect(text).toContain("1.5k"); // human token form
		expect(text).toContain("12.5s"); // human runtime form
		expect(text).toContain("persistence degraded");
		expect(text).toContain("blocked: upstream stage");
		expect(text).toContain("⚠");
	});

	test("renders an ok terminator when no warnings are present", () => {
		const text = renderWorkflowRun(makeRun(), "operator");
		expect(text).toContain("└── ok");
	});
});

describe("renderWorkflowRun (dashboard)", () => {
	test("restrained Unicode card with progress bar and budget", () => {
		const text = renderWorkflowRun(makeRun(), "dashboard", { maxWidth: 64 });
		const lines = text.split("\n");
		expect(lines[0]).toMatch(/^┌─/);
		expect(lines[lines.length - 1]).toMatch(/[┘─]/);
		expect(text).toContain("▓");
		expect(text).toMatch(/\d+%/);
		expect(text).toContain("budget");
		expect(text).toContain("agents");
		expect(text).toContain("concurrency");
	});

	test("uses the legend arrow for warning footers when warnings exist", () => {
		const text = renderWorkflowRun(
			makeRun({ persistenceHealth: "degraded" }),
			"dashboard",
		);
		expect(text).toContain("⚠ persistence degraded");
	});

	test("clamps content to the requested max width", () => {
		const text = renderWorkflowRun(makeRun(), "dashboard", { maxWidth: 40 });
		for (const line of text.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});
});

describe("renderWorkflowStatus (collection)", () => {
	test("empty operator result is the explicit empty-state line", () => {
		const text = renderWorkflowStatus([], "operator");
		expect(text).toBe(EMPTY_OPERATOR_STATE);
	});

	test("empty dashboard result is the framed idle card", () => {
		const text = renderWorkflowStatus([], "dashboard");
		expect(text).toBe(EMPTY_DASHBOARD_STATE_LINES.join("\n"));
	});

	test("operator joins multiple runs with newline separator", () => {
		const text = renderWorkflowStatus(
			[makeRun({ id: "a" }), makeRun({ id: "b" })],
			"operator",
		);
		const lines = text.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.some((line) => line.startsWith("a "))).toBe(true);
		expect(lines.some((line) => line.startsWith("b "))).toBe(true);
	});

	test("dashboard joins multiple cards separated by a blank line", () => {
		const text = renderWorkflowStatus(
			[makeRun({ id: "a" }), makeRun({ id: "b" })],
			"dashboard",
			{ maxWidth: 60 },
		);
		// Each card has at least 6 lines; assert presence of both ids.
		expect(text).toContain("a ·");
		expect(text).toContain("b ·");
		// Cards should be visually separated.
		const cardCount = (text.match(/┌─ /g) ?? []).length;
		expect(cardCount).toBeGreaterThanOrEqual(2);
	});

	test("includeEmptyState=false suppresses the idle copy", () => {
		expect(
			renderWorkflowStatus([], "operator", { includeEmptyState: false }),
		).toBe("");
		expect(
			renderWorkflowStatus([], "dashboard", { includeEmptyState: false }),
		).toBe("");
	});
});
