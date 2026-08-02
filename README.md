# 衡枢 Equaxis Agent

Reliable agent runtime powered by the official Pi Coding Agent.

![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933)
![Python](https://img.shields.io/badge/python-%3E%3D3.10-3776AB)
![Pi](https://img.shields.io/badge/pi-0.80.10-111111)
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
npm install
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
| Tool Catalog | `tool_search` exposes a small ranked candidate set instead of dumping every tool into context |
| Tool Scheduler | `tool_schedule` builds DAG waves for safe parallel reads and serialized side effects |
| Result Middleware | Distinguishes transport success from business-usable output with evidence and predicate checks |
| MCP Adapter | Normalizes text, structured content, resources and protocol errors into one envelope |
| Context Budget | Keeps tool/skill manifests compact and trims activated context under a hard token budget |
| Memory | Short-term history, long-term semantic memory, knowledge graph, and governed memory writes |
| Web Crawl | Public HTTP/HTTPS crawler with localhost/private-network blocking and redirect checks |
| Trace | JSONL audit trail for decisions, approvals, tool timings and results |
| Evaluation | Harbor adapter, capability matrix, layered hypotheses, A/B analysis and deployment decisions |

## Commands

```powershell
# Full Pi + Equaxis extensions
npm run equaxis

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
| `/memory` | Show memory status |
| `/memory-search <query>` | Search long-term memory |
| `/memory-restart` | Restart the Python memory bridge |
| `/web-fetch <url>` | Fetch and extract one public web page |

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

Equaxis includes a deterministic improvement cycle for agent quality work.

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

## Default Provider

Equaxis registers a Pi provider named `openai-inprior` and defaults to:

| Setting | Value |
|---|---|
| Model | `gpt-5.5` |
| API | OpenAI Responses-compatible endpoint |
| Base URL | `https://api.inprior.com` |
| Thinking | `xhigh` |
| Context | `1,000,000` tokens |
| Max output | `100,000` tokens |
| Storage | `store: false` |

Provider configuration lives in [`.pi/extensions/provider.ts`](.pi/extensions/provider.ts) and [`.pi/settings.json`](.pi/settings.json). Credentials are read from `OPENAI_API_KEY` first, then `.equaxis/credentials/openai.key`.

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

The project currently pins Pi `0.80.10` to avoid upstream event API drift during reliability and evaluation work.

Official Pi entry point: https://pi.dev/
