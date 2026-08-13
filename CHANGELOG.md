# Changelog

All notable changes to Equaxis are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.3.1] - 2026-08-13

### Changed
- README: removed the Default Provider section (provider configuration lives in .pi/settings.json, .pi/extensions/provider.ts and docs/PROVIDER.md).
- Subagent budgets now default to a 60s timeout and 1 retry (subagents.budgets); a timeout is terminal and is never auto-retried, retries are reserved for transient executor failures.
- Subagent result schema validation now uses TypeBox (typebox/value) instead of the flat type/required checks — nested objects, arrays (items), enums and unions are validated with readable errors.
- Web approvals are event-driven: the harness watches the decisions directory (fs.watch) and wakes immediately on a decision, with bounded polling only as a fallback.
- New /equaxis-mission command: tracks the current objective, status, turns and last outcome across turns and forks (persisted with the session; secret-like prompts are never recorded).
- Harness now reports and drops tool calls that never delivered a tool_result before turn end (tool_pending_dropped), instead of leaking them in the pending map.
- High-risk approvals are now structured dialogs: approve / deny / deny-and-rephrase (the model is told what to avoid) / approve-all-high-risk-calls-this-turn (approval.batchPerTurn, opt-in per turn). Config: reliability.approval.denyRephrase, reliability.approval.batchPerTurn.
- Loop stop condition: the same tool call repeated consecutively within a turn is blocked (limits.maxRepeatedCalls, default 3) with a loop_stop_triggered trace event.
- Failed subagent output is spilled to .pi/runtime/subagents/artifacts/<id>-attempt<N>.out; the failure message carries the stderr tail and the artifact path for diagnosis.

## [0.3.0] - 2026-08-13

### Added
- Web approval queue: high-risk calls in headless sessions (pi-web, subagents, `--mode json`) now wait for a decision from the pi-web Approvals panel instead of being blocked; TUI approval flow unchanged. Config: `reliability.approval.webQueue`.
- Cost aggregation: session token/cost usage (per provider/model + per session) shown in the harness dashboard Overview.
- Memory bridge self-healing: unexpected Python process exits trigger automatic restart with exponential backoff (5 attempts).
- npm package slimming: `files` allowlist; publishable at `equaxis-agent@0.3.0`.

### Changed
- Vendored pi-web fork moved into the repo (`pi-web/`) so all web dashboards survive fresh clones; `npm run setup` installs and builds it.

## [Unreleased]

### Added
- Release gate: release runs npm pack --dry-run --json and fails when the tarball is missing .pi/equaxis.json, .pi/extensions/contracts.json or .pi/settings.json, or when harbor_eval/jobs/ or harbor_eval/reports/ runtime data leaks into the package.
- setup installs the vendored extension tree (.pi/extensions/vendor/my-pi-setup) dependencies when missing.
- Vendored extension tree is tracked in git (nested .git/node_modules removed); npm files now ship the .pi/ runtime files (config, schema, settings, extensions).
- Productization: MIT license, npm pack-able package manifest, CI workflow, one-command setup script.

### Changed
- Memory starts lazily: the Python bridge is no longer spawned at session start; it starts on first memory tool use, an explicit /memory command, or when autoRecall is enabled at agent start. Dream consolidation on shutdown defaults to off (memory.dream.onShutdown).
- Evaluation is fully off the runtime path: the reliability harness no longer imports or persists an EvalLoop; tool outcomes are written to the trace stream only (eval_outcome_recorded). Offline consumers (equaxis eval snapshot/export-harbor, runtime dashboard, harness snapshot) rebuild full history from the trace stream (including rotated archives) merged with the offline ledger, deduped by traceId.
- Runtime profiles are now real: runtime.profile (raw/minimal/standard/full) selects which extensions load; standard (default) = governance core + local engineering tools; memory/skills/subagents/web-crawler/pi-web/vendor extensions require full or an explicit extensions.enabled entry. Profile is recorded in the session_start trace, and reported by doctor and the runtime dashboard.
- Memory reliability: `/memory-export` and `/memory-repair` commands, doctor checks for memory store integrity and embedding readiness.
- Explicit embedding model wiring (Chroma `embedding_function` derived from `long_term.embedding_model`).
- Subagent engine integration test exercising the DAG runtime + persistence end to end.
- pi-web fork: memory atlas with editing, harness dashboard (overview/events/failures/files/eval/harbor), Obsidian-style knowledge graph.

### Fixed
- pi-web launch on Windows: the `/pi-web` command wrapped the server in `cmd /c "set ... && ..."`, whose nested quotes Node escapes as `\"` and cmd misparses — the server never started and the command timed out with "did not become ready". `launchPiWeb` now spawns the launcher directly with the agent/session dirs passed through the spawn `env` option (works on every platform, no shell quoting).
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
