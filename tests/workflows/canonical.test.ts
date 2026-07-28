import { describe, expect, test } from "bun:test";
import type {
	AgentCallOptions,
	WorkflowContext,
} from "@ramarivera/omp-workflows";
import { workflow as bugs } from "../../workflows/bug-sweep.js";
import { workflow as review } from "../../workflows/changed-file-review.js";
import { workflow as research } from "../../workflows/deep-research.js";
import { workflow as migration } from "../../workflows/large-migration.js";
import { workflow as typecheck } from "../../workflows/typecheck-fix.js";

type Call = { prompt: string; options: AgentCallOptions; input?: unknown };
type Outcome = unknown | Error;
function context<TArgs>(
	args: TArgs,
	outcomes: Record<string, Outcome>,
	calls: Call[],
	phases: string[],
): WorkflowContext<TArgs> {
	const agent = async <T>(
		prompt: string,
		options: AgentCallOptions = {},
	): Promise<T> => {
		calls.push({ prompt, options, input: options.input });
		const outcome = outcomes[options.id ?? ""];
		if (outcome instanceof Error) throw outcome;
		if (outcome === undefined)
			throw new Error(`missing queued outcome: ${options.id}`);
		return outcome as T;
	};
	return {
		args,
		agent,
		phase: (title) => phases.push(title),
		now: () => 1_700_000_000_000,
		random: () => 0.5,
		parallel: async <T>(tasks: Array<() => Promise<T>>, fatal = true) => {
			const settled: PromiseSettledResult<Awaited<T>>[] =
				await Promise.allSettled(tasks.map((task) => task()));
			if (fatal && settled.some((x) => x.status === "rejected"))
				throw new Error("parallel failed");
			return settled
				.filter(
					(x): x is PromiseFulfilledResult<Awaited<T>> =>
						x.status === "fulfilled",
				)
				.map((x) => x.value as T);
		},
		pipeline: async <T>(
			value: T | Promise<T>,
			...stages: Array<(value: unknown) => T | Promise<T>>
		) => {
			let current: unknown = await value;
			for (const stage of stages) current = await stage(current);
			return current as T;
		},
	};
}
const src = (url: string, title = "Source") => ({
	url,
	title,
	claims: ["claim"],
});
const finding = {
	path: "src/a.ts",
	line: 1,
	message: "issue",
	severity: "medium",
	actionable: true,
	fingerprint: "fp",
};

describe("canonical workflows", () => {
	test("typecheck executes rounds in order and uses stable strict options", async () => {
		const calls: Call[] = [],
			phases: string[] = [],
			d = { diagnostics: [], fixed: 0 };
		const out: Record<string, Outcome> = {};
		for (let r = 1; r <= 3; r++) {
			for (let i = 1; i <= 2; i++) out[`diagnostics:${r}:${i}`] = [];
			out[`fix:${r}`] = d;
		}
		const result = await typecheck.run(
			context(
				{ command: "bun typecheck", maxRounds: 3, shards: 2 },
				out,
				calls,
				phases,
			),
		);
		expect(result.stoppedBecause).toBe("no-progress");
		expect(phases).toEqual([
			"Typecheck diagnostics wave 1",
			"Typecheck diagnostics wave 2",
			"Typecheck diagnostics wave 3",
		]);
		expect(calls).toHaveLength(9);
		expect(calls[0].options).toMatchObject({
			id: "diagnostics:1:1",
			model: "fast",
			effort: "high",
			toolset: ["repo-read"],
			isolation: { mode: "none" },
			apply: false,
			schemaMode: "strict",
		});
	});
	test("typecheck honors shard fan-out and limit gate", async () => {
		const c: Call[] = [],
			p: string[] = [],
			out: Record<string, Outcome> = {};
		for (let i = 1; i <= 3; i++) out[`diagnostics:1:${i}`] = [];
		out["fix:1"] = { diagnostics: [], fixed: 1 };
		const r = await typecheck.run(
			context({ command: "tsc", maxRounds: 1, shards: 3 }, out, c, p),
		);
		expect(c).toHaveLength(4);
		expect(r.stoppedBecause).toBe("limit");
	});
	test("bug sweep repeats until two dry rounds", async () => {
		const c: Call[] = [],
			p: string[] = [],
			out: Record<string, Outcome> = {
				"wave:1": { findings: [finding], fixed: 1, remaining: 1 },
				"wave:2": { findings: [], fixed: 0, remaining: 1 },
				"wave:3": { findings: [], fixed: 0, remaining: 1 },
			};
		const r = await bugs.run(context({ root: ".", maxRounds: 4 }, out, c, p));
		expect(c.map((x) => x.options.id)).toEqual(["wave:1", "wave:2", "wave:3"]);
		expect(r.stoppedBecause).toBe("two-dry-rounds");
		expect(c[0].options.apply).toBe(true);
	});
	test("bug sweep passes stable round inputs", async () => {
		const c: Call[] = [],
			p: string[] = [],
			out: Record<string, Outcome> = {
				"wave:1": { findings: [], fixed: 0, remaining: 0 },
				"wave:2": { findings: [], fixed: 0, remaining: 0 },
			};
		await bugs.run(
			context({ root: "pkg", maxRounds: 2, maxFixesPerRound: 7 }, out, c, p),
		);
		expect(c[0].input).toEqual({ round: 1, maxFixes: 7 });
		expect(c[0].options.schemaMode).toBe("strict");
	});
	test("migration orders partition capture integration", async () => {
		const c: Call[] = [],
			p: string[] = [],
			out: Record<string, Outcome> = {
				partition: [{ id: "a", paths: ["a"], goal: "A" }],
				"patch:a": { id: "a", paths: ["a"], patch: "diff", head: "h" },
				integration: {
					status: "applied",
					patches: [{ id: "a", paths: ["a"], patch: "diff", head: "h" }],
					integrationRef: "x",
					conflicts: [],
					complete: true,
				},
			};
		const r = await migration.run(
			context({ request: "migrate", base: "main", apply: true }, out, c, p),
		);
		expect(p).toEqual([
			"Partition migration",
			"Capture isolated patches",
			"Integrate with completeness gate",
		]);
		expect(c.map((x) => x.options.id)).toEqual([
			"partition",
			"patch:a",
			"integration",
		]);
		expect(c[1].options.apply).toBe(false);
		expect(c[2].options.apply).toBe(true);
		expect(r.complete).toBe(true);
	});
	test("migration fans out every planned patch", async () => {
		const c: Call[] = [],
			p: string[] = [],
			parts = [1, 2, 3].map((i) => ({
				id: `p${i}`,
				paths: [`f${i}`],
				goal: `G${i}`,
			}));
		const out: Record<string, Outcome> = {
			partition: parts,
			integration: {
				status: "captured",
				patches: parts.map((x) => ({ ...x, patch: "d", head: "h" })),
				integrationRef: "x",
				conflicts: [],
				complete: true,
			},
		};
		for (const x of parts)
			out[`patch:${x.id}`] = { ...x, patch: "d", head: "h" };
		await migration.run(context({ request: "r", base: "b" }, out, c, p));
		expect(c.filter((x) => x.options.id?.startsWith("patch:")).length).toBe(3);
	});
	test("migration fails closed on incomplete result", async () => {
		const out: Record<string, Outcome> = {
			partition: [{ id: "a", paths: ["a"], goal: "A" }],
			"patch:a": { id: "a", paths: ["a"], patch: "d", head: "h" },
			integration: {
				status: "blocked",
				patches: [],
				integrationRef: "x",
				conflicts: ["c"],
				complete: false,
			},
		};
		await expect(
			migration.run(context({ request: "r", base: "b" }, out, [], [])),
		).rejects.toThrow("completeness");
	});
	test("review phases map review and gate", async () => {
		const c: Call[] = [],
			p: string[] = [],
			out: Record<string, Outcome> = {
				"map-areas": [{ id: "s", paths: ["a"], rationale: "r" }],
				"review:s": [finding],
				"verify-findings": {
					findings: [finding],
					reviewedSlices: 1,
					complete: true,
				},
			};
		const r = await review.run(
			context({ base: "main", head: "HEAD" }, out, c, p),
		);
		expect(p).toEqual([
			"Map changed areas",
			"Review areas in parallel",
			"Deduplicate and completeness gate",
		]);
		expect(r.reviewedSlices).toBe(1);
		expect(c[1].options.model).toBe("review");
	});
	test("review fan-out and read-only isolation are stable", async () => {
		const c: Call[] = [],
			p: string[] = [],
			slices = ["a", "b"].map((id) => ({ id, paths: [id], rationale: "r" }));
		const out: Record<string, Outcome> = {
			"map-areas": slices,
			"verify-findings": { findings: [], reviewedSlices: 2, complete: true },
		};
		for (const s of slices) out[`review:${s.id}`] = [];
		await review.run(context({ base: "b" }, out, c, p));
		expect(c.filter((x) => x.options.id?.startsWith("review:")).length).toBe(2);
		expect(c[1].options).toMatchObject({
			isolation: { mode: "none" },
			apply: false,
			schemaMode: "strict",
		});
	});
	test("review rejects incomplete gate", async () => {
		const out: Record<string, Outcome> = {
			"map-areas": [{ id: "a", paths: ["a"], rationale: "r" }],
			"review:a": [],
			"verify-findings": { findings: [], reviewedSlices: 0, complete: false },
		};
		await expect(
			review.run(context({ base: "b" }, out, [], [])),
		).rejects.toThrow("completeness");
	});
	test("research gathers six batches and cross-checks each distinct source", async () => {
		const c: Call[] = [],
			p: string[] = [],
			sources = ["a.com", "b.com"].map((x, i) => src(`https://${x}`, `S${i}`));
		const out: Record<string, Outcome> = {};
		for (let i = 1; i <= 6; i++) out[`source:${i}`] = [sources[(i - 1) % 2]];
		for (let i = 1; i <= 2; i++)
			out[`cross-check:${i}`] = {
				source: sources[i - 1],
				claims: [
					{
						claim: "c",
						sources: sources.map((x) => x.url),
						supportCount: 2,
						verified: true,
					},
				],
			};
		out.synthesize = {
			answer: "answer",
			sources,
			claims: [
				{
					claim: "c",
					sources: sources.map((x) => x.url),
					supportCount: 2,
					verified: true,
				},
			],
			crossChecked: true,
		};
		const r = await research.run(
			context({ question: "q", maxSources: 2, minSupport: 2 }, out, c, p),
		);
		expect(p).toEqual([
			"Gather independent sources",
			"Cross-check claims",
			"Synthesize and enforce provenance",
		]);
		expect(c.filter((x) => x.options.id?.startsWith("source:")).length).toBe(2);
		expect(
			c.filter((x) => x.options.id?.startsWith("cross-check:")).length,
		).toBe(2);
		expect(r.crossChecked).toBe(true);
	});
	test("research uses strict schema and research model/toolset", async () => {
		const c: Call[] = [],
			s: string[] = [],
			sources = [src("https://a.com"), src("https://b.com")];
		const out: Record<string, Outcome> = {};
		for (let i = 1; i <= 6; i++) out[`source:${i}`] = [sources[(i - 1) % 2]];
		for (let i = 1; i <= 2; i++)
			out[`cross-check:${i}`] = { source: sources[i - 1], claims: [] };
		out.synthesize = { answer: "a", sources, claims: [], crossChecked: true };
		await research.run(context({ question: "q", maxSources: 2 }, out, c, s));
		expect(c[0].options).toMatchObject({
			model: "research",
			effort: "high",
			toolset: ["web-research"],
			isolation: { mode: "none" },
			apply: false,
			schemaMode: "strict",
		});
	});
	test("research rejects too few distinct sources", async () => {
		const out: Record<string, Outcome> = {};
		for (let i = 1; i <= 6; i++) out[`source:${i}`] = [src("https://same.com")];
		await expect(
			research.run(context({ question: "q" }, out, [], [])),
		).rejects.toThrow("distinct sources");
	});
	test("research rejects malformed synthesis URL", async () => {
		const c: Call[] = [],
			out: Record<string, Outcome> = {};
		const sources = [src("https://a.com"), src("https://b.com")];
		for (let i = 1; i <= 6; i++) out[`source:${i}`] = [sources[(i - 1) % 2]];
		for (let i = 1; i <= 2; i++)
			out[`cross-check:${i}`] = { source: sources[i - 1], claims: [] };
		out.synthesize = {
			answer: "a",
			sources: [sources[0], src("ftp://bad")],
			claims: [],
			crossChecked: true,
		};
		await expect(
			research.run(context({ question: "q" }, out, c, [])),
		).rejects.toThrow("invalid URL");
	});
	test("research rejects insufficient per-claim support", async () => {
		const out: Record<string, Outcome> = {},
			sources = [src("https://a.com"), src("https://b.com")];
		for (let i = 1; i <= 6; i++) out[`source:${i}`] = [sources[(i - 1) % 2]];
		for (let i = 1; i <= 2; i++)
			out[`cross-check:${i}`] = { source: sources[i - 1], claims: [] };
		out.synthesize = {
			answer: "a",
			sources,
			claims: [
				{
					claim: "c",
					sources: ["https://a.com"],
					supportCount: 1,
					verified: true,
				},
			],
			crossChecked: true,
		};
		await expect(
			research.run(context({ question: "q" }, out, [], [])),
		).rejects.toThrow("Unsupported claim");
	});
	test("fake context all-settles partial failures when nonfatal", async () => {
		const settled: unknown[] = [];
		const c = context({}, { a: 1, b: new Error("partial") }, [], []);
		const values = await c.parallel?.(
			[() => c.agent("", { id: "a" }), () => c.agent("", { id: "b" })],
			false,
		);
		settled.push(...values);
		expect(settled).toEqual([1]);
	});
});
