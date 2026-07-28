# AGENTS.md

## Project shape

This is a prior-art OMP extension, not the toolbox's full-stack golden-project scaffold. Keep it a standalone TypeScript package with pnpm, strict ESM TypeScript, Biome, and Bun's test runner.

## Rules

- Keep the extension entrypoint shallow: `src/extension.ts` should only compose narrowly scoped modules; move runtime concerns into dedicated files when implementation begins.
- Do not add a database, backend, frontend, Docker, or unrelated abstraction. CI and release automation must remain limited to validating and publishing this standalone package.
- Do not use private OMP internals. Integrate through supported public extension APIs and `runSubprocess()` only.
- Generated workflow code must remain inspectable and require explicit approval before execution; never describe OMP eval as a sandbox.
- Keep dependency versions exact and update all callers when contracts change.
- Tests must assert observable behavior and contracts, not source-text snapshots or implementation trivia.
- Run focused tests and typechecking for changes; avoid broad formatter/linter sweeps during scaffold work.
- For substantial implementation work, define cross-lane contracts first, then dispatch independent Luna worker lanes in parallel; serialize only true dependencies and final integration.
