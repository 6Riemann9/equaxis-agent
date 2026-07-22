# 衡枢 Equaxis Agent

**Equaxis — Reliable Agent Runtime powered by Pi**

衡枢 Equaxis 是一个“官方 Pi Coding Agent + Reliability Harness + Agent Memory”的生产级 Agent 工程样例。

它不是用 Python 重新实现 Pi，也不是套壳聊天页面。模型调用、TUI、工具、会话、分支、模型切换和扩展系统都由官方 `@earendil-works/pi-coding-agent` 提供；本项目只通过 Pi 的 Extension API 增加确定性的安全治理。

```text
┌───────────────────────────────────────────────────────────┐
│                 Official Pi Coding Agent                  │
│  TUI · Models · Sessions · Branching · read/bash/edit/... │
└────────────────────────────┬──────────────────────────────┘
                             │ Pi Extension events
┌────────────────────────────▼──────────────────────────────┐
│                  Reliability Harness                     │
│ Policy · Guardrail · HITL · State · Trace · Evaluation   │
└────────────────────────────┬──────────────────────────────┘
                             │ governed memory operations
┌────────────────────────────▼──────────────────────────────┐
│                    Agent Memory Core                      │
│ Short-term · ChromaDB · Knowledge Graph · Dream Core     │
└───────────────────────────────────────────────────────────┘
```

## 快速开始

要求 Node.js 22.19+、Python 3.10+。

```powershell
git clone <repository-url> equaxis-agent
cd equaxis-agent
npm install
npm run setup:memory
npm run verify:full
npm run equaxis -- --approve
```

`npm run equaxis -- --approve` 启动完整 Pi TUI，并显式加载 Equaxis Harness。第一次运行时，`--approve` 表示信任当前项目的 `.pi` 本地资源。后续可以按你的 Pi 配置直接启动：

```powershell
# 完整 Pi + 强制治理（默认）
npm run equaxis

# 审计但不拦截，用于观察策略命中情况
npm run equaxis -- --equaxis-mode audit

# 关闭全部扩展，确认原始 Pi 仍可独立使用
npm run pi:raw

# JSON 模式；高风险动作因没有审批 UI 而默认拒绝
npm run pi:json -- "检查项目并修复问题"
```

Pi 的 API Key、模型配置、快捷键和会话操作保持原样。可在 TUI 中使用 Pi 自带的模型切换、会话恢复和分支功能。

## 默认模型

Equaxis 默认注册并选择：

- Provider：`openai-inprior`
- Model：`gpt-5.5`
- API：OpenAI Responses
- Base URL：`https://api.inprior.com`
- Context：1,000,000 tokens
- Max output：100,000 tokens
- Thinking：`xhigh`
- Response storage：关闭，Responses 请求固定使用 `store: false`
- Auto compaction：约 900,000 tokens 时触发，为回复预留 100,000 tokens

凭据读取顺序是环境变量 `OPENAI_API_KEY`，然后是本地文件 `.equaxis/credentials/openai.key`。该目录已被 Git 忽略。Provider 定义位于 [`.pi/extensions/provider.ts`](.pi/extensions/provider.ts)，默认模型设置位于 [`.pi/settings.json`](.pi/settings.json)。

## Memory 能做什么

- 在 `before_agent_start` 自动召回身份、持久记忆、近期历史和相关向量记忆。
- 自动记录每轮用户输入和最终助手回复，形成跨 Pi 会话的短期历史。
- 提供 `memory_search`、`memory_remember`、`memory_add_fact`、`memory_query_entity` 四个模型工具。
- 用 ChromaDB 保存长期语义记忆，用 SQLite 保存时序知识图谱。
- Python Core 通过常驻 JSONL Bridge 连接 Node/Pi，避免每次调用都重启 Python。
- Memory 写操作仍经过 Harness；疑似明文凭据不会写入自动历史或注入模型上下文。

Memory 数据默认位于 `.equaxis/memory/`，已加入 `.gitignore`。配置文件是 [`.pi/memory.json`](.pi/memory.json)，详细设计见 [Memory 集成说明](docs/MEMORY.md)。

## Web Crawl 能做什么

- 提供 `web_crawl` 模型工具，用于抓取公开 HTTP/HTTPS 网页并提取标题、正文和链接。
- 支持限制 `maxPages`、`maxDepth`、`sameOrigin`、`maxCharsPerPage` 和 `timeoutMs`。
- 默认阻止 localhost、内网、保留地址、`.local` 等目标，也拒绝带用户名/密码的 URL。
- 默认不跟随跨源链接；重定向会在每一跳前重新做地址安全检查。

人工调试可在 TUI 中使用 `/web-fetch <url>` 抓取单页。

## Harness 能做什么

- 在 `tool_call` 执行前进行确定性风险分类，而不是让 LLM 自己决定是否安全。
- 在 SDK Schema 之后执行统一参数语义校验，拦截空路径、空命令、非法 URL 等无效调用，并记录可修复的结构化错误信息。
- 对同一 `tool + errorCode + field` 最多允许两次修复反馈，第三次返回 `REPAIR_EXHAUSTED`，避免模型无限循环。
- 对递归删除、破坏性 Git、提权、磁盘操作等高风险动作弹出单次人工审批。
- 在 JSON/print 等无审批 UI 模式下拒绝高风险动作。
- 阻止写入 `.env`、`.git/`、密钥文件等受保护路径。
- 检测工具参数中疑似明文凭据，避免凭据进入工具和审计日志。
- 解析已有 symlink 的真实路径边界；未注册扩展工具默认按 medium risk 处理，不再隐式信任。
- 提供 `tool_search` 工具目录：按 namespace 和关键词返回 Top-K 候选，支持工具渐进式披露，避免大工具集盲选。
- 提供 `tool_schedule` DAG 计划器：并行安全只读任务，隔离写入和高风险任务，并检测依赖环与未知依赖。
- 提供可复用异步执行内核：有界 Worker Pool、AbortSignal 取消传播、稳定幂等键、逆序补偿和 wave 后动态重排。
- 提供 Result Middleware：区分 transport success 与业务可用结果，校验必需字段、证据、空结果和自定义语义 predicate。
- 提供 MCP Result Adapter：将 text、structuredContent、resource 和 protocol error 归一到 Canonical Envelope，同时保留脱敏前需审计的 raw payload 边界。
- 提供可运行的 stdio MCP Server 核心：实现 initialize、tools/list、tools/call、JSON-RPC 错误隔离和测评工具示例。
- 提供 Context Budget Manager：工具/Skill 目录常驻、候选 Top-K 激活、硬 Token 预算裁剪和 Skill manifest 压缩。
- 限制单轮工具调用总数和高风险调用数，抑制失控循环。
- 将决策、审批、耗时和结果写入 `.pi/runtime/traces.jsonl`。
- 用 Pi 自定义 Session Entry 保存状态，在 fork/tree 切换后按当前分支恢复。
- 在每轮结束生成 failure rate、guardrail rate 等轻量 Eval 快照。

## TUI 命令

| 命令 | 用途 |
|---|---|
| `/equaxis` | 查看当前模式、阶段和累计计数 |
| `/equaxis-mode enforce\|audit\|off` | 动态切换治理模式 |
| `/equaxis-policy` | 查看当前保护路径和调用上限 |
| `/equaxis-trace` | 查看审计日志文件位置 |
| `/equaxis-eval` | 查看当前 Eval 指标 |
| `/memory` | 查看短期、长期和知识图谱状态 |
| `/memory-search <query>` | 手动搜索长期记忆 |
| `/memory-restart` | 重启 Memory Python Bridge |
| `/memory-path` | 查看 Memory 数据目录 |
| `/web-fetch <url>` | 抓取一个公开网页并显示提取文本 |

修改 `.pi/extensions/*` 或 Bridge 代码后，可在 TUI 中先执行 `/reload` 重新加载扩展，再执行 `/memory-restart` 重启常驻 Python Memory Bridge。

状态栏会显示类似：

```text
Equaxis enforce · planning · high · blocked 1
```

## 三种模式

- `enforce`：执行策略拦截，并对可审批的高风险操作请求 HITL。
- `audit`：记录普通命中项但允许继续，适合上线前调策略；疑似明文凭据仍会硬阻断。注意这不是完整安全执行模式。
- `off`：Extension 不注入约束、不分类也不记录工具事件，Pi 本体照常工作。

默认配置位于 [`.pi/reliability.json`](.pi/reliability.json)，策略实现位于 [`src/policy.mjs`](src/policy.mjs)，Pi 适配层位于 [`.pi/extensions/reliability-harness.ts`](.pi/extensions/reliability-harness.ts)。

## 验证

```powershell
npm run verify
npm run test:memory
npm run verify:full
npm run equaxis -- --version
npm run equaxis -- --help
```

当前锁定 Pi `0.80.10`，避免演示时因上游版本漂移导致事件 API 行为变化。

## 项目文档

- [架构设计](docs/ARCHITECTURE.md)
- [策略说明](docs/POLICY.md)
- [Memory 集成说明](docs/MEMORY.md)
- [模型 Provider 配置](docs/PROVIDER.md)

官方项目入口：https://pi.dev/
