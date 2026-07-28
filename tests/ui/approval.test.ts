import { describe, expect, test } from "bun:test";
import type { WorkflowApprovalPreview } from "../../src/definition/types.js";
import {
	APPROVAL_CONFIRM_TITLE,
	formatApprovalMessage,
	workflowHash,
} from "../../src/ui/approval.js";

const SAMPLE_SOURCE = `import { defineWorkflow } from "@ramarivera/omp-workflows";
export const workflow = defineWorkflow({
  name: "demo",
  version: 1,
  async run({ args, agent, phase }) {
    phase("investigate");
    return await agent("scan", { agent: "scout" });
  },
});`;

function makePreview(
	overrides: Partial<WorkflowApprovalPreview> = {},
): WorkflowApprovalPreview {
	const base: WorkflowApprovalPreview = {
		rawSource: SAMPLE_SOURCE,
		args: { n: 1 },
		phases: ["investigate"],
		calls: [
			{
				id: "scan",
				prompt: "scan",
				agent: "scout",
				model: "openai/gpt-5",
				effort: "low",
				fallbacks: ["fallback-1"],
				toolset: ["read", "grep"],
				isolation: { mode: "none" },
				apply: false,
			},
		],
		routing: {
			model: "openai/gpt-5",
			effort: "low",
			fallbacks: ["fallback-1"],
			calls: [],
		},
		limits: { maxConcurrency: 4, maxAgents: 8, maxRuntimeMs: 600_000 },
		filesystem: ["/tmp/.omp/workflows"],
		pluginSource: "/plugins/omp-workflows",
		hash: "",
		toolset: ["read", "grep"],
		versions: { runtime: "0.1.0", definition: 1 },
		source: { path: "/demo.ts", scope: "project" },
		metadata: { name: "demo", version: 1, schema: { type: "object" } },
		model: "openai/gpt-5",
		effort: "low",
		isolation: { mode: "none" },
		apply: false,
		fallbacks: ["fallback-1"],
	};
	const merged: WorkflowApprovalPreview = { ...base, ...overrides };
	const tuple: Omit<WorkflowApprovalPreview, "hash"> = (() => {
		const { hash: _h, ...rest } = merged;
		return rest;
	})();
	return { ...merged, hash: workflowHash(merged.rawSource, tuple) };
}

describe("APPROVAL_CONFIRM_TITLE", () => {
	test("is a specific confirmation title used across flows", () => {
		expect(APPROVAL_CONFIRM_TITLE).toBe("Approve workflow execution");
	});
});

describe("formatApprovalMessage (operator)", () => {
	test("preserves the exact 64-char sha-256 verbatim", () => {
		const preview = makePreview();
		const message = formatApprovalMessage(preview, "operator");
		expect(message).toContain(preview.hash);
		expect(preview.hash).toHaveLength(64);
		expect(/^[0-9a-f]{64}$/.test(preview.hash)).toBe(true);
	});

	test("preserves the entire raw workflow source verbatim", () => {
		const preview = makePreview();
		const message = formatApprovalMessage(preview, "operator");
		expect(message).toContain(SAMPLE_SOURCE);
		expect(message).toContain("export const workflow = defineWorkflow");
		expect(message).toContain("@ramarivera/omp-workflows");
	});

	test("includes identity, calls, limits, and routing", () => {
		const preview = makePreview();
		const message = formatApprovalMessage(preview, "operator");
		expect(message).toContain("demo@1");
		expect(message).toContain("project");
		expect(message).toContain("/demo.ts");
		expect(message).toContain("scout");
		expect(message).toContain("openai/gpt-5");
		expect(message).toContain("concurrency 4");
		expect(message).toContain("agents 8");
		expect(message).toContain("runtime 600000");
		expect(message).toContain('{"n":1}');
	});
});

describe("formatApprovalMessage (dashboard)", () => {
	test("uses framed layout while keeping exact source and hash", () => {
		const preview = makePreview();
		const message = formatApprovalMessage(preview, "dashboard");
		const lines = message.split("\n");
		expect(lines[0]).toContain("┌─");
		expect(lines.some((line) => line.endsWith("┘"))).toBe(true);
		expect(message).toContain(preview.hash);
		expect(message).toContain(SAMPLE_SOURCE);
		expect(message).toContain("demo@1");
		expect(message).toContain("project");
		expect(message).toContain("/demo.ts");
		expect(message).toContain("scout");
		expect(message).toContain("openai/gpt-5");
	});
});

describe("formatApprovalMessage (no-ANSI contract)", () => {
	test("plain text — no ANSI color escapes in either mode", () => {
		const preview = makePreview();
		const operatorMessage = formatApprovalMessage(preview, "operator");
		const dashboardMessage = formatApprovalMessage(preview, "dashboard");
		const ansiControlSequence = `${String.fromCharCode(27)}[`;
		expect(operatorMessage).not.toContain(ansiControlSequence);
		expect(dashboardMessage).not.toContain(ansiControlSequence);
	});

	test("rawSource is preserved when it contains unusual characters and tooling quotes", () => {
		const customSource = `// ${"a".repeat(120)}\nexport const workflow = defineWorkflow({ name: "u" });`;
		const preview = makePreview({ rawSource: customSource });
		const message = formatApprovalMessage(preview, "operator");
		expect(message).toContain(customSource);
	});
});
