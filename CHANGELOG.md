# Changelog

All notable changes to Equaxis are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Productization: MIT license, `npm pack`-able package manifest, CI workflow, one-command `setup` script.
- Memory reliability: `/memory-export` and `/memory-repair` commands, doctor checks for memory store integrity and embedding readiness.
- Explicit embedding model wiring (Chroma `embedding_function` derived from `long_term.embedding_model`).
- Subagent engine integration test exercising the DAG runtime + persistence end to end.
- pi-web fork: memory atlas with editing, harness dashboard (overview/events/failures/files/eval/harbor), Obsidian-style knowledge graph.

### Fixed
- Eval telemetry disconnect: reliability harness now persists `EvalLoop` events; dashboards derive full history from the trace stream (`eval_outcome_recorded`).
- `EvalLoop.decision()` records now survive restarts (`decisions` restored from the event log).
- `snapshot()` exposes `unknowns` so `successes + failures + unknowns === attempts`.
- Harbor export tolerates malformed lines and numbers attempts per logical task (pass@N correctness).
- Subagent snapshots restore non-terminal tasks as `failed` with a reason instead of dropping them (no orphaned dependents).
- `selectRelevantSkills` now honors `requiredNames`; doctor requires `skills.ts` and `subagent-engine.ts`.
- Windows `fs.readdirSync` returning empty for user-profile dirs: session listing uses `fs.promises.readdir`.
- Portable config: `externalEditRoots` supports the `<workspace>` token; LSP command no longer carries a machine-specific path.
- Memory `.cursor` corruption is repaired and `_read_int`/`_next_cursor` self-heal.

## [0.2.0] - 2026-08-13

Initial public-shaped release of the governed agent runtime: reliability harness, unified config, memory system with dream consolidation, eval loop, subagent DAG, pi-web dashboards, extension contract system.
