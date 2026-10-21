# Equaxis File Architecture

本文档按当前工作树整理 Equaxis 的整体架构和文件职责。目标是让你能回答两个问题：

- Equaxis 运行时到底由哪些层组成？
- 仓库里的每一个核心文件分别负责什么？

注意：`harbor_eval/benchmark-*` 下有大量同构 benchmark task 文件，本文不会把每一道题的 `instruction.md` 逐个重复解释，而是列出任务名，并说明每个 task 目录内的固定文件模板。`node_modules/`、`.git/`、`.equaxis/`、`.pi/runtime/`、`harbor_eval/jobs/` 属于依赖或运行数据，不是源代码架构的一部分。

## System Overview

Equaxis 不是重新实现 Pi Agent。它的核心设计是：

```text
Official Pi Coding Agent
  -> model provider
  -> TUI
  -> native tools
  -> session / branch
  -> extension event bus

Equaxis Extensions
  -> provider registration
  -> reliability harness
  -> memory bridge
  -> web crawler
  -> tool catalog
  -> tool scheduler
  -> harness panel

Equaxis Core Modules
  -> policy
  -> config
  -> trace
  -> validation
  -> repair
  -> result middleware
  -> evaluation core

External / Vendored Runtime
  -> Python Agent Memory
  -> ChromaDB
  -> SQLite knowledge graph
  -> Harbor evaluation jobs
```

运行时链路：

```text
npm run equaxis
  -> scripts/equaxis.mjs
  -> load .pi/equaxis.json
  -> validate .pi/extensions/contracts.json
  -> spawn Pi CLI with --extension entries
  -> Pi emits extension events
  -> Equaxis extensions add provider, policy, tools, memory, trace and eval
```

## Source Of Truth

当前 Equaxis 有三份主要契约：

| Contract | File | Purpose |
|---|---|---|
| Unified Config | `.pi/equaxis.json` | 统一配置入口，覆盖 runtime、extensions、reliability、memory |
| Config Schema | `.pi/equaxis.schema.json` | `.pi/equaxis.json` 的机器可读 JSON Schema |
| Extension Manifest | `.pi/extensions/contracts.json` | 声明每个 extension 的入口、Pi 版本范围、依赖、能力和失败模式 |

旧配置仍可作为 fallback：

| Legacy file | Purpose |
|---|---|
| `.pi/reliability.json` | 旧版 reliability 配置 |
| `.pi/memory.json` | 旧版 memory 配置 |

当 `.pi/equaxis.json` 存在时，它是权威配置。

## Top-Level Files And Directories

| Path | Role |
|---|---|
| `README.md` | GitHub 首页说明：定位、快速开始、架构、评测、安全模型和文档入口 |
| `package.json` | npm 脚本、依赖、bin 入口和项目元数据 |
| `package-lock.json` | npm 依赖锁定文件 |
| `tsconfig.json` | TypeScript 类型检查配置 |
| `.gitignore` | 忽略本地凭据、运行数据、缓存、Harbor jobs 等 |
| `agent-system-questions.md` | Agent 系统设计问答/学习笔记，不参与运行时 |
| `.pi/` | Pi/Equaxis 配置、extension 入口和运行日志目录 |
| `.equaxis/` | 本地 Equaxis 数据目录，包含凭据和 memory 数据；不应提交 |
| `bridge/` | Node 与 Python Agent Memory 的 JSONL bridge |
| `docs/` | 架构、策略、memory、provider、评测等说明文档 |
| `harbor_eval/` | Harbor agent adapter、benchmark tasks、评测分析 CLI 和报告 |
| `scripts/` | 命令行入口和辅助脚本 |
| `src/` | Equaxis 核心 JS 模块 |
| `tests/` | Node.js 单元测试和集成测试 |
| `vendor/agent-memory/` | 内置 Python Agent Memory 项目 |
| `node_modules/` | npm 依赖生成目录 |

## `.pi/`

`.pi/` 是 Pi runtime 的项目本地配置区。

| File | Role |
|---|---|
| `.pi/equaxis.json` | 统一配置。配置 runtime profile、extension 启用/禁用、reliability 策略、memory 参数 |
| `.pi/equaxis.schema.json` | 统一配置的 JSON Schema，用于编辑器提示和结构校验 |
| `.pi/settings.json` | Pi 自身设置，例如默认 provider/model/thinking 等 |
| `.pi/reliability.json` | 旧版 reliability 配置 fallback；统一配置存在时不作为主配置 |
| `.pi/memory.json` | 旧版 memory 配置 fallback；统一配置存在时不作为主配置 |
| `.pi/runtime/` | 运行时 trace、状态、临时日志；生成数据，不应提交 |

## `.pi/extensions/`

这些文件是 Pi Extension 的实际入口。它们负责和 Pi API 交互；复杂业务逻辑通常放在 `src/`。

| File | Role |
|---|---|
| `contracts.json` | Extension contract manifest。声明 provider、reliability、memory、web-crawler、tool-catalog、tool-scheduler 等扩展的能力、依赖和兼容 Pi 版本 |
| `provider.ts` | 注册默认 `openai-inprior` provider，读取 API key，配置 Responses-compatible 模型 |
| `reliability-harness.ts` | 核心治理扩展。监听工具调用/结果/turn，执行风险分类、审批、参数校验、repair、trace、eval counters |
| `memory.ts` | Memory 扩展。启动 Python bridge，自动召回记忆，注册 `memory_search`、`memory_remember`、`memory_add_fact`、`memory_query_entity` 工具和 TUI 命令 |
| `web-crawler.ts` | 注册 `web_crawl` 工具和 `/web-fetch` 命令，调用 `src/web-crawler.mjs` 做安全网页抓取 |
| `tool-catalog.ts` | 注册 `tool_search`，给模型提供 Top-K 工具发现能力 |
| `tool-scheduler.ts` | 注册 `tool_schedule`，让模型提交 DAG/wave 工具计划，区分并行只读和串行副作用 |
| `harness-panel.ts` | 可降级 UI 面板扩展，显示 harness flow、工具调用、结果和清理命令 |

## `scripts/`

| File | Role |
|---|---|
| `equaxis.mjs` | Equaxis CLI 入口。加载统一配置、检查 extension contracts、打印 CLI banner、拼接 Pi extension 参数并启动 Pi |
| `mcp-eval-server.mjs` | 本地 MCP 评测/示例 server 入口，用于测试 MCP tools/list 和 tools/call |
| `read-provider-key.mjs` | 读取 provider API key 的小工具，优先环境变量，再读 `.equaxis/credentials/openai.key` |

## `bridge/`

| File | Role |
|---|---|
| `memory_bridge.py` | Python JSONL bridge。接收 Node 请求，分发到 `AgentMemory` 的 `context/search/remember/add_fact/query_entity` 等 action |
| `run_memory_tests.py` | 运行 vendored Agent Memory 测试的脚本 |
| `test_memory_bridge.py` | Python bridge 层测试 |

## `src/` Core Runtime

| File | Role |
|---|---|
| `cli-banner.mjs` | 生成 Equaxis CLI ASCII banner，并决定 TTY/JSON/`--no-banner` 场景是否显示 |
| `config.mjs` | Reliability 配置加载与旧配置校验逻辑 |
| `equaxis-config.mjs` | 统一配置加载、merge、校验逻辑；`.pi/equaxis.json` 的 runtime implementation |
| `extension-compat.mjs` | Extension contract 检查：manifest 结构、Pi 版本范围、依赖图、能力声明和实际加载能力 diff |
| `extension-runtime-services.mjs` | 共享 extension runtime services：config、paths、trace、diagnostics、status |
| `context-budget.mjs` | Context budget manager。负责工具/skill manifest 常驻、候选激活和硬 token 预算裁剪 |
| `cross-protocol-registry.mjs` | 跨协议工具注册表，统一 MCP、CLI、HTTP 等来源的工具发现和调用元数据 |
| `doctor.mjs` | Equaxis doctor 检查。检查 Node、Pi、配置、扩展契约、凭据等，并输出可读报告 |
| `mcp-result-adapter.mjs` | 将 MCP text、structuredContent、resource、protocol error 归一成 canonical envelope |
| `mcp-server.mjs` | 可测试的 stdio MCP server 核心，实现 initialize、tools/list、tools/call 和错误隔离 |
| `memory-bridge.mjs` | Node 端 MemoryBridge。启动 Python bridge 进程，用 JSONL request/response 调用 memory core |
| `memory-config.mjs` | 旧版 `.pi/memory.json` 配置加载与校验 |
| `memory-sharding.mjs` | Memory 热/温/冷分层和 rendezvous hashing 路由逻辑 |
| `mock-runtime.mjs` | 测试用 mock runtime，用于注入工具调用、错误、重复调用等 |
| `policy.mjs` | 核心策略模块。风险分类、敏感路径保护、外部写入判断、secret 检测、语义参数校验 |
| `reflection.mjs` | 从失败 trace 中生成 evidence-backed lesson，不为空跑凭空生成 lesson |
| `result-middleware.mjs` | Result middleware。区分 transport success 和业务可用结果，校验证据、空结果和 predicate |
| `schema-linter.mjs` | 工具 schema 质量检查，发现超大工具、缺少字段、风险 metadata 等 |
| `tool-catalog.mjs` | 工具目录和 Top-K 检索核心，实现 refresh、namespace filter、过期淘汰 |
| `tool-executor.mjs` | 可复用异步执行内核：有界 worker pool、取消传播、幂等、补偿、动态重排 |
| `tool-repair.mjs` | 工具参数 repair 反馈和同字段同错误重试上限 |
| `tool-scheduler.mjs` | DAG/wave 调度计划核心，识别依赖、并行只读、串行副作用、高风险隔离和循环 |
| `trace-store.mjs` | JSONL trace store，支持写入、脱敏和文件轮转 |
| `web-crawler.mjs` | 安全网页抓取核心。解析 URL、阻止内网/localhost、限制深度、抽正文和链接 |

## `src/evaluation/`

这是通用离线评测核心，Harbor 只是其中一个 adapter。

| File | Role |
|---|---|
| `__init__.py` | Python package 入口，导出评测公共 API |
| `schema.py` | 统一 `EvaluationRecord` 语义、默认 policy、基础设施失败码 |
| `core.py` | 评测主实现：load records、diagnose、hypotheses、experiment analysis、decision、report rendering |
| `normalize.py` | 归一化入口，目前转发 Harbor record loader；未来可接其他 runner |
| `diagnose.py` | 诊断阶段入口，导出 `diagnose` |
| `hypotheses.py` | 三层假设阶段入口，导出 `build_hypotheses` |
| `experiments.py` | A/B 实验比较入口，导出 `analyze_experiment` |
| `decisions.py` | 确定性部署决策入口，导出 `decide` |
| `reports.py` | 报告和 LLM prompt 入口，导出 `build_report`、`render_markdown`、`llm_prompt` |

## `docs/`

| File | Role |
|---|---|
| `ARCHITECTURE.md` | Equaxis 早期总架构说明 |
| `POLICY.md` | Reliability policy 和风险分类说明 |
| `MEMORY.md` | Memory 集成说明 |
| `PROVIDER.md` | Provider/API key/模型配置说明 |
| `EVALUATION_ARCHITECTURE.md` | 通用评测系统架构：EvaluationRecord、Harbor adapter、诊断、实验、决策 |
| `UNIFIED_RUNTIME.md` | 统一配置、extension manifest、runtime services 的说明 |
| `EXTENSION_COMPATIBILITY.md` | Extension contract 兼容检查和 Pi 升级流程 |
| `ARCHITECTURE_REDUCTION_DIRECTIVE.md` | 架构收敛/精简方向说明 |
| `CHAPTER_7_MODEL_POST_TRAINING_STUDY_GUIDE.md` | 第 7 章相关模型后训练学习资料 |
| `FILE_ARCHITECTURE.md` | 本文档 |

## `tests/`

`src/` 与测试文件的对应关系是**目标状态，尚未全部实现**。当前 `tests/` 下真实存在的只有：

`ast-tools`、`doctor`、`extension.integration`、`memory-audit`、`memory-visualize`、`pi-upgrade`、`policy`、`policy-shell-write`、`protocol-regression`、`runtime-root`、`skill-mcp`、`wake-linux`。

下表列出的是期望的完整覆盖；未标 ✅ 的文件仍待编写（`npm run test:protocols` 会显式列出缺失的协议测试而不是静默通过）。

| File | Covers |
|---|---|
| `cli-banner.test.mjs` | CLI banner 格式和显示条件 |
| `config.test.mjs` | 旧 reliability/memory 配置加载和安全边界 |
| `context-budget.test.mjs` | Context budget 裁剪、required context、manifest 压缩 |
| `cross-protocol-registry.test.mjs` | 跨协议工具注册、刷新、调用和事件 |
| `doctor.test.mjs` | doctor 报告和敏感凭据不泄露 |
| `extension-compat.test.mjs` | Extension manifest、版本范围、依赖图、capability diff |
| `extension-runtime-services.test.mjs` | 共享 config/trace/diagnostics/status services |
| `extension.integration.test.mjs` | 真实 Pi extension 加载、工具治理、memory/reliability 协同 |
| `mcp-result-adapter.test.mjs` | MCP 结果归一和错误保留 |
| `mcp-server.test.mjs` | MCP initialize、tools/list、tools/call 和错误隔离 |
| `memory-bridge.integration.test.mjs` | Node/Python memory bridge 集成 |
| `memory-bridge.test.mjs` | MemoryBridge UTF-8、JSONL、路径和错误处理 |
| `memory-sharding.test.mjs` | memory sharding、tier routing 和稳定 id |
| `mock-runtime.test.mjs` | mock tool calls、错误和重复调用注入 |
| `policy.test.mjs` | 风险分类、protected path、secret detection、外部写入策略 |
| `reflection.test.mjs` | evidence-backed lesson 生成 |
| `result-middleware.test.mjs` | 结果可用性、证据要求和 predicate |
| `schema-linter.test.mjs` | 工具 schema 质量检查 |
| `tool-catalog.test.mjs` | Top-K 工具检索、namespace filter、空查询 |
| `tool-executor.test.mjs` | worker pool、取消、幂等、补偿、动态重排 |
| `tool-repair.test.mjs` | repair 重试次数和不可重试错误 |
| `tool-scheduler.test.mjs` | DAG wave、并行/串行、高风险隔离、环检测 |
| `trace-store.test.mjs` | JSONL trace 脱敏和轮转 |
| `web-crawler.test.mjs` | URL 安全、正文抽取、同源爬取和重定向保护 |

## `harbor_eval/`

Harbor 是 Equaxis 的评测适配层和 benchmark 任务集。

| File | Role |
|---|---|
| `README.md` | Harbor 集成和评测命令说明 |
| `__init__.py` | Python package marker |
| `agent.py` | Harbor custom installed agent，负责把 Equaxis 作为 agent 跑进 Harbor trial |
| `analyze.py` | Harbor 旧分析脚本/报告工具 |
| `capabilities.json` | benchmark task 到 taskArea、capabilityTags、expectedSuccessRate 的 taxonomy |
| `cycle.py` | 评测 CLI：`diagnose` 和 `cycle`，可选 LLM 分析 |
| `evaluation_cycle.py` | 兼容 facade，转发到 `src.evaluation` 通用核心 |
| `generate_tasks.mjs` | 生成 deterministic benchmark dataset/tasks 的脚本 |
| `run_budgeted.py` | 按 token budget 批量运行 Equaxis/Pi-control benchmark |
| `test_analyze.py` | `analyze.py` 测试 |
| `test_evaluation_core.py` | `src.evaluation` 公共 API 测试 |
| `test_evaluation_cycle.py` | Harbor loader、诊断、假设、实验、报告测试 |

### Harbor Subdirectories

| Directory | Role |
|---|---|
| `harbor_eval/tasks/` | 早期/能力评测任务：`cli-json-format`、`prompt-injection-report`、`recursive-config-merge` |
| `harbor_eval/benchmark-dataset/` | 20 题 deterministic benchmark dataset，包含 `dataset.toml` 和 `tasks/` |
| `harbor_eval/benchmark-tasks/` | 20 题 benchmark task 的另一份任务目录，通常由生成脚本产生 |
| `harbor_eval/reports/current-baseline/` | 已生成的 baseline 报告，包含 JSON、Markdown、hypotheses 和 LLM prompt |
| `harbor_eval/jobs/` | Harbor 实际运行产物、trace、session、trial logs；生成数据，不提交 |
| `harbor_eval/__pycache__/` | Python bytecode cache，生成数据，不提交 |

### Harbor Task Template

每个 Harbor task 目录通常包含：

| Relative file | Role |
|---|---|
| `instruction.md` | 给 agent 的任务说明 |
| `task.toml` | Harbor task 元数据和入口配置 |
| `environment/Dockerfile` | Harbor trial 容器环境 |
| `environment/app/...` | 任务初始代码/数据/待修复项目 |
| `solution/solve.sh` | oracle 或参考解法 |
| `tests/test.sh` | Harbor verifier 入口 |
| `tests/verify.mjs` | Node verifier，检查任务是否完成 |

20 题 benchmark task 名：

```text
atomic-write
bounded-concurrency
csv-quotes
dedupe-stable
deep-freeze
dependency-order
env-boolean
flatten-record
group-counts
json-pointer
mask-email
merge-intervals
normalize-path
paginate
parse-duration
redact-secrets
retry-after
slugify
sort-semver
top-k
```

能力评测 task 名：

```text
cli-json-format
prompt-injection-report
recursive-config-merge
```

## `vendor/agent-memory/`

这是独立 Python Agent Memory 项目的 vendored copy。Equaxis 通过 `bridge/memory_bridge.py` 调用它。

### Python Package Files

| File | Role |
|---|---|
| `memory/__init__.py` | Python package 入口 |
| `memory/config.py` | MemoryConfig、DreamConfig、LongTermConfig、KnowledgeGraphConfig 和默认路径 |
| `memory/config_validator.py` | memory config 校验 |
| `memory/exceptions.py` | Memory 自定义异常类型 |
| `memory/loader.py` | 初始化 memory 目录结构和配置 |
| `memory/logging_config.py` | Python memory logging 配置 |
| `memory/types.py` | Message、DrawerRecord、ClosetRecord、Triple、QueryResult 等类型 |
| `memory/validation.py` | session、content、wing/room、metadata、entity 等输入校验 |

### API

| File | Role |
|---|---|
| `memory/api/agent_api.py` | 同步 `AgentMemory` 主 API：record、build_context、search、remember、add_fact、query_entity |
| `memory/api/async_agent_api.py` | async facade，基于 `asyncio.to_thread()` 包装同步 API |

### Store

| File | Role |
|---|---|
| `memory/store/short_term.py` | JSONL 短期历史、session message、cursor 和 compact |
| `memory/store/long_term.py` | ChromaDB 长期向量记忆，存 Drawer 和 Closet |
| `memory/store/knowledge_graph.py` | SQLite 知识图谱，实体和时序三元组 |
| `memory/store/manager.py` | 聚合 short-term、long-term、knowledge graph 的 façade |

### Stack

| File | Role |
|---|---|
| `memory/stack/layers.py` | MemoryStack。组织 identity、essential story、recall、semantic search 四层召回 |
| `memory/stack/context_builder.py` | 生成 LLM messages：system memory context + session messages + current user message |

### Dream

| File | Role |
|---|---|
| `memory/dream/consolidator.py` | 上下文压缩和归档 |
| `memory/dream/phase1.py` | 历史分析和候选事实提取 |
| `memory/dream/phase2.py` | 应用候选更新到长期记忆/知识图谱 |
| `memory/dream/templates/*.txt` | Dream prompt 模板 |

### Utils

| File | Role |
|---|---|
| `memory/utils/git.py` | Git 辅助函数 |
| `memory/utils/lock.py` | 文件锁/并发保护辅助 |
| `memory/utils/token.py` | token 估算和文本裁剪辅助 |

## Runtime Data

这些目录重要，但不是源码。

| Path | Role |
|---|---|
| `.equaxis/credentials/openai.key` | 本地 API key 文件；不提交 |
| `.equaxis/memory/` | 实际 memory 数据根目录 |
| `.equaxis/memory/history/history.jsonl` | 短期对话历史 |
| `.equaxis/memory/long_term/palace/` | ChromaDB 长期向量记忆 |
| `.equaxis/memory/knowledge_graph.sqlite3` | SQLite 知识图谱 |
| `.pi/runtime/traces.jsonl` | runtime trace，记录工具调用、审批、结果和错误 |
| `harbor_eval/jobs/` | Harbor job 结果、session、trace、trial log |

## Main Runtime Flows

### Startup

```text
scripts/equaxis.mjs
  -> loadEquaxisConfig()
  -> checkExtensionContracts()
  -> extensionPaths()
  -> print CLI banner when TTY
  -> spawn Pi CLI
```

### Tool Governance

```text
Pi tool_call event
  -> reliability-harness.ts
  -> policy.mjs classify + validate
  -> optional approval
  -> trace-store.mjs
  -> tool result / repair feedback
```

### Memory

```text
session_start
  -> memory.ts starts MemoryBridge
  -> memory-bridge.mjs spawns bridge/memory_bridge.py
  -> Python AgentMemory opens .equaxis/memory

before_agent_start
  -> memory.ts requests context
  -> memory_bridge.py calls AgentMemory.build_context()
  -> ChromaDB / JSONL / Markdown durable files are composed
  -> memory block appended to system prompt

agent_end
  -> assistant text recorded to short-term history
```

### Evaluation

```text
Harbor result.json + harness trace
  -> harbor_eval.cycle
  -> src.evaluation.normalize/core
  -> diagnose task table + capability matrix
  -> build hypotheses
  -> compare experiments
  -> deterministic decisions
  -> reports
```

## How To Find A File By Question

| Question | Start here |
|---|---|
| Why was a tool blocked? | `src/policy.mjs`, `.pi/extensions/reliability-harness.ts`, `.pi/runtime/traces.jsonl` |
| Where is memory stored? | `.pi/equaxis.json`, `src/memory-bridge.mjs`, `bridge/memory_bridge.py`, `.equaxis/memory/` |
| How is the model registered? | `.pi/extensions/provider.ts`, `scripts/read-provider-key.mjs`, `.pi/settings.json` |
| How are extensions selected? | `.pi/extensions/contracts.json`, `src/extension-compat.mjs`, `scripts/equaxis.mjs` |
| How does `tool_search` work? | `.pi/extensions/tool-catalog.ts`, `src/tool-catalog.mjs` |
| How does `tool_schedule` work? | `.pi/extensions/tool-scheduler.ts`, `src/tool-scheduler.mjs` |
| How does web crawl stay safe? | `.pi/extensions/web-crawler.ts`, `src/web-crawler.mjs`, `src/policy.mjs` |
| How is evaluation computed? | `src/evaluation/core.py`, `harbor_eval/cycle.py`, `harbor_eval/capabilities.json` |
| How do I check project health? | `scripts/equaxis.mjs --doctor`, `src/doctor.mjs` |

## Maintenance Notes

- New Pi extensions should be added to `.pi/extensions/contracts.json`.
- New extension config should go into `.pi/equaxis.json` and `.pi/equaxis.schema.json`.
- Extension runtime code should use `src/extension-runtime-services.mjs` when possible.
- Complex business logic should live in `src/`, not directly inside `.pi/extensions/*.ts`.
- Generated data should stay in `.equaxis/`, `.pi/runtime/`, or `harbor_eval/jobs/`, not in source directories.
- New core modules should get a matching `tests/*.test.mjs`.
- New Harbor tasks should follow the task template above and update `harbor_eval/capabilities.json` when they are part of the capability benchmark.
