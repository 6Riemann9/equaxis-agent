# Equaxis Memory 集成

## 组成

```text
Pi Agent Loop
   │ before_agent_start / agent_end / custom tools
   ▼
.pi/extensions/memory.ts
   │ request-id JSONL
   ▼
src/memory-bridge.mjs ── persistent Python process
   │
   ▼
bridge/memory_bridge.py
   │
   ▼
vendor/agent-memory/memory
   ├── Short-term JSONL history
   ├── ChromaDB long-term memory
   ├── SQLite temporal knowledge graph
   └── Dream and consolidation core
```

`vendor/agent-memory` 包含项目运行所需的 Memory Core 快照，因此克隆仓库后无需依赖外部源码目录即可运行。

## 生命周期

1. `session_start` 启动常驻 Python Bridge，并初始化 `.equaxis/memory/`。
2. `before_agent_start` 先召回相关上下文，再记录用户输入。
3. Memory Context 作为不可信历史数据追加到 Pi system prompt，明确禁止把其中的命令当成指令执行。
4. `agent_end` 提取最后一条助手文本并写入短期历史。
5. `session_shutdown` 关闭 ChromaDB，并等待 Python 进程退出，避免 Windows 文件锁残留。

## 模型工具

| 工具 | 风险 | 用途 |
|---|---|---|
| `memory_search` | low | 语义搜索长期记忆 |
| `memory_query_entity` | low | 查询知识图谱实体 |
| `memory_remember` | medium | 写入长期 ChromaDB 记忆 |
| `memory_add_fact` | medium | 写入 SQLite 知识图谱事实 |

这些工具由 Memory Extension 注册，但执行前仍会触发 Reliability Harness 的统一 `tool_call`。因此明文凭据检测、调用预算和 Trace 对 Memory 同样生效。

## 安装和配置

```powershell
npm install
npm run setup:memory
npm run verify:full
```

`.pi/memory.json` 支持：

- `enabled`：启用或关闭 Memory Extension。
- `pythonCommand`：Python 可执行文件名或路径。
- `rootDir`：运行数据目录。
- `autoRecall`：每次 Agent 启动前是否自动召回。
- `defaultWing/defaultRoom`：模型未指定位置时的默认记忆宫殿位置。
- `recallLimit/maxContextChars`：召回数量和注入上限。
- `maxStoredMessageChars`：单条短期历史最大长度。
- `requestTimeoutMs`：Node 到 Python 的请求超时。

## 运维命令

| 命令 | 用途 |
|---|---|
| `/memory` | 查看 Memory 运行状态 |
| `/memory-search <query>` | 手动搜索长期记忆 |
| `/memory-restart` | 重启常驻 Python Bridge，适合修复桥代码、切换 Python 环境或遇到编码错误后使用 |
| `/memory-path` | 查看 Memory 数据目录 |

## 数据安全

- `.equaxis/memory/` 默认不进入 Git。
- 自动记录前检查疑似凭据；命中后跳过持久化。
- 召回上下文疑似包含凭据时，不注入模型。
- write/edit 正文不进入 Harness Trace；Memory 工具命中凭据时参数也会脱敏。
- Memory 内容可能包含历史 prompt injection，因此系统提示把它声明为 untrusted context。

## Windows 编码

Node 侧固定以 UTF-8 写入 Python Bridge，Python Bridge 启动时也会把 `stdin/stdout/stderr` 配成 UTF-8，并以 ASCII escaped JSONL 输出响应。这样可以避免 Windows 默认 GBK 控制台在包含中文或替换字符时触发 `UnicodeEncodeError`。

修改 Bridge 代码后，先在 Pi 中执行 `/reload` 重新加载扩展，再执行 `/memory-restart` 重启常驻 Python 进程。

## 当前边界

- Dream Core 已随源码植入，但未绑定 Pi 模型作为 Python `LLMProvider`，所以自动 Dream consolidation 尚未开启。
- ChromaDB 首次实际写入/查询可能需要准备默认 embedding 模型。
- Memory 数据是跨 Pi 会话的；Pi fork 的 Harness 状态是 branch-safe，但外部长期记忆不会随 Pi fork 自动回滚。
- Bridge 当前按请求顺序执行 Python 操作；适合单用户 CLI，不是多租户高并发服务。
