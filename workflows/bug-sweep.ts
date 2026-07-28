import { defineWorkflow } from '@ramarivera/omp-workflows';

type Args = { root: string; maxRounds?: number; maxFixesPerRound?: number };
type Finding = { id: string; path: string; message: string };
type Round = { findings: Finding[]; fixed: number; remaining: number };
type Result = { rounds: Round[]; stoppedBecause: 'two-dry-rounds' | 'limit' };
const resultSchema = { type: 'object' } as const;
export const workflow = defineWorkflow<Args, Result>({ name: 'bug-sweep', version: 1, args: { type: 'object', properties: { root: { type: 'string', minLength: 1 }, maxRounds: { type: 'integer', minimum: 1, maximum: 8 }, maxFixesPerRound: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['root'], additionalProperties: false }, limits: { maxConcurrency: 4, maxAgents: 24, maxOutputTokens: 140_000, maxRuntimeMs: 60 * 60_000 }, async run({ args, agent, phase }) {
 const maxRounds = args.maxRounds ?? 4; const maxFixes = args.maxFixesPerRound ?? 10; const rounds: Round[] = []; let quiet = 0;
 for (let round = 1; round <= maxRounds && quiet < 2; round++) { phase(`Bug scan/fix wave ${round}`); const scan = await agent<Round>(`Scan ${args.root}, fix at most ${maxFixes}, then rescan.`, { id: `wave:${round}`, agent: 'bug-fixer', model: 'coding', effort: 'high', toolset: ['repo-read', 'repo-write'], isolation: { mode: 'worktree' }, apply: true, schema: resultSchema, schemaMode: 'strict', input: { round, maxFixes } }); rounds.push(scan); quiet = scan.findings.length === 0 && scan.fixed === 0 ? quiet + 1 : 0; }
 return { rounds, stoppedBecause: quiet >= 2 ? 'two-dry-rounds' : 'limit' };
} });
