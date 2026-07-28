import { defineWorkflow } from '@ramarivera/omp-workflows';
type Args = { question: string; maxSources?: number; minSupport?: number };
type Source = { url: string; title: string; claims: string[] };
type Claim = { claim: string; sources: string[]; supportCount: number; verified: boolean };
type Report = { source: Source; claims: Claim[] };
type Result = { answer: string; sources: Source[]; claims: Claim[]; crossChecked: boolean };

const url = { type: "string", pattern: "^https?://[^\\s]+$" } as const;
const sourceSchema = { type: "object", properties: { url, title: { type: "string", minLength: 1 }, claims: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["url", "title", "claims"], additionalProperties: false } as const;
const claimSchema = { type: "object", properties: { claim: { type: "string", minLength: 1 }, sources: { type: "array", items: url, minItems: 1 }, supportCount: { type: "integer", minimum: 0 }, verified: { type: "boolean" } }, required: ["claim", "sources", "supportCount", "verified"], additionalProperties: false } as const;
const reportSchema = { type: "object", properties: { source: sourceSchema, claims: { type: "array", items: claimSchema } }, required: ["source", "claims"], additionalProperties: false } as const;
const resultSchema = { type: "object", properties: { answer: { type: "string", minLength: 1 }, sources: { type: "array", items: sourceSchema, minItems: 2 }, claims: { type: "array", items: claimSchema, minItems: 1 }, crossChecked: { type: "boolean" } }, required: ["answer", "sources", "claims", "crossChecked"], additionalProperties: false } as const;

function validateEvidence(value: unknown, minSources: number, minSupport: number) {
  if (!value || typeof value !== "object") throw new Error("Research synthesis must be an object");
  const result = value as Result;
  const urls = new Set((result.sources ?? []).map((source) => source.url).filter((item): item is string => typeof item === "string"));
  if (urls.size < minSources) throw new Error(`Research requires at least ${minSources} distinct sources`);
  for (const source of urls) if (!/^https?:\/\/[^\s]+$/.test(source)) throw new Error("Research contains an invalid URL");
  for (const claim of result.claims ?? []) {
    const distinct = new Set(claim.sources ?? []);
    if (claim.verified !== (distinct.size >= minSupport)) throw new Error("Unsupported claim was marked verified");
    for (const source of distinct) if (!urls.has(source)) throw new Error("Claim cites a source absent from synthesis");
  }
  if (result.claims?.some((claim) => claim.verified === false)) throw new Error("Research rejected unsupported claims");
  return result;
}

export const workflow = defineWorkflow<Args, Result>({
  name: "deep-research", version: 1,
  args: { type: "object", properties: { question: { type: "string", minLength: 1 }, maxSources: { type: "integer", minimum: 2, maximum: 24 }, minSupport: { type: "integer", minimum: 2, maximum: 8 } }, required: ["question"], additionalProperties: false },
  limits: { maxConcurrency: 6, maxAgents: 30, maxOutputTokens: 120_000, maxRuntimeMs: 30 * 60_000 },
  async run({ args, agent, parallel, phase }) {
    const maxSources = args.maxSources ?? 12; const minSupport = args.minSupport ?? 2;
    phase("Gather independent sources");
    const batches = await parallel(Array.from({ length: Math.min(6, maxSources) }, (_, i) => () => agent<Source[]>(`Find independent primary sources for: ${args.question}. Angle ${i + 1}.`, { id: `source:${i + 1}`, agent: "researcher", model: "research", effort: "high", toolset: ["web-research"], isolation: { mode: "none" }, apply: false, schema: { type: "array", items: sourceSchema, maxItems: Math.ceil(maxSources / 4) }, schemaMode: "strict" })), false);
    const sources = batches.flat().filter((source, i, all) => all.findIndex((candidate) => candidate.url === source.url) === i).slice(0, maxSources);
    if (sources.length < 2) throw new Error("Research requires at least two distinct sources");
    phase("Cross-check claims");
    const reports = await parallel(sources.map((source, i) => () => agent<Report>(`Cross-check ${source.url} against the other sources; report only claims supported by at least ${minSupport} distinct URLs.`, { id: `cross-check:${i + 1}`, agent: "researcher", model: "research", effort: "high", toolset: ["web-research"], isolation: { mode: "none" }, apply: false, schema: reportSchema, schemaMode: "strict", input: { source, sources } })), false);
    phase("Synthesize and enforce provenance");
    const result = await agent<Result>("Synthesize a concise answer with every claim cross-checked and source-backed.", { id: "synthesize", agent: "synthesizer", model: "reasoning", effort: "high", toolset: ["web-research"], isolation: { mode: "none" }, apply: false, schema: resultSchema, schemaMode: "strict", input: { question: args.question, sources, reports } });
    return validateEvidence(result, 2, minSupport);
  },
});
