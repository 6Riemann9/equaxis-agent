# Agent Memory

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

基于“记忆宫殿”隐喻的多层 AI Agent 记忆系统 —— 短期记忆 + 长期记忆（向量存储）+ 知识图谱。

## 架构

```text
AgentMemory API
├── 短期记忆    →  会话历史、消息管理、上下文压缩
├── 长期记忆    →  ChromaDB 向量存储、语义搜索、Wing/Room 层级
├── 知识图谱    →  SQLite 三元组、时序有效性、置信度评分
└── Dream 机制  →  历史分析、候选事实提取、可选记忆更新、上下文压缩
```

核心模块：

- `memory/api/agent_api.py`：同步入口 `AgentMemory`
- `memory/api/async_agent_api.py`：异步入口 `AsyncAgentMemory`
- `memory/store/short_term.py`：JSONL 短期历史与 session 状态
- `memory/store/long_term.py`：ChromaDB 长期向量记忆
- `memory/store/knowledge_graph.py`：SQLite 知识图谱三元组
- `memory/stack/context_builder.py`：LLM messages 上下文构建
- `memory/dream/`：历史分析、事实提取与上下文压缩

## 快速开始

```bash
pip install -e .
```

```python
from pathlib import Path

from memory import AgentMemory

mem = AgentMemory(root_dir=Path("./my-agent-memory"))

# 记录对话
mem.on_user_message("session-1", "我叫 Kai，是个后端工程师")
mem.on_assistant_message("session-1", "你好 Kai！")

# 存储长期记忆
mem.remember(
    wing="my-project",
    room="tech-stack",
    content="Backend: FastAPI 0.115, Python 3.12",
)

# 语义搜索
result = mem.search(query="技术栈？", wing="my-project", limit=3)

# 知识图谱
mem.add_fact("Kai", "role", "backend-engineer")
mem.add_fact("Kai", "uses", "FastAPI")

# 构建 LLM 上下文
context = mem.build_context("session-1", "帮我查一下技术栈")

mem.close()
```

## 异步支持

`AsyncAgentMemory` 提供 async/await 友好的 API，适合接入异步应用。注意：当前实现是通过 `asyncio.to_thread()` 包装同步存储操作，并不是全链路原生 async I/O；高并发生产场景仍需要评估线程池、SQLite 与 ChromaDB 的实际表现。

```python
import asyncio

from memory import AsyncAgentMemory

async with AsyncAgentMemory(root_dir="./memory") as mem:
    results = await asyncio.gather(
        mem.search(query="FastAPI", wing="my-project"),
        mem.search(query="PostgreSQL", wing="my-project"),
    )
```

## 特性

- **三层记忆**：短期（会话上下文）+ 长期（ChromaDB 向量搜索）+ 知识图谱（SQLite 三元组）
- **记忆宫殿**：Wing → Room → Hall → Drawer 层级组织
- **稳定知识图谱 ID**：三元组使用 SHA-256 生成稳定持久化 ID，避免 Python `hash()` 跨进程不一致
- **时序知识图谱**：`valid_from` / `valid_to` 时间有效性、置信度评分
- **流式短期历史读取**：`read_unprocessed_history(..., limit=N)` 按行读取并可提前停止；无 limit 读取和 compact 仍可能扫描完整 JSONL
- **Dream 整合**：支持历史分析、候选事实提取与上下文压缩；配置 Phase2 工具后可进一步应用更新
- **同步 + 异步 API**：支持同步调用和 async/await facade
- **测试状态**：139 个测试通过，覆盖率 75%（命令：`python -m pytest tests/ --cov=memory --cov-report=term-missing`）

## 依赖

- Python ≥ 3.10
- ChromaDB ≥ 0.5.0
- tiktoken ≥ 0.7.0
- pydantic ≥ 2.0

## 测试

### 安装开发依赖

```bash
pip install -e ".[dev]"
```

如果 shell 中找不到 `pytest` 命令，可以使用更稳定的模块方式：

```bash
python -m pytest tests/ -v
```

### 全量回归

```bash
python -m pytest tests/ -q
```

当前验证结果：

```text
139 passed, 1 warning
```

### 覆盖率

```bash
python -m pytest tests/ --cov=memory --cov-report=term-missing
```

当前覆盖率：

```text
TOTAL 1601 statements, 406 missed, 75% coverage
```

### 重点模块测试

```bash
python -m pytest tests/test_knowledge_graph.py -v
python -m pytest tests/test_short_term.py -v
python -m pytest tests/test_long_term.py -v
python -m pytest tests/test_async_api.py -v
python -m pytest tests/test_integration.py -v
```

对应验证点：

- `test_knowledge_graph.py`：SQLite 三元组、时序查询、稳定 triple ID、重复事实去重
- `test_short_term.py`：JSONL 历史追加、cursor、流式读取、compact 行为
- `test_long_term.py`：ChromaDB drawer/closet、语义搜索、`close()` 幂等
- `test_async_api.py`：async facade、并发调用、异常传播、同步/异步行为一致性
- `test_integration.py`：`AgentMemory` 主流程集成验证

### 快速定位失败

```bash
python -m pytest tests/ -x
python -m pytest tests/test_knowledge_graph.py -x -v
```

## 已知边界

- `AsyncAgentMemory` 是基于 `asyncio.to_thread()` 的异步 facade，不是原生 async 存储层。
- `DreamPhase2` 当前主要解析动作并写入长期记忆；虽然存在 `ToolExecutor` 协议，但不承诺自动执行文件读写。
- `LongTermMemoryStore.close()` 是对 ChromaDB client 的 best-effort、幂等清理入口；底层资源释放能力取决于 ChromaDB。
- `LongTermConfig.embedding_model` 表示配置意图；当前 ChromaDB collection 仍主要依赖默认 embedding 行为。

## 许可证

MIT
