# Memory System 改进总结

## 本轮优化结果 ✅

本轮目标是低风险优化 `agent-memory` 的稳定性、可测试性和可讲述性，同时整理具体测试方法与面试问答。

### 1. 知识图谱 triple ID 稳定化

- 修改文件：`memory/store/knowledge_graph.py`
- 测试文件：`tests/test_knowledge_graph.py`
- 改进点：
  - 将 `KnowledgeGraphStore._triple_id()` 从 Python 内置 `hash()` 改为 `hashlib.sha256()`。
  - 避免 Python hash randomization 导致相同三元组跨进程 ID 不一致。
  - 保持公共 API 不变。
- 新增/补强测试：
  - 相同输入生成相同 ID。
  - 跨 store 实例重复写入同一三元组仍能去重。
  - 不同三元组生成不同 ID。

### 2. 短期历史 JSONL 流式读取

- 修改文件：`memory/store/short_term.py`
- 测试文件：`tests/test_short_term.py`
- 改进点：
  - `read_unprocessed_history()` 不再使用 `read_text().splitlines()` 无条件全量读取。
  - 新增逐行读取 JSONL 的内部迭代逻辑。
  - `limit` 达到后提前停止收集结果。
  - 保持现有 JSONL 文件格式和 compact 行为兼容。
- 新增/补强测试：
  - 大量历史记录下按 cursor 返回未处理记录。
  - `limit` 正确限制返回数量。
  - `compact_history()` 保留最近记录且顺序正确。
  - 空历史文件 compact 不报错。

### 3. LongTermMemoryStore.close 幂等语义

- 修改文件：`memory/store/long_term.py`
- 测试文件：`tests/test_long_term.py`
- 改进点：
  - 为 `close()` 增加明确 docstring。
  - 定义为 best-effort、幂等的 ChromaDB client 清理入口。
  - 不承诺底层 ChromaDB 一定有显式资源释放能力。
- 新增/补强测试：
  - 多次调用 `close()` 不报错。
  - 正常写入/读取后调用 `close()` 不破坏生命周期。

### 4. AsyncAgentMemory 异步语义澄清

- 修改文件：`memory/api/async_agent_api.py`、`README.md`
- 测试文件：`tests/test_async_api.py`
- 改进点：
  - 明确 `AsyncAgentMemory` 是 async/await facade。
  - 底层通过 `asyncio.to_thread()` 包装同步 store，不是全链路原生 async I/O。
  - README 不再无上下文宣称固定异步性能提升。
- 新增/补强测试：
  - 重复 async `add_fact()` 使用稳定 triple ID 去重。
  - 底层线程包装操作中的异常能向 async 调用方传播。
  - docstring 明确提到 `asyncio.to_thread`。

### 5. README 测试说明和项目边界更新

- 修改文件：`README.md`
- 改进点：
  - 更新架构说明和关键模块索引。
  - 增加具体测试方法。
  - 统一测试数量和覆盖率口径。
  - 明确 async facade、DreamPhase2、ChromaDB close、embedding_model 等已知边界。

## 当前测试状态

执行命令：

```bash
python -m pytest tests/ -q
```

结果：

```text
139 passed, 1 warning in 40.06s
```

覆盖率命令：

```bash
python -m pytest tests/ --cov=memory --cov-report=term-missing
```

结果摘要：

```text
TOTAL 1601 statements, 406 missed, 75% coverage
139 passed, 1 warning
```

> 注意：当前环境中直接运行 `pytest` 命令不可用，但 `python -m pytest ...` 可正常执行。

## 具体测试方法

### 1. 安装开发依赖

```bash
pip install -e ".[dev]"
```

### 2. 全量测试

```bash
python -m pytest tests/ -q
```

用途：提交前回归验证全部模块。

### 3. 覆盖率测试

```bash
python -m pytest tests/ --cov=memory --cov-report=term-missing
```

用途：查看每个模块的覆盖率和未覆盖行。

### 4. 重点模块测试

```bash
python -m pytest tests/test_knowledge_graph.py -v
python -m pytest tests/test_short_term.py -v
python -m pytest tests/test_long_term.py -v
python -m pytest tests/test_async_api.py -v
python -m pytest tests/test_integration.py -v
```

对应验证点：

- `tests/test_knowledge_graph.py`
  - SQLite entities/triples 表行为
  - `valid_from` / `valid_to` 时序查询
  - relationship 查询
  - timeline/stats
  - SHA-256 稳定 triple ID
  - 重复事实去重

- `tests/test_short_term.py`
  - 初始化 history/cursor/dream_cursor 文件
  - 追加 JSONL 历史
  - cursor 自增
  - 未处理历史读取
  - recent history 和 char limit
  - dream cursor
  - compact history
  - 大历史流式读取行为

- `tests/test_long_term.py`
  - ChromaDB drawer 写入、读取、删除
  - wing/room 过滤搜索
  - closet 写入和搜索 boost
  - list_wings/list_rooms
  - `close()` 幂等生命周期

- `tests/test_async_api.py`
  - async context manager
  - async user/assistant message
  - async remember/search
  - async add_fact/query_entity
  - async build_context/status/recall
  - 并发 remember/search/fact 操作
  - 异常传播
  - async facade 文档说明

- `tests/test_integration.py`
  - `AgentMemory` 初始化
  - 对话记录
  - 上下文构建
  - 长期记忆 remember/search/recall
  - 知识图谱写入查询
  - status 输出

### 5. 快速定位失败

```bash
python -m pytest tests/ -x
python -m pytest tests/test_short_term.py -x -v
```

用途：遇到失败时停在第一个失败点，便于快速定位。

### 6. 如何测试大历史优化

推荐做法：

1. 在测试中构造大量 JSONL 历史记录。
2. 用 cursor 验证只返回未处理记录。
3. 用 `limit` 验证可以提前停止。
4. 验证 compact 后只保留最近 N 条且顺序不变。
5. 不建议在单元测试里写严格耗时断言，因为机器性能差异会导致测试脆弱。

## 面试可能问到的问题与回答要点

### 架构类

#### Q1：这个 memory 系统整体分为哪些层？

答：主要分为 API 层、存储层、上下文构建层、Dream 整合层和测试/配置层。

- API 层：`AgentMemory` 和 `AsyncAgentMemory`。
- 存储层：短期 JSONL、长期 ChromaDB、知识图谱 SQLite。
- 上下文构建层：`MemoryStack` 和 `ContextBuilder`。
- Dream 层：历史分析、候选事实提取、可选长期记忆更新、上下文压缩。
- 配置和测试层：`MemoryConfig`、`ConfigLoader`、pytest 测试套件。

#### Q2：为什么同时需要 short-term、long-term 和 knowledge graph？

答：三者解决的问题不同。

- Short-term memory 保存近期对话和 session 状态，适合上下文连续性。
- Long-term memory 用 ChromaDB 做语义检索，适合“意思相关但关键词不完全一致”的召回。
- Knowledge graph 保存结构化实体关系，适合查询“谁和谁有什么关系”“某事实在某时间是否有效”。

#### Q3：ContextBuilder 和 MemoryStack 分别负责什么？

答：

- `MemoryStack` 负责按层组织记忆，例如身份信息、essential story、指定 wing/room 召回、topic 搜索结果。
- `ContextBuilder` 负责把这些层和当前 session messages 拼装成 LLM 可使用的 messages。

#### Q4：Dream 机制解决什么问题？

答：Dream 机制是离线/后台整理记忆的流程，用来从历史对话中提取候选事实、候选技能和可删除信息，并支持上下文压缩。配置 Phase2 工具执行器后，才会进一步应用文件或长期记忆更新。它解决的是长期运行后上下文膨胀、记忆重复、事实沉淀的问题。

### 存储设计类

#### Q5：为什么 short-term 使用 JSONL？

答：JSONL 简单、可追加、易调试，适合本地 agent 历史记录。每行一条记录，出问题也容易人工排查。缺点是大文件扫描成本会上升，所以本轮把读取改成逐行流式处理，降低无条件全量读取的压力。

#### Q6：为什么 long-term 使用 ChromaDB？

答：长期记忆需要语义相似度搜索，ChromaDB 提供本地持久化向量存储和 query API，适合根据自然语言查询召回相关记忆。

#### Q7：为什么 knowledge graph 使用 SQLite？

答：SQLite 部署简单、零服务依赖、支持事务和索引，足够支撑本地实体和三元组关系存储。相比引入图数据库，SQLite 更轻量，适合当前项目规模。

#### Q8：为什么 Python `hash()` 不适合做持久化 ID？

答：Python 默认启用 hash randomization，同一个字符串在不同进程中可能得到不同 hash 值。持久化 ID 必须跨进程稳定，所以应使用 SHA-256 这类稳定哈希。

### 异步与并发类

#### Q9：AsyncAgentMemory 是真正原生 async 吗？

答：不是。它是 async/await facade，底层用 `asyncio.to_thread()` 包装同步 store 操作。优点是容易接入异步应用，并可进行基础并发调用；缺点是底层 I/O 仍由线程执行，不等于全链路非阻塞。

#### Q10：`asyncio.to_thread()` 的优缺点是什么？

答：

- 优点：改造成本低，可以避免阻塞 event loop，复用现有同步实现。
- 缺点：线程池仍有容量限制，无法从根本上改变 SQLite/ChromaDB 的并发特性；CPU 密集任务也不一定能明显受益。

#### Q11：SQLite 和 ChromaDB 并发使用要注意什么？

答：SQLite 读多写少场景很好，但写并发有限；ChromaDB client 的线程安全和资源释放需要遵循其底层实现。Async facade 只能改善调用方式，不能自动消除存储层瓶颈。

### 测试类

#### Q12：如何测试这个 memory 系统？

答：按层测试。

- Store 层：分别测试 short-term、long-term、knowledge graph。
- API 层：测试 `AgentMemory`、`AsyncAgentMemory` 的公共行为。
- Context 层：测试 messages 构建顺序和内容。
- Dream 层：测试阶段流程、解析逻辑、压缩逻辑。
- Integration：测试初始化、写入、搜索、查询、status 的主链路。

#### Q13：本轮优化如何验证不破坏行为？

答：先补回归测试，再改实现，然后运行重点测试和全量测试。

重点命令：

```bash
python -m pytest tests/test_knowledge_graph.py tests/test_short_term.py tests/test_long_term.py tests/test_async_api.py -q
python -m pytest tests/ -q
python -m pytest tests/ --cov=memory --cov-report=term-missing
```

#### Q14：如何测试大历史读取优化？

答：构造较多 JSONL 记录，验证 cursor、limit、compact 后内容和顺序。避免写“必须小于多少毫秒”的断言，因为这类测试受机器性能影响，容易变成 flaky test。

### 质量与演进类

#### Q15：当前最大技术债是什么？

答：主要有：

- Dream 相关模块覆盖率较低。
- `AsyncAgentMemory` 是线程包装，不是原生 async。
- `DreamPhase2` 的 `ToolExecutor` 协议和实际文件执行能力还没有完全贯通。
- `embedding_model` 配置意图尚未完整接入 Chroma embedding function。
- ContextBuilder 把动态历史放入 system prompt，后续可能影响 prompt cache 命中率。

#### Q16：为什么本轮不做 CLI？

答：CLI 是独立产品面，需要命令设计、参数校验、错误处理、端到端测试和文档。当前迭代目标是低风险优化已有核心能力，所以先不扩大范围。

#### Q17：为什么本轮不做 KG 高级查询和向量缓存？

答：KG 高级查询涉及路径查找、子图提取、关系推理和结果排序；向量缓存涉及一致性、失效策略和 benchmark。它们都有价值，但适合单独专项设计。

#### Q18：如果继续优化，下一步会做什么？

答：建议优先级如下：

1. 补 Dream 模块测试，提高 phase1/phase2/consolidator 覆盖率。
2. 明确 `embedding_model` 与 Chroma embedding function 的关系。
3. 设计 CLI：`init`、`remember`、`search`、`status`、`run-dream`。
4. 增强 KG 查询能力：路径查询、子图导出、关系推理。
5. 优化 ContextBuilder，使稳定 system prompt 和动态检索上下文分离，提高缓存友好性。

## 已知边界

- `AsyncAgentMemory` 是 async facade，不是原生 async 存储层。
- `DreamPhase2` 当前主要解析 action 并写入长期记忆，不承诺自动执行文件写入。
- `LongTermMemoryStore.close()` 是 best-effort 幂等清理入口。
- 当前测试覆盖率为 75%，Dream 和 Git 工具相关模块仍是主要覆盖率提升空间。

## 后续待办 📋

### 高优先级

- [ ] 补充 Dream 模块测试。
- [ ] 明确或实现 `embedding_model` 配置到 ChromaDB embedding function 的映射。
- [ ] 为 `DreamPhase2` 的 ToolExecutor 能力设计安全边界和测试策略。

### 中优先级

- [ ] 增加 CLI：`init`、`remember`、`search`、`status`、`run-dream`。
- [ ] 优化 ContextBuilder 的 prompt cache 友好性。
- [ ] 增加向量存储批量写入和 benchmark。

### 低优先级

- [ ] 增强知识图谱高级查询：路径查找、子图提取、关系推理。
- [ ] 导出 GraphML / DOT 便于可视化。
- [ ] 查询缓存与失效策略。

## 总结

本轮改进让系统在三个方面更可靠：

- 稳定性：知识图谱 ID 改为稳定 SHA-256，避免跨进程不一致。
- 性能与可扩展性：`read_unprocessed_history(..., limit=N)` 支持逐行处理和提前停止；无 limit 读取与 compact 仍可能扫描完整 JSONL。
- 可维护性：补强测试、明确 async/close/DreamPhase2 边界，并整理了可直接用于项目讲解和面试准备的问题清单。
