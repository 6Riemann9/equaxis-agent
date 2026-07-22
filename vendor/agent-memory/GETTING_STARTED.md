# Agent Memory 系统 - 新手完全指南

## 📖 目录

1. [什么是 Agent Memory？](#什么是-agent-memory)
2. [为什么需要它？](#为什么需要它)
3. [快速开始](#快速开始)
4. [实战演示](#实战演示)
5. [性能数据](#性能数据)
6. [常见问题](#常见问题)

---

## 什么是 Agent Memory？

Agent Memory 是一个**智能记忆系统**，让AI助手能够：
- 📝 **记住对话历史** - 不会忘记你说过的话
- 🧠 **存储长期知识** - 记住项目信息、技术栈、偏好
- 🔍 **智能搜索** - 快速找到相关记忆
- 🕸️ **构建知识图谱** - 理解实体之间的关系

### 简单类比

想象你有一个超级助手：
- **短期记忆** = 便签纸（记录当前对话）
- **长期记忆** = 笔记本（存储重要信息）
- **知识图谱** = 思维导图（理解关系网络）

---

## 为什么需要它？

### 问题场景

**没有记忆系统时：**
```
你: 我叫张三，在做一个电商项目，用的是Python + FastAPI
AI: 好的，我知道了

[第二天]
你: 我的项目用的什么技术栈？
AI: 抱歉，我不记得了，请再告诉我一次
```

**有记忆系统后：**
```
你: 我叫张三，在做一个电商项目，用的是Python + FastAPI
AI: 好的，已记录！✓

[第二天]
你: 我的项目用的什么技术栈？
AI: 你的电商项目使用 Python + FastAPI
    [从记忆中检索到：tech-stack/backend]
```

---

## 快速开始

### 1. 安装

```bash
# 进入 vendored Memory Core 目录
cd vendor/agent-memory

# 安装依赖（如果还没安装）
pip install -e .
```

### 2. 第一个程序（5分钟）

创建文件 `my_first_memory.py`：

```python
from memory import AgentMemory
from pathlib import Path

# 1. 初始化记忆系统
mem = AgentMemory(root_dir=Path("./my-memory"))

# 2. 记录对话
mem.on_user_message("session-1", "我叫张三，是个Python开发者")
mem.on_assistant_message("session-1", "你好张三！")

# 3. 存储长期记忆
mem.remember(
    wing="my-project",      # 项目名
    room="tech-stack",      # 分类
    content="后端: Python 3.12 + FastAPI 0.115"
)

# 4. 搜索记忆
result = mem.search(query="我用的什么技术？", wing="my-project")
print(f"找到 {len(result.matches)} 条相关记忆：")
for match in result.matches:
    print(f"  - {match.content}")

# 5. 构建知识图谱
mem.add_fact("张三", "职业", "Python开发者")
mem.add_fact("张三", "使用", "FastAPI")

# 6. 查询关系
facts = mem.query_entity("张三")
print(f"\n关于张三的知识：")
for fact in facts:
    print(f"  {fact['subject']} --{fact['predicate']}--> {fact['object']}")

# 7. 关闭
mem.close()
```

运行：
```bash
python my_first_memory.py
```

**输出：**
```
找到 1 条相关记忆：
  - 后端: Python 3.12 + FastAPI 0.115

关于张三的知识：
  张三 --职业--> python开发者
  张三 --使用--> fastapi
```

---

## 实战演示

### 场景：管理一个真实项目

让我们用真实数据演示系统的能力。

#### 步骤1：记录项目信息

```python
from memory import AgentMemory
from pathlib import Path

mem = AgentMemory(root_dir=Path("./project-memory"))

# 记录技术栈
mem.remember(
    wing="ecommerce-project",
    room="backend",
    content="Python 3.12, FastAPI 0.115, PostgreSQL 16, Redis 7"
)

mem.remember(
    wing="ecommerce-project",
    room="frontend",
    content="React 18, TypeScript 5, Tailwind CSS 3"
)

mem.remember(
    wing="ecommerce-project",
    room="deployment",
    content="Docker Compose, AWS ECS, GitHub Actions CI/CD"
)

# 记录团队成员
mem.add_fact("张三", "角色", "后端负责人")
mem.add_fact("李四", "角色", "前端负责人")
mem.add_fact("王五", "角色", "DevOps工程师")

# 记录技术决策
mem.remember(
    wing="ecommerce-project",
    room="decisions",
    content="选择PostgreSQL而非MySQL，因为需要JSON字段和全文搜索"
)

print("✓ 项目信息已记录")
```

#### 步骤2：智能搜索

```python
# 搜索1：技术栈相关
result = mem.search(
    query="我们用的什么数据库？",
    wing="ecommerce-project",
    limit=3
)

print("\n=== 搜索：数据库 ===")
for i, match in enumerate(result.matches, 1):
    print(f"{i}. [{match.metadata['room']}] {match.content}")
    print(f"   相关度: {match.score:.3f}")

# 搜索2：部署相关
result = mem.search(
    query="如何部署项目？",
    wing="ecommerce-project",
    limit=3
)

print("\n=== 搜索：部署 ===")
for i, match in enumerate(result.matches, 1):
    print(f"{i}. [{match.metadata['room']}] {match.content}")
    print(f"   相关度: {match.score:.3f}")
```

**输出：**
```
=== 搜索：数据库 ===
1. [backend] Python 3.12, FastAPI 0.115, PostgreSQL 16, Redis 7
   相关度: 0.856
2. [decisions] 选择PostgreSQL而非MySQL，因为需要JSON字段和全文搜索
   相关度: 1.124

=== 搜索：部署 ===
1. [deployment] Docker Compose, AWS ECS, GitHub Actions CI/CD
   相关度: 0.723
```

#### 步骤3：知识图谱查询

```python
# 查询团队成员
print("\n=== 团队成员 ===")
for name in ["张三", "李四", "王五"]:
    facts = mem.query_entity(name)
    for fact in facts:
        print(f"{fact['subject']} 是 {fact['object']}")
```

**输出：**
```
=== 团队成员 ===
张三 是 后端负责人
李四 是 前端负责人
王五 是 DevOps工程师
```

#### 步骤4：构建LLM上下文

```python
# 模拟用户提问
context = mem.build_context(
    session_id="session-1",
    user_message="帮我回顾一下项目的技术栈",
    wing="ecommerce-project"
)

print("\n=== 生成的LLM上下文 ===")
print(f"消息数量: {len(context)}")
print(f"系统提示词长度: {len(context[0]['content'])} 字符")
print("\n系统提示词预览:")
print(context[0]['content'][:300] + "...")
```

**输出：**
```
=== 生成的LLM上下文 ===
消息数量: 2
系统提示词长度: 456 字符

系统提示词预览:
# Identity

[ecommerce-project/backend] Python 3.12, FastAPI 0.115, PostgreSQL 16, Redis 7
[ecommerce-project/frontend] React 18, TypeScript 5, Tailwind CSS 3
[ecommerce-project/deployment] Docker Compose, AWS ECS, GitHub Actions CI/CD
...
```

---

## 性能数据

### 当前验证数据

#### 1. 测试状态

```bash
python -m pytest tests/ -q
python -m pytest tests/ --cov=memory --cov-report=term-missing
```

当前结果：

```text
139 passed, 1 warning
TOTAL 1601 statements, 406 missed, 75% coverage
```

#### 2. 重点能力验证

| 能力 | 测试文件 | 验证重点 |
|------|----------|----------|
| 短期记忆 | `tests/test_short_term.py` | JSONL 追加、cursor、recent history、流式读取、compact |
| 长期记忆 | `tests/test_long_term.py` | ChromaDB drawer/closet、语义搜索、close 幂等 |
| 知识图谱 | `tests/test_knowledge_graph.py` | SQLite 三元组、时序查询、稳定 SHA-256 triple ID |
| 异步 API | `tests/test_async_api.py` | async facade、并发调用、异常传播 |
| 集成流程 | `tests/test_integration.py` | AgentMemory 主流程 |

#### 3. 异步 API 说明

`AsyncAgentMemory` 支持 async/await 和 `asyncio.gather()` 风格调用，但当前底层通过 `asyncio.to_thread()` 包装同步存储操作，不是全链路原生 async I/O。生产高并发场景需要结合线程池、SQLite 和 ChromaDB 的实际表现做压测。

#### 4. 手动性能评估建议

如果要评估性能，建议单独写 benchmark，并记录：

- 数据量：例如 100 / 1000 / 10000 条记忆。
- 查询次数和 query 类型。
- ChromaDB 本地目录是否复用。
- Python 版本、机器配置、磁盘类型。
- 同步调用与 async facade 调用的并发数。

不要把未复现的固定性能数字写成通用承诺。

---

## 真实使用案例

### 案例1：代码助手

**场景：** 帮助开发者记住项目的代码规范和架构决策

```python
# 记录代码规范
mem.remember(
    wing="my-app",
    room="coding-standards",
    content="使用 TypeScript strict 模式，所有函数必须有类型注解"
)

mem.remember(
    wing="my-app",
    room="architecture",
    content="采用分层架构：Controller -> Service -> Repository"
)

# 开发者提问
result = mem.search(query="我们的代码规范是什么？", wing="my-app")
# 立即找到相关规范
```

**效果：**
- ✅ 新成员快速了解项目规范
- ✅ 减少重复询问
- ✅ 保持代码一致性

### 案例2：客服机器人

**场景：** 记住用户偏好和历史问题

```python
# 记录用户信息
mem.add_fact("用户123", "偏好语言", "中文")
mem.add_fact("用户123", "会员等级", "VIP")
mem.add_fact("用户123", "上次购买", "2024-01-15")

# 记录常见问题
mem.remember(
    wing="customer-service",
    room="faq",
    content="退货政策：7天无理由退货，需保持商品完好"
)

# 用户提问时自动检索相关信息
result = mem.search(query="如何退货？", wing="customer-service")
```

**效果：**
- ✅ 个性化服务
- ✅ 快速响应常见问题
- ✅ 减少人工客服压力

### 案例3：学习助手

**场景：** 记录学习进度和知识点

```python
# 记录学习内容
mem.remember(
    wing="python-learning",
    room="basics",
    content="已学习：变量、数据类型、控制流、函数"
)

mem.add_fact("Python", "特点", "动态类型")
mem.add_fact("Python", "特点", "面向对象")
mem.add_fact("Python", "用途", "Web开发")
mem.add_fact("Python", "用途", "数据分析")

# 查询学习进度
facts = mem.query_entity("Python")
# 获取完整的知识图谱
```

**效果：**
- ✅ 追踪学习进度
- ✅ 构建知识体系
- ✅ 个性化学习路径

---

## 对比：有无记忆系统的差异

### 场景：多轮对话

**无记忆系统：**
```
第1轮:
用户: 我在做一个电商项目
AI: 好的

第2轮:
用户: 我的项目用什么数据库好？
AI: 你的项目是什么类型的？（忘记了）

第3轮:
用户: 电商项目啊！（重复说明）
AI: 哦对，建议用MySQL或PostgreSQL
```

**有记忆系统：**
```
第1轮:
用户: 我在做一个电商项目
AI: 好的，已记录 ✓

第2轮:
用户: 我的项目用什么数据库好？
AI: 对于你的电商项目，建议用PostgreSQL
    [从记忆检索：项目类型=电商]

第3轮:
用户: 为什么选PostgreSQL？
AI: PostgreSQL适合电商项目因为：
    1. 支持JSON字段（商品属性灵活）
    2. 全文搜索（商品搜索）
    3. 事务支持强（订单处理）
    [结合记忆和知识库]
```

**可能收益：**

- 减少重复说明
- 帮助对话更快聚焦上下文
- 实际效果取决于记忆质量、检索配置和使用场景

---

## 常见问题

### Q1: 记忆会占用很多空间吗？

**A:** 实际空间占用取决于内容长度、metadata、ChromaDB 版本和 embedding 配置。建议使用你的真实数据运行 benchmark 后再评估磁盘和内存需求。

### Q2: 搜索速度快吗？

**A:** 长期记忆使用 ChromaDB 向量检索，适合本地语义搜索。实际速度取决于数据量、机器配置、磁盘和 embedding 设置；建议用你的真实数据跑 benchmark。

### Q3: 会不会搜索不准确？

**A:** 搜索效果取决于 embedding 模型、数据质量、查询方式和 wing/room 过滤条件。它支持向量相似度搜索，通常比纯关键词匹配更适合语义召回；正式使用前建议用业务数据构建评测集验证召回质量。

### Q4: 数据安全吗？

**A:** 默认数据存储在本地目录中。是否涉及外部服务取决于 embedding 配置和运行环境；生产使用前请确认依赖配置、文件权限、备份策略和日志策略。

### Q5: 需要很强的编程基础吗？

**A:** 不需要！
- 只需要会Python基础
- API设计简单直观
- 有完整的示例代码

### Q6: 可以用在生产环境吗？

**A:** 可以作为本地 agent memory 组件继续集成验证：

- 已有基础测试覆盖核心流程
- 已对部分边界行为补充测试
- 当前验证为 139 个测试通过、75% 代码覆盖率
- 生产前建议补充输入校验审查、安全评审、真实数据 benchmark 和并发压测

---

## 下一步

### 1. 运行官方示例

```bash
# 同步API示例
python demo.py

# 异步API示例
python demo_async.py
```

### 2. 查看完整文档

- [README.md](README.md) - 完整API文档
- [IMPROVEMENTS.md](IMPROVEMENTS.md) - 技术细节

### 3. 运行测试

```bash
# 运行所有测试
python -m pytest tests/ -v

# 查看覆盖率
python -m pytest tests/ --cov=memory --cov-report=html
```

### 4. 开始你的项目

复制 `my_first_memory.py` 并根据你的需求修改！

---

## 总结

### 为什么选择 Agent Memory？

✅ **简单易用** - 5分钟上手，API直观  
✅ **结构清晰** - 短期记忆、长期记忆、知识图谱分层设计  
✅ **测试充分** - 139 个测试通过，75% 测试覆盖  
✅ **异步友好** - 提供 async/await facade，便于接入异步应用  
✅ **持续演进** - 已明确 Dream、embedding、CLI、KG 查询等后续优化方向  

### 数据说话

| 指标 | 数值 | 说明 |
|------|------|------|
| 测试通过率 | **100%** | 139/139 个测试 |
| 代码覆盖率 | **75%** | 当前 coverage 结果 |
| 存储层 | **3 类** | JSONL / ChromaDB / SQLite |
| API 形态 | **2 类** | 同步 API + async facade |
| 重点后续项 | **Dream 测试** | 当前主要覆盖率提升空间 |

**这是一个经过系统测试、边界清晰、适合继续扩展的本地 Agent Memory 系统。**

---

## 需要帮助？

- 📧 查看 [README.md](README.md)
- 🐛 遇到问题？查看测试用例 `tests/`
- 💡 想要更多示例？查看 `demo.py` 和 `demo_async.py`

**开始使用 Agent Memory，让你的AI助手拥有真正的记忆！** 🚀
