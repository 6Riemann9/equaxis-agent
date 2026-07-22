# Equaxis 架构设计

## 设计目标

这个项目解决的不是“如何再写一个聊天机器人”，而是“如何把一个能力完整、行为带概率性的 Coding Agent，变成可以约束、审计和评测的执行系统”。

Pi 负责通用智能与交互体验，Equaxis Harness 负责确定性控制。二者边界清晰，Pi 升级模型或增加工具时，不需要重写 Agent 主循环。

## 运行链路

```text
用户输入
   │
   ▼
Pi TUI / JSON / RPC
   │ before_agent_start：注入可靠性原则
   ▼
Pi Agent Loop（LLM 规划）
   │ tool_call：执行前拦截
   ▼
Harness Policy ── blocked ──► 向 Pi 返回 block + reason
   │ allowed / HITL approved
   ▼
Pi 原生工具 read / bash / edit / write / grep / find / ls
   │ tool_result
   ▼
Harness Trace + Metrics + Branch-safe State
   │
   ▼
Pi 继续推理或完成回答
```

Memory Extension 与 Harness 并列挂载在 Pi Extension Runtime 上。Memory 注册的持久化工具同样会经过 Harness 的 `tool_call`，因此 Agent 不存在绕过治理层直接写长期记忆的通道。

核心原则是把概率性决策和确定性控制分开：LLM 可以提出动作，但是否允许执行由代码策略和人工审批决定。

## 为什么使用 Pi Extension

直接 fork 或改写 Pi 源码会产生长期维护成本，也很难证明原始能力没有被破坏。Extension API 提供了所需的稳定切面：

- `before_agent_start`：只追加约束，不替换 Pi 原始系统能力。
- `tool_call`：真实工具执行前的最后一道确定性门禁。
- `tool_result`：收集成功、失败和延迟。
- `turn_start/turn_end`：定义单轮预算与 Eval 边界。
- `session_start/session_tree`：按当前会话分支恢复状态。
- `session_before_fork`：在需要时治理分支操作。
- `registerCommand`：把运维入口放进 Pi 原生 TUI。

## 状态与 Trace

Harness 有两种数据：

1. 分支状态：通过 `pi.appendEntry("equaxis-reliability-state", data)` 写入 Pi 会话树。切换分支时只扫描当前 branch，避免把另一条分支的审批/计数带过来。
2. 审计 Trace：追加写入 `.pi/runtime/traces.jsonl`，用于跨会话统计和离线分析。

Trace 不保存 write/edit 的正文，只保存路径和参数键；bash 命令最多保存 800 字符。密钥检测发生在记录之前，避免“为了审计而泄密”。

## 故障语义

- 策略引擎对 bash/write/edit 分类异常时，`enforce` 模式 fail closed。
- 高风险调用没有交互审批能力时拒绝执行。
- 用户拒绝只影响当前单次工具调用，不会被模型自动视为长期授权。
- 普通读取和低风险 shell 命令不弹窗，避免安全机制导致 Agent 无法正常工作。
- Trace 写入失败不会篡改 Pi 的工具结果，但会在可用 UI 中通知用户。

## 保留的 Pi 能力

Harness 没有替换 Pi 的模型注册、认证、上下文构建、TUI、会话文件、分支、压缩或工具实现。因此用户仍可使用 Pi 自带能力，并可通过 `npm run pi:raw` 完全关闭项目扩展。

## Node 与 Python 的边界

Pi 和 Extension 运行在 Node.js；用户的 Agent Memory Core 保持 Python 实现。`src/memory-bridge.mjs` 启动一个常驻 Python 子进程，通过带请求 ID 的 JSONL 协议并发匹配响应。协议层只传递 JSON 数据，不让 Python 接管 Pi Agent loop。

Bridge 失败时 Memory 降级为 unavailable，但 Pi 和 Reliability Harness 仍可继续工作。这样向量数据库或 Python 环境故障不会让整个 Agent CLI 无法启动。
