#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MODEL = "openai-codex/gpt-5.6-luna";
export const THINKING = "low";
export const CASES = [
  "stable-replay", "nested-replay", "crash-after-dispatch", "unknown-reconciliation", "pause", "stop", "stale-controller",
  "strict-schema", "permissive-schema", "all-settled-fan-out", "fatal-fan-out", "shared-concurrency", "agent-limit", "token-runtime-limit",
  "underlying-timeout", "model-routing", "named-toolset-reresolution", "isolation-fail-closed", "capture-only", "approval-invalidation",
  "argument-validation", "primary-backup-recovery", "persistence-degraded", "lease-ownership", "cross-platform-storage", "session-reload-continuity",
  "invalid-control-transition", "research-provenance",
] as const;
export type CaseName = typeof CASES[number];

export type Capture = { command: string[]; exitCode: number; stdout: string; stderr: string; transcript?: string; journal?: string; diff?: string; artifacts?: string[]; handles?: string[]; usage?: unknown };
export type HarnessOptions = { omp?: string; pluginDir: string; repetitions?: number; root?: string; run?: boolean };

export async function isolatedFixture(root = tmpdir()) {
  const dir = await mkdtemp(join(root, "omp-workflows-eval-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, ".omp", "workflow-runs"), { recursive: true });
  await writeFile(join(dir, "fixture.txt"), "clean\n");
  return dir;
}

export function commandForCase(caseName: CaseName, fixture: string, profile: string, session: string, pluginDir: string, omp = "omp") {
  const rpc = new Set(["pause", "stop", "stale-controller", "session-reload-continuity", "approval-invalidation", "invalid-control-transition"]);
  const args = ["--model", MODEL, "--thinking", THINKING, "--plugin-dir", pluginDir, "--profile", profile, "--session-dir", session];
  if (rpc.has(caseName)) args.push("--rpc"); else args.push("-p", "--mode", "json");
  args.push(`workflow eval --case ${caseName} --fixture ${fixture}`);
  return [omp, ...args];
}

export async function runOne(caseName: CaseName, options: HarnessOptions): Promise<Capture> {
  if (!options.run) throw new Error("paid execution disabled; pass --run-acceptance explicitly");
  const fixture = await isolatedFixture(options.root);
  const profile = join(fixture, ".omp", "profile");
  const session = join(fixture, ".omp", "session");
  await mkdir(profile, { recursive: true }); await mkdir(session, { recursive: true });
  const command = commandForCase(caseName, fixture, profile, session, options.pluginDir, options.omp);
  try {
    const result = await exec(command[0], command.slice(1), { cwd: fixture, maxBuffer: 16 * 1024 * 1024 });
    return { command, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { command, exitCode: Number(e.code ?? 1), stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

export async function runGate(options: HarnessOptions) {
  const repetitions = options.repetitions ?? 3;
  if (repetitions < 3) throw new Error("acceptance gate requires three clean repetitions");
  const captures: Record<string, Capture[]> = {};
  for (const name of CASES) {
    captures[name] = [];
    for (let i = 0; i < repetitions; i++) captures[name].push(await runOne(name, options));
  }
  return captures;
}

function usage() { console.log("usage: tsx scripts/eval/harness.ts --list-cases | --dry-run [--plugin-dir DIR] | --run-acceptance --plugin-dir DIR"); }
const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.includes("--list-cases")) { console.log(CASES.join("\n")); process.exit(0); }
  const pluginDir = argv[argv.indexOf("--plugin-dir") + 1] ?? join(process.cwd(), "dist");
  if (!argv.includes("--run-acceptance")) {
    usage(); for (const name of CASES) console.log(`${name}: ${commandForCase(name, "<fixture>", "<profile>", "<session>", pluginDir).join(" ")}`);
    process.exit(0);
  }
  runGate({ pluginDir, run: true }).then(c => console.log(JSON.stringify(c, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
