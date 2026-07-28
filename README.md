# @ramarivera/omp-workflows

[![CI](https://github.com/ramarivera/omp-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/ramarivera/omp-workflows/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/%40ramarivera%2Fomp-workflows)](https://www.npmjs.com/package/@ramarivera/omp-workflows) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Durable, inspectable dynamic workflows for [Oh My Pi](https://github.com/can1357/oh-my-pi). Define multi-agent work as typed TypeScript, review the generated plan, approve it explicitly, and operate runs that survive interruption.

## TL;DR

**The problem:** ad-hoc agent prompts are difficult to inspect, repeat, pause, resume, and audit.

**The solution:** this OMP extension discovers versioned workflow definitions, validates arguments and agent outputs, persists run journals, and exposes both `/workflow` commands and the `workflow_control` tool.

| Capability | What it provides |
| --- | --- |
| Typed definitions | `defineWorkflow` with JSON-schema arguments and strict per-agent output schemas |
| Parallel phases | Bounded `parallel` calls with workflow limits |
| Durable runs | Atomic journals, leases, checkpoints, recovery, pause/resume/stop/retry |
| Explicit approval | Source, hash, calls, toolsets, limits, filesystem and version tuple are reviewed before execution |
| OMP-native integration | Public extension APIs and `runSubprocess()`; no private OMP internals |
| Project/user/plugin scopes | Discover workflows from `.omp/workflows`, user workflow directories, and plugin directories |

## Quick example

```ts
import { defineWorkflow } from "@ramarivera/omp-workflows";

export const workflow = defineWorkflow({
  name: "summarize-files",
  version: 1,
  args: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
  limits: { maxConcurrency: 2, maxAgents: 4, maxOutputTokens: 20_000, maxRuntimeMs: 10 * 60_000 },
  async run({ args, agent, phase }) {
    phase("Read and summarize");
    return agent("Answer the question from the repository.", {
      agent: "researcher", model: "reasoning", toolset: ["repo-read"],
      isolation: { mode: "none" }, apply: false,
      input: args,
    });
  },
});
```

```text
/workflow list
/workflow inspect deep-research
/workflow start deep-research --args '{"question":"How does X work?"}'
/workflow status <run-id>
/workflow pause <run-id>
/workflow resume <run-id>
```

## Design philosophy

1. **Inspect before execute.** Generated source and approval previews remain readable; approval is never implicit.
2. **Durability over cleverness.** Versioned journals and atomic writes make interruption recoverable.
3. **Bounded concurrency.** Definitions declare agent, token, runtime, and concurrency limits.
4. **Public seams only.** Integration uses supported OMP extension APIs and `runSubprocess()`.
5. **Honest security.** OMP evaluation is powerful and is not a sandbox; isolation and toolsets are explicit controls, not guarantees of safety.

## Installation

### npm

```nu
npm install -g @ramarivera/omp-workflows
```

### OMP package install

Install from the OMP package manager/link workflow, or link a local checkout during development:

```nu
omp plugin link /path/to/omp-workflows
```

Then ensure the extension is enabled in OMP. Published packages point the extension manifest at `dist/extension.js`.

### From source

```nu
git clone https://github.com/ramarivera/omp-workflows.git
cd omp-workflows
pnpm install --frozen-lockfile
pnpm build
omp plugin link .
```

Bash compatibility path (when Nushell is unavailable):

```bash
npm install -g @ramarivera/omp-workflows
```

## Quick start

1. Install the package and enable it in OMP.
2. Create `.omp/workflows/my-workflow.ts` in a project (or use a user/plugin scope).
3. Export `workflow = defineWorkflow(...)` and keep its source reviewable.
4. Run `/workflow generate` or `/workflow create` to author a definition with OMP assistance.
5. Run `/workflow inspect <name>` and review the approval preview.
6. Start with `/workflow start <name> --args '<json>'`; execution requires matching approval.
7. Monitor with `/workflow status <run-id>` or `workflow_control`.

## Terminal UI modes

Slash commands, approval prompts, and the persistent status widget support two presentation modes:

- `operator` (default): quiet, dense run summaries with phase, call, token, runtime, limit, and warning lines.
- `dashboard`: a restrained Unicode card with progress, budgets, counters, and an intentional idle state.

Set the mode in `~/.omp/workflows.json`:

```json
{
  "ui": "dashboard"
}
```

An absent file selects `operator` without noise. Invalid JSON or an unknown `ui` value emits a visible warning and falls back to `operator`. Approval prompts in both modes retain the full workflow source and exact SHA-256 hash verbatim. The `workflow_control` tool remains structured JSON; UI mode only changes human-facing rendering.

## `/workflow` command reference

| Command | Usage | Purpose |
| --- | --- | --- |
| `generate` | `/workflow generate <request>` | Generate a workflow proposal for review. |
| `create` | `/workflow create <request>` | Create a definition from an authoring request. |
| `start` / `run` | `/workflow start <name> [--args '<json>'] [--scope project\|user\|plugin]` | Start an approved run. `run` is an alias. |
| `list` | `/workflow list` | List discovered workflows and diagnostics. |
| `status` | `/workflow status <run-id>` | Show run state and progress. |
| `inspect` | `/workflow inspect <name-or-run-id>` | Inspect a definition or run. |
| `pause` | `/workflow pause <run-id>` | Request a durable pause. |
| `resume` | `/workflow resume <run-id>` | Resume a paused/recovered run. |
| `stop` | `/workflow stop <run-id>` | Stop a run. |
| `retry` | `/workflow retry <run-id> [call-index]` | Retry a failed call or run segment. |
| `save` | `/workflow save <run-id> --scope project\|user` | Save a generated definition at a chosen scope. |
| `revoke` | `/workflow revoke <workflow-id>` | Revoke stored approval. |
| `probe` | `/workflow probe` | Check host/runtime capabilities. |
| `help` | `/workflow help` | Show command help. |

Arguments may be passed as JSON with `--args` or `--json`; malformed JSON and unknown options fail clearly.

## `workflow_control`

The tool accepts `{ action, runId?, callIndex? }`. `list` needs no run ID; `status`, `pause`, `resume`, `stop`, and `retry` require one. Responses are JSON text, and failures include an error code, message, and allowed actions.

## Canonical workflows

The repository includes inspectable examples in [`workflows/`](workflows/):

- `deep-research`: gathers independent sources, cross-checks claims, and enforces provenance.
- `typecheck-fix`: runs diagnostic shards and bounded fix rounds until progress stops or a limit is reached.
- `changed-file-review`: reviews changed files with bounded analysis.
- `large-migration`: coordinates migration planning and implementation in isolated worktrees.
- `bug-sweep`: performs a bounded bug-finding and fix pass.

These are examples, not a promise that every repository has the required tools or that generated changes are safe to apply.

## Persistence, approval, and security

Definitions are discovered from project, user, and plugin scopes. Project definitions conventionally live in `.omp/workflows/`; run journals live in `.omp/workflow-runs/` and should be ignored by Git. Writes are atomic and runs use leases so recovery can identify interrupted work.

Before execution, the approval preview binds the workflow source hash to arguments, phases, calls, routing, limits, filesystem effects, toolsets, plugin source, and runtime/definition versions. Changing that tuple invalidates approval. Approval records can be revoked. Generated code and OMP evaluation are not a security sandbox: review source, grant only necessary toolsets, use isolation where appropriate, and set `apply: false` unless writes are intended.

## Architecture

```text
/workflow or workflow_control
          |
  command parser + operator
          |
 definition discovery/loader -- validation/hash/approval
          |
 controller -- executor -- runSubprocess() -- OMP agents
     |             |
  recovery      journal + lease + atomic storage
```

## Troubleshooting

- **Workflow not listed:** verify the file exports `workflow`, has a valid definition, and is under the selected scope; run `/workflow list` for diagnostics.
- **Approval mismatch:** inspect again and approve the current source/arguments/toolset/version tuple; edits invalidate prior approval.
- **Run cannot resume:** check the journal and lease state, then use `/workflow status`; do not delete `.omp/workflow-runs` while recovery is needed.
- **Unknown command or option:** use `/workflow help`; JSON must follow `--args` or `--json` and be valid.
- **Package loads source paths after publishing:** rebuild and verify the package uses `dist`; consumers should install the published package rather than a source checkout.

## Limitations

- OMP must be installed and compatible with the declared peer range (`17.x`).
- Workflow code runs with OMP's capabilities; this package does not provide a sandbox.
- Recovery depends on journals remaining available and writable.
- Parallel work is bounded by definition limits and host/provider availability.
- Generated changes still require human review; `apply` is an explicit capability, not a safety guarantee.

## FAQ

**Can I run a workflow without approval?** No. Execution requires a matching approval record.

**Where do definitions live?** Project `.omp/workflows/`, user workflows, or plugin-provided directories.

**Can I pause a running workflow?** Yes, with `/workflow pause` or `workflow_control`; resume after durable state is written.

**Does this sandbox agents?** No. OMP evaluation is powerful and must not be treated as a sandbox.

**Can I use these workflows outside OMP?** No; the package is an OMP extension and requires its public extension runtime.

## About Contributions

*About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

## License

MIT © Ramiro Rivera. See [LICENSE](LICENSE).
