# OMP/Luna evaluation harness

The harness is intentionally dry-run by default and never passes `--auto-approve`.

```sh
pnpm exec tsx scripts/eval/harness.ts --list-cases
pnpm exec tsx scripts/eval/harness.ts --dry-run --plugin-dir ./dist
```

Paid acceptance execution is explicit and requires three clean repetitions per case:

```sh
pnpm exec tsx scripts/eval/harness.ts --run-acceptance --plugin-dir ./dist
```

Each case gets a fresh Git fixture and `.omp` profile/session directories. One-shot cases use `-p --mode json`; lifecycle cases use RPC. Captured process output is the raw evidence boundary; assertions must inspect journal, transcript, artifacts, handles, usage, and Git diff rather than trusting model prose.

The matrix contract is in `tests/fixtures/verification-matrix.json` and focused harness self-tests are in `tests/integration/eval-harness.test.ts`.
