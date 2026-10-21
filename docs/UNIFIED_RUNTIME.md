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

## 分层设置（Layered Settings）

配置分三层合并，上层覆盖下层：

| 层 | 位置 | 作用域 |
|---|---|---|
| `default` | 代码内 `DEFAULT_EQUAXIS_CONFIG` | 兜底 |
| `bundled` | 包内 `.pi/equaxis.json` | 本安装（安装默认值，如 profile=full） |
| `global` | `~/.equaxis/config.json` | 所有项目 |
| `project` | `<工作区>/.pi/equaxis.json` | 当前项目 |

**项目根 vs 运行时根**：project root 是最近的 `.pi/equaxis.json` 携带者（配置与状态）；runtime root 携带 `.pi/extensions` + `scripts/`（仓库检出=自身，全局安装=包）。只有配置、没有运行时的 data-only 工作区（如家目录）会从包装载扩展与脚本——`src/runtime-root.mjs` 统一解析，doctor 以 `Project: <root> (data-only; runtime from package)` 明示。

`loadEquaxisConfigLayers(cwd)` 返回 `{defaults, global, project, effective}`；`scripts/config-edit.mjs` 提供 `view / set / unset`（写入前对**被编辑层单独校验**，非法值不落盘并回滚）。pi-web Harness 面板的 **Settings** tab 按分区展示（Agent/Governance/Memory/Skills/Subagents/Evaluation/Protocols/Runtime/Extensions/…），每个键显示当前生效值 + 来源徽标（default/global/project），可内联编辑（写入 project 层）或 Reset（回退下层默认）。Agent 分区只读展示 `.pi/settings.json`（provider/model 走 pi-web Models 面板管理）。

## pi-web 运行时产物优先级（source cache vs 根仓库）

`.pi/extensions/pi-web.ts` 的 `piWebLauncher()` 按以下顺序选择启动目标，**前者命中即短路**：

1. **开发者 override**（`PI_WEB_HOME` 环境变量 或 `~/.equaxis/config.json` 的 `piWeb.home`）——用于指向仓库外的开发副本；要求 `bin/pi-web.js` 和 `.next/BUILD_ID` 同时存在。
2. **仓库内 `pi-web/`**（源码编辑区）——源码在但从未构建（缺 `.next/BUILD_ID`）时**不会静默回退**，而是显式报错并给出修复命令：`cd pi-web && npm ci && npm run build`。
3. **`.pi/runtime/source-cache/agegr-pi-web/`**（运行时产物区，legacy）——上游 fork 的缓存构建产物。
4. **全局安装 / PATH 查找**（`pi-web`）。

要点：

- **"改了代码但没生效"** 的第一嫌疑是优先级：override / source-cache 里的旧产物盖过了你在 `pi-web/` 里的新代码。启动日志里的 `via: ...` 字段标明实际用的是哪一层。
- 修改 pi-web 源码后的标准顺序是 **build → restart → verify**：
  1. `cd pi-web && npm run build`（Next 生产构建；注意 Next SWC 排除规则不允许在 `node_modules` 路径下构建——全局安装内的 pi-web 不能原地 build，需 override 指向仓库副本）
  2. 重启 pi / 重新打开 pi-web 页面（扩展重启后才重新探测 launcher 目标）
  3. 验证：页面加载后检查 `/api/home` 200，且启动日志 `via:` 指向你刚构建的那一层。
- 生产安装不应携带 source-cache；仓库开发时优先方案 2（仓库内构建），方案 1 仅用于跨仓库开发副本。

## 已知启动告警与依赖公告（Known Warnings）

### `builtin:tool-search` 被替换告警（良性，无需处理）

启动时可能出现：

```
Warning: Extension package "builtin:tool-search": Extension .../tool-catalog.ts
registers tool `tool_search`, so built-in extension `tool-search` was not loaded.
```

**结论：这是预期行为，不是错误。**

- Pi 1.3.0 的可替换扩展机制（`omitReplacedExtensions`）检测到 equaxis 的
  `tool-catalog.ts` 注册了同名工具 `tool_search`，于是**主动跳过**内置
  `builtin:tool-search`，避免重复注册。equaxis 的版本是超集（合并 deferred MCP
  工具发现 + `setActiveTools` 激活语义），本就应当胜出。
- 告警无法从扩展侧消除：它只在“可替换的内置扩展被非 replaceable 扩展替换”时由
  Pi 输出，没有 per-run 开关。
- **消除告警的唯一方式**是在 settings 里禁用内置版（`"extensions": ["-builtin:tool-search"]`）。
  由于 Pi 没有 per-session settings，该设置会作用于**所有** Pi 会话，包括裸 `pi`
  ——裸 `pi` 将失去内置 `tool_search`（默认虽为 inactive，但用 `-t tool_search`
  或 `defaultTools` 显式启用时会不可用）。
- 因此 equaxis 默认**保留告警、保留内置版**：不为了消除一条纯信息提示而牺牲裸
  `pi` 的能力。若你只使用 `equaxis`，可自行按上式禁用内置版消除提示。

### vendored `effect` 依赖公告（GHSA-38f7-945m-qr2g / CVE-2026-32887）

- 公告范围：`effect < 3.20.0`（OSV：introduced `0` → fixed `3.20.0`）。根
  `package.json` 目前声明 `effect@^2.4.19`，因此**在受影响范围内**。
- 触发条件：Effect fiber 在**并发负载 + `@effect/rpc`** 下 `AsyncLocalStorage`
  上下文串扰（CVSS `AC:H`，需 RPC 服务端并发）。
- equaxis 现状：`effect` 仅被 `.pi/extensions/vendor/my-pi-setup` 下的 vendored
  扩展（`file-search`、`subagents`）使用，**不使用 `@effect/rpc`**，也不在并发 RPC
  服务端路径上，属于**低危、非可利用**。
- 处理决策：**接受并记录**，不强行升级。原因：vendored 树内部存在版本漂移
  （顶层 `effect@^2.4.19` + `@effect/platform@^0.48`，而 `file-search` 子包已声明
  `@effect/platform-node@^4.0.0-beta`，对应 effect 4.x）；把根 `effect` 升到 3.20+
  需要同步迁移 vendored 第三方代码（API 破坏性变更），风险高于收益。
  正确修法是**刷新 vendored my-pi-setup 上游副本来对齐 effect 4.x**，排在后续。

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
