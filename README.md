# 衡枢 Equaxis Agent

Reliable agent runtime powered by the official Pi Coding Agent.

![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933)
![Python](https://img.shields.io/badge/python-%3E%3D3.10-3776AB)
![Pi](https://img.shields.io/badge/pi-0.83.0-111111)
![Evaluation](https://img.shields.io/badge/evaluation-Harbor-blue)

Equaxis 是一个面向真实工程环境的 Agent runtime 样例：它不重写 Pi，不包一层聊天壳，而是在官方 `@earendil-works/pi-coding-agent` 之上，通过 Extension API 加上可靠性治理、工具安全、Memory、Trace 和离线评测闭环。

它适合你研究或搭建这类系统：

- 如何给 coding agent 加确定性 guardrails，而不是让模型自己判断风险。
- 如何把工具调用、权限、结果校验、trace、memory 和评测放进同一条工程链路。
- 如何用 Harbor benchmark 把“任务失败”映射到“能力缺陷”，再做分阶段实验。

```text
Official Pi Coding Agent
  TUI · Models · Sessions · Branching · Tools · Extensions
        |
        v
Equaxis Reliability Harness
  Policy · Guardrails · HITL · Tool Repair · Trace · Evaluation
        |
        v
Agent Memory + Evaluation Core
  Short-term Memory · Knowledge Graph · Harbor Adapter · Capability Matrix
```

## Quick Start

Requirements:

- Node.js `>= 22.19`
- Python `>= 3.10`
- A Pi-compatible OpenAI API key

```powershell
git clone https://github.com/6Riemann9/equaxis-agent.git
cd equaxis-agent
npm run setup
```

`npm run setup` checks the toolchain (Node ≥22.19, Python), installs missing dependencies (npm + Python memory core), validates the unified config, and runs the doctor. For a strict local install instead:

```sh
npm install
npm run install:equaxis -- --dry-run
npm run setup:memory
npm run verify:full
```

Set your API key through either an environment variable:

```powershell
$env:OPENAI_API_KEY = "<your-api-key>"
```

or a local ignored credentials file:

```powershell
New-Item -ItemType Directory -Force .equaxis/credentials
Set-Content .equaxis/credentials/openai.key "<your-api-key>"
```

Start the full Equaxis runtime:

```powershell
npm run equaxis -- --approve
```

The first `--approve` tells Pi to trust this repository's local `.pi` extensions. After that, you can usually start with:

```powershell
npm run equaxis
```

## What You Get

| Area | What Equaxis adds |
|---|---|
| Reliability Harness | Deterministic tool risk classification, protected paths, high-risk approval, per-turn limits |
| Tool Validation | Semantic argument checks after SDK schema validation, repair feedback, retry exhaustion |
| Stale Edit Guard | Blocks exact-replacement edits when target hashes drift or `oldText` is missing/ambiguous |
| Tool Catalog | `tool_search` exposes a small ranked candidate set instead of dumping every tool into context |
| Tool Scheduler | `tool_schedule` builds DAG waves for safe parallel reads and serialized side effects |
| Subagent Runtime | Provides structured subagent spawn/status/wait/cancel lifecycle, schema checks and trace events |
| LSP Client | Provides JSON-RPC initialize/definition/diagnostics primitives, exposed through `lsp_probe` |
| DAP Client | Provides Debug Adapter Protocol initialize/launch/attach/breakpoints/stack/scopes/variables primitives, exposed through `dap_probe` |
| AST Tools | JavaScript/TypeScript symbol inspection and hash-checked single-file rename preview/application, exposed through `ast_inspect` and `ast_rename` |
| Advisor Model | Optional recommendation-only advisor hooks for high-risk tools, complex plans and result review, exposed through `advisor_consult` |
| Result Middleware | Distinguishes transport success from business-usable output with evidence and predicate checks |
| MCP Adapter | Normalizes text, structured content, resources and protocol errors into one envelope |
| Resource URI | Parses and normalizes 14 URI schemes (file/http/https/memory/tool/mcp/agent/skill/pr/issue/trace/eval/history/artifact); `agent`/`history`/`artifact` have read providers |
| Context Budget | Keeps tool/skill manifests compact and trims activated context under a hard token budget |
| Memory | Short-term history, long-term semantic memory, knowledge graph, and governed `recall / retain / reflect / learn / memory_edit` UX |
| Web Crawl | Public HTTP/HTTPS crawler with localhost/private-network blocking and redirect checks |
| Trace | JSONL audit trail for decisions, approvals, tool timings and results |
| Evaluation | Harbor adapter plus model × tool × capability × outcome telemetry, capability matrix, A/B analysis and deployment decisions |

## Commands

```powershell
# Full Pi + Equaxis extensions
npm run equaxis

# Productized local install/update/release checks
npm run install:equaxis
npm run update:equaxis -- --dry-run
npm run release:equaxis -- --dry-run

# Raw Pi, no extensions
npm run pi:raw

# JSON mode. High-risk actions are rejected when no approval UI exists.
npm run pi:json -- "inspect this repo and summarize risks"

# Static TypeScript check and Node tests
npm run verify

# Memory bridge tests
npm run test:memory

# Full local verification
npm run verify:full
```

Inside the Pi TUI:

| Command | Purpose |
|---|---|
| `/equaxis` | Show current Equaxis mode, phase and counters |
| `/equaxis-mode enforce\|audit\|off` | Switch runtime governance mode |
| `/equaxis-policy` | Show protected paths and call limits |
| `/equaxis-trace` | Show trace file location |
| `/equaxis-eval` | Show lightweight evaluation counters |
| `/equaxis-mission` | Show the current mission objective, status, turns and last outcome |
| `/memory` | Show memory status |
| `/memory-search <query>` | Search long-term memory; tool UX also exposes `recall`, `retain`, `learn`, and `memory_edit` |
| `/memory-restart` | Restart the Python memory bridge |
| `/web-fetch <url>` | Fetch and extract one public web page |

Protocol tools are available as normal Pi tools: `advisor_consult`, `lsp_probe`, and `dap_probe`. They default to in-memory probes, while explicit `mode: "process"` calls can use locked LSP/DAP adapter commands from `.pi/equaxis.json`. External adapter processes remain high-risk calls and require policy approval. AST tools are also available as `ast_inspect` and `ast_rename`; rename application requires a fresh hash from a preview.

## Runtime Modes

| Mode | Behavior |
|---|---|
| `enforce` | Default. Blocks unsafe calls and asks for human approval when Pi has an approval UI. |
| `audit` | Logs policy hits while allowing most calls. Raw secret exposure is still blocked. |
| `off` | Disables Equaxis governance and tracing. Pi continues to run normally. |

Switch modes from the TUI:

```text
/equaxis-mode audit
/equaxis-mode enforce
/equaxis-mode off
```

## Runtime Profiles

`runtime.profile` in `.pi/equaxis.json` decides which extensions load. Profiles are a selection policy, not feature flags — individual extensions can still be added/removed via `extensions.enabled` / `extensions.disabled`.

| Profile | Loads | Default |
|---|---|---|
| `raw` | No Equaxis extensions (Pi baseline) | no |
| `minimal` | Governance core: policy, approval, trace, budgets, harness status UI | no |
| `standard` | `minimal` + local in-process engineering tools (protocol probes, AST, tool catalog/scheduler) | yes |
| `full` | Everything in the manifest: memory, skills, subagents, web crawler, pi-web, vendored extensions | no |

`minimal` / `standard` never spawn the Python memory bridge, open network connections or start subagent processes; those capabilities (memory, skills, subagent engine, web crawler, pi-web) require `full` or an explicit `extensions.enabled` entry. The active profile is recorded in the `session_start` trace and reported by `npm run equaxis -- --doctor` and the runtime dashboard.

```text
runtime.profile = "full"        # everything, e.g. research/eval workflows
runtime.profile = "standard"    # default: governance + engineering tools
runtime.profile = "minimal"     # governance core only
runtime.profile = "raw"         # plain Pi, no Equaxis extensions
```

## Architecture

Equaxis keeps Pi as the real agent. The project adds deterministic layers around it.

```text
┌─────────────────────────────────────────────────────────────┐
│ Official Pi Coding Agent                                    │
│ Models · TUI · Sessions · Branches · Native Tools           │
└─────────────────────────────┬───────────────────────────────┘
                              │ Extension events
┌─────────────────────────────▼───────────────────────────────┐
│ Reliability Harness                                          │
│ Policy · Guardrails · HITL · Validation · Repair · Trace     │
└───────────────┬───────────────────────────────┬─────────────┘
                │ governed memory tools          │ eval traces
┌───────────────▼────────────────┐  ┌───────────▼─────────────┐
│ Agent Memory Core              │  │ Evaluation Core          │
│ History · Vector · Graph       │  │ Diagnose · Hypothesize   │
└────────────────────────────────┘  │ Experiment · Decide      │
                                    └─────────────────────────┘
```

Important files:

| Path | Purpose |
|---|---|
| `.pi/extensions/reliability-harness.ts` | Pi extension boundary for tool governance and trace |
| `.pi/extensions/memory.ts` | Pi extension boundary for memory recall and memory tools |
| `.pi/extensions/provider.ts` | Default model/provider registration |
| `src/policy.mjs` | Deterministic risk classification and protected-path logic |
| `src/tool-repair.mjs` | Structured argument repair feedback and retry exhaustion |
| `src/tool-scheduler.mjs` | DAG scheduling for parallel-safe tool execution |
| `src/result-middleware.mjs` | Result usability checks |
| `src/evaluation/` | Reusable evaluation core |
| `harbor_eval/` | Harbor adapter, benchmark tasks and CLI |

## Evaluation Loop

Equaxis includes a deterministic improvement cycle for agent quality work. The runtime itself only produces facts: every tool outcome is written to the reliability trace as `eval_outcome_recorded`. Evaluation never runs inside the agent loop — dashboards, `equaxis eval snapshot/export-harbor` and the cycle below rebuild full history from the trace stream (plus the offline ledger `.pi/runtime/eval-loop/events.jsonl` for manual records, candidates and decisions).

```text
Harbor results / runtime traces
  -> EvaluationRecord
  -> task table + capability matrix
  -> surface / middle / deep hypotheses
  -> baseline vs candidate experiments
  -> deploy / scoped / reject / insufficient_data
  -> Markdown + JSON reports
```

Run a baseline diagnosis from existing Harbor jobs:

```powershell
npm run eval:cycle -- diagnose `
  --job harbor_eval/jobs/equaxis `
  --taxonomy harbor_eval/capabilities.json `
  --output-dir harbor_eval/reports/cycle-001 `
  --cycle-id cycle-001
```

Run a manifest-based baseline/candidate cycle:

```powershell
npm run eval:cycle -- cycle `
  --manifest harbor_eval/cycle-002.json `
  --output-dir harbor_eval/reports/cycle-002
```

Add `--llm` only when you explicitly want a model-written analysis. Deployment decisions remain deterministic; the LLM can explain evidence and suggest next experiments, but it cannot override the rule-based decision.

See [Evaluation Architecture](docs/EVALUATION_ARCHITECTURE.md) for the full design.

## Safety Model

Equaxis is designed around explicit boundaries:

- The model may propose tool calls; deterministic policy decides whether they are allowed.
- Transport success does not mean the result is usable; result middleware checks structure and evidence.
- Memory writes are governed; suspected raw secrets are not written into memory.
- Local credentials, traces, `.git`, `.equaxis/`, `.pi/runtime/` and Harbor job outputs are not uploaded as benchmark task input.
- High-risk calls are blocked in non-interactive modes where no approval UI exists.

This is still a research and engineering sample, not a sandbox escape proof security boundary. Treat it as a practical reliability harness around Pi, not as an OS-level isolation layer.

## Repository Layout

```text
.pi/extensions/       Pi extension entry points
bridge/               Python memory bridge integration
docs/                 Architecture, policy, provider, memory and evaluation docs
harbor_eval/          Harbor agent adapter, benchmark tasks, reports and eval CLI
scripts/              CLI wrappers and local utilities
src/                  Runtime governance, scheduling, result and evaluation modules
tests/                Node.js runtime tests
vendor/agent-memory/  Vendored Python memory core
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Policy](docs/POLICY.md)
- [Memory](docs/MEMORY.md)
- [Provider](docs/PROVIDER.md)
- [Evaluation Architecture](docs/EVALUATION_ARCHITECTURE.md)
- [Harbor Evaluation](harbor_eval/README.md)

## Development

```powershell
npm run check
npm test
npm run test:memory
npm run test:eval
npm run verify:full
```

The project currently pins Pi `0.83.0` (see `package.json` and `.pi/extensions/contracts.json` `piRange`) to avoid upstream event API drift during reliability and evaluation work.

Official Pi entry point: https://pi.dev/
