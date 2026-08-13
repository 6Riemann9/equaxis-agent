# Unified Equaxis Runtime

Equaxis now has three explicit contracts:

1. `.pi/extensions/contracts.json` is the Extension Manifest.
2. `.pi/equaxis.json` is the Unified Config.
3. `src/extension-runtime-services.mjs` is the Shared Extension Runtime Services layer.

## Extension Manifest

The manifest declares:

- Pi and manifest versions.
- The unified config path and schema version.
- Runtime services available to extensions.
- Extension entries, contract versions, dependencies, capabilities and failure modes.

Core extensions use `failureMode: "fatal"`. Optional extensions use `failureMode: "degrade"`; Pi can continue without the unavailable optional capability.

## Unified Config

`.pi/equaxis.json` is now the primary configuration file. Its top-level sections are:

- `runtime`: profile and enabled shared services.
- `extensions`: manifest path and explicit enable/disable lists.
- `reliability`: policy, approval, trace, limits and tool routing.
- `memory`: Python bridge, recall and persistence settings.
- `protocols`: LSP/DAP adapter commands, arguments, working directories, request timeouts and override policy.

The old `.pi/reliability.json` and `.pi/memory.json` remain supported as migration fallbacks when `.pi/equaxis.json` does not exist. Once the unified file exists, it is authoritative.

The machine-readable schema is [`.pi/equaxis.schema.json`](../.pi/equaxis.schema.json). Runtime validation is implemented in `src/equaxis-config.mjs`.

## Protocol Adapter Configuration

External LSP and DAP processes are configured under `protocols`. Calls still need `mode: "process"`; configuration alone never starts an adapter. The reliability policy classifies process mode as high risk and applies approval before the extension executes.

```json
{
  "protocols": {
    "lsp": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "cwd": "",
      "requestTimeoutMs": 15000,
      "allowCommandOverride": false
    },
    "dap": {
      "command": "",
      "args": [],
      "cwd": "",
      "requestTimeoutMs": 15000,
      "allowCommandOverride": false
    }
  }
}
```

With `allowCommandOverride: false`, tool calls cannot replace `command`, `args`, or `cwd`. Per-call `timeoutMs` remains adjustable within the validated 100-120000 ms range. Empty commands leave the adapter unconfigured while memory probes continue to work.

DAP process calls support two request modes:

- `launch`: requires `program`; Equaxis starts it through the configured adapter.
- `attach`: requires `host` and `port`; the configured adapter connects to an existing debug server.

Both modes return a structured `session` snapshot with `phase`, stop reason, exit state, thread count and event/output counts. A process-mode call remains high risk regardless of whether it launches or attaches.

## External Edit Approval

External edits have three explicit modes:

| Mode | Behavior |
|---|---|
| `prompt` | High-risk external writes require one approval for the current call. |
| `auto` | Only paths inside `externalEditRoots` are automatically allowed. |
| `deny` | External writes are blocked. |

`auto` requires at least one root. An empty allowlist is invalid, and paths outside the allowlist still require approval or remain blocked according to the rest of the policy.

Roots are absolute paths, or the portable token `<workspace>` which resolves to the current project root at use time (so the config survives `git clone` to another machine). The current project config uses `["<workspace>"]`: auto approval only for the project root, never wildcard access to arbitrary drives or parent directories.

## Web Harness Dashboard

pi-web fork 顶栏的 **Equaxis Harness** 按钮打开实时 harness 面板（`/pi-web` 启动）：

- **实时状态**：最近会话的 `equaxis-reliability-state`（mode / phase / turnCount / toolCalls / blockedCalls / approvedCalls / failedCalls / lastRisk）。
- **健康检查**：`runDoctor` 的 18 项逐项结果 + runtime gates 状态。
- **配置摘要**：reliability / subagents / memory / evaluation / memory governance / protocols / runtime files。
- **Trace 流**：`.pi/runtime/traces.jsonl` 的事件统计（按类型计数）与最近 50 条事件（含失败详情）。

面板另有五个 tab 提供**完全追溯**：

- **Eval**：从 trace 流（`eval_outcome_recorded`，含轮转归档）派生的完整评测矩阵——attempts/successes/failures/unknowns/成功率，按 provider/model/tool/capability 分组的延迟、token、成本、错误码明细。运行时只写 trace 事实；`.pi/runtime/eval-loop/events.jsonl` 仅保留离线记录（手动 record、candidates、decisions），两者按 traceId 去重合并。
- **Harbor**：`harbor_eval/jobs/budget-v2-report.json`（equaxis vs pi_control vs gain 的 pass@1/延迟/token/安全率对比）+ 最新 `harbor_eval/reports/*/cycle-report.json`（诊断、假设、实验、决策）。两个 Python 实现是不同工具（预算对比 vs 改进周期），字段名 snake/camelCase 各异，面板按各自形状展示。

- **Events**：完整事件流（8818 条级），倒序分页（每页 100），可按事件类型 / session id / 文本搜索过滤，**failures only** 一键只看失败；点击任意行展开该事件的完整 JSON。
- **Failures**：失败事件专用视图（`failed|error|blocked|denied` 或 `isError`），独立计数，同样分页可展开。
- **Files**：运行时产物文件浏览器（traces.jsonl、protocols/subagents/eval/memory-governance、release-manifest、history.jsonl）+ 最近 30 个 session 文件；点开按行浏览（每页 200 行、行号、前后翻页）。读取被约束在 `.pi/runtime`、`.equaxis` 与项目 session 目录内。

数据来源：`scripts/harness-snapshot.mjs`（一次性 JSON 快照，~1s，无副作用），fork 的 `app/api/harness` 路由以项目根为 cwd 执行它；事件/文件浏览由 `app/api/harness/events|files|file` 直读文件实现（事件流限 64MB、单文件限 32MB/10 万行）。共享的 `lib/equaxis-project.ts` 提供 `findEquaxisRoot`、`runEquaxisScript`、`getProjectSessionDir`（优先用 `PI_CODING_AGENT_SESSION_DIR`，避免依赖服务器进程的 homedir）。

## Web 审批队列

高风险调用在 **headless 会话**（pi-web 驱动、subagent、`--mode json`）里不再被直接阻断：harness 把请求写入 `.pi/runtime/approvals/requests/<id>.json` 并轮询决策文件（`approvals/decisions/<id>.json`，默认 60s 窗口，配置 `reliability.approval.webQueue.{enabled,timeoutMs}`）。pi-web 的 Harness 面板 **Approvals** tab 显示 pending 队列（工具名、原因、命令摘要）并提供 Approve/Deny；历史决策保留最近 50 条。TUI 会话仍走交互确认，行为不变。session_start 时清理过期请求。

## 成本聚合

Harness 面板 Overview 的 **Session costs** 段从项目 session 文件聚合助手消息的 `usage`：总 token、总成本、按 provider/model 分组的 token/成本（最近 15 个会话明细）。

## Shared Runtime Services

`createExtensionRuntimeServices()` supplies:

- `config`: validated unified configuration.
- `paths`: workspace, trace and memory paths.
- `trace.record()`: common JSONL trace format with extension source metadata.
- `diagnostics.notify()`: UI diagnostics that do not break the Agent Loop.
- `status.set()`: common status updates with service-level enable/disable behavior.
- `configure()`: reload configuration and paths for a replacement session.

Reliability and Memory use this service layer. New extensions should use it instead of reading config files directly or opening their own trace writer.

Run the checks with:

```powershell
npm run doctor
npm test
npm run check
```
