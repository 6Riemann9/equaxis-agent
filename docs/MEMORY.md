# Equaxis Memory 集成

## 组成

```text
Pi Agent Loop
   │ before_agent_start / agent_end / custom tools
   ▼
.pi/extensions/memory.ts
   │  request(action, payload)
   ├─ native（默认）→ src/memory-core.mjs（进程内，纯 Node）
   │      ├── history/  JSONL 短期历史 + cursor
   │      ├── long_term/drawers.json（384-d 向量抽屉）
   │      ├── knowledge_graph.sqlite3（node:sqlite）
   │      └── @huggingface/transformers 语义 embedding（all-MiniLM-L6-v2）
   └─ python（可选）→ src/memory-bridge.mjs ── Python 进程
                          ▼
                      bridge/memory_bridge.py → vendor/agent-memory（ChromaDB）
```

**默认后端是 native**（`memory.backend: "native"`）：纯 Node 实现，无 Python/chromadb 依赖，Linux/Arch 开箱即用；历史与知识图谱数据布局与 Python 版一致（`history.jsonl`、cursor 文件、`knowledge_graph.sqlite3` schema 相同，可直接打开既有数据）。`memory.backend: "python"` 切回旧桥。`scripts/memory-json.mjs` 提供协议兼容的 JSONL 桥（pi-web 与 snapshot 探测按 backend 自动选择进程）。

**迁移**：已有 Python 数据（`.equaxis/memory/long_term/palace/`）用 `/memory-migrate` 迁移（Python 导出 → 原生导入，历史与图谱原地复用、去重幂等）。

## 生命周期

1. `session_start` 启动常驻 Python Bridge，并初始化 `.equaxis/memory/`。
2. `before_agent_start` 先召回相关上下文，再记录用户输入。
3. Memory Context 作为不可信历史数据追加到 Pi system prompt，明确禁止把其中的命令当成指令执行。
4. `agent_end` 提取最后一条助手文本并写入短期历史。
5. `session_shutdown` 关闭 ChromaDB，并等待 Python 进程退出，避免 Windows 文件锁残留。

## Dream 整合（短期 → 长期自动晋升）

会话结束时（`session_shutdown`）自动运行：把 dream cursor 之后未处理的短期历史交给当前模型总结，提取持久记忆（写入 drawers）和实体关系（写入知识图谱），成功后推进 cursor。**至少一次语义**：只有全部写入成功才推进 cursor，中断的 run 下次会重跑。

- 配置：`.pi/equaxis.json` → `memory.dream`：
  - `enabled`：总开关（默认 true）
  - `onShutdown`：会话结束自动触发（默认 true）
  - `maxEntries`：单次处理的历史条数上限（默认 200）
  - `provider` / `model`：提取用模型；不填则用当前会话模型（无厂商默认）
- 手动触发：`/memory-dream` 命令。
- 提取提示词与解析：`src/memory-consolidate.mjs`（严格 JSON：`{memories, facts}`，容忍 markdown fence）。
- 相关事件（trace）：`memory_dream_consolidated` / `memory_dream_failed`。

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
| `/memory-export [path]` | 导出全部记忆（drawers/facts/history/status）为 JSON，默认写到 `.equaxis/memory/backups/` |
| `/memory-repair` | 修复 cursor（损坏时从历史重建）并报告完整性：历史行损坏/不可解析数、drawers 数、embedding 就绪探测 |

`npm run setup` 也会做记忆核心安装与 doctor 检查（含 "Memory store" 完整性检查项）。

## Embedding

Chroma 集合在**新建时**显式使用 `long_term.embedding_model`（默认 `all-MiniLM-L6-v2`，ONNX）；已存在的集合沿用存储时的 embedding 配置（Chroma 会拒绝不一致的函数）。不支持的模型名在初始化时直接报错（fail-fast）。首次写入/查询会下载 ONNX 模型——离线环境用 `/memory-repair` 的 embedding 探测即可预检。

## Pi Web 记忆图集（可视化与编辑）

在 Pi 中运行 `/pi-web` 会启动仓库内 vendored 的 pi-web fork（`pi-web/`，随仓库版本控制），顶栏的 **Equaxis Memory** 按钮打开记忆图集：

- **概览指标**：Drawers / Wings / Facts / History 数量。
- **浏览**：按 wing 过滤，抽屉按 wing/room 分组展示，内容、来源、记录时间、hall 徽标。
- **语义搜索**：调用 Bridge 的 `search`，显示相关度分数（%）。
- **编辑**：每条记忆可内联修改 content / wing / room / hall / source_file，通过 Bridge `update_memory` 以原 drawer id 落盘（Chroma upsert，id 不变）。
- **删除**：两步确认，调用 `delete_memory`。
- **新增**：表单填写 wing / room / hall / content，调用 `remember`。
- **知识图谱**：Obsidian 风格力导向图（d3-force）。节点按连接数缩放，悬停高亮相连节点/边并显示 predicate 标签，可拖拽节点（释放后固定）、滚轮缩放、拖动背景平移；点击节点弹出该实体的全部事实详情；`↻ Relayout` 重新布局。

实现：fork 新增 `app/api/memory/route.ts`（GET 快照/搜索，POST update/delete/remember，按请求 spawn `python bridge/memory_bridge.py`，受 pi-web 的 request-security 与 allowed-roots 保护）和 `components/MemoryDashboard.tsx`。Bridge 新增 `update_memory` action（`LongTermMemoryStore.update_drawer`，同 id upsert）。

重新构建 fork（Windows 下 next build 的 nft 家目录扫描已由 `scripts/nft-readdir-shim.cjs` + next.config.ts 修复）：

```powershell
cd pi-web
npm install
npm run build
```

`npm run setup` 会自动完成安装与构建。

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

- Dream 整合由扩展侧驱动（`completeSimple` + 会话模型），不经过 Python 的 Dream Core；只做"提取 → 写入 drawers/facts"，不做 phase2 的记忆宫殿文件自治编辑。
- ChromaDB 首次实际写入/查询可能需要准备默认 embedding 模型。
- Memory 数据是跨 Pi 会话的；Pi fork 的 Harness 状态是 branch-safe，但外部长期记忆不会随 Pi fork 自动回滚。
- Bridge 当前按请求顺序执行 Python 操作；适合单用户 CLI，不是多租户高并发服务。
