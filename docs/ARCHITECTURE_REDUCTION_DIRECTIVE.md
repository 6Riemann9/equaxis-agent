# Equaxis 架构减负指挥文档

> 状态：执行规范
>
> 适用范围：Equaxis runtime、Pi Extension、Memory、工具治理、评测系统及其启动入口
>
> 核心目标：在不牺牲安全边界、可审计性和可回滚性的前提下，缩短默认执行路径，减少职责重叠，让普通任务只承担普通任务所需的系统复杂度。

## 一、指挥意图

Equaxis 不推倒重写，也不 fork Pi。

Pi 继续负责模型、会话、上下文、TUI、原生工具和 Agent Loop。Equaxis 只提供 Pi 原生能力没有提供、且能被确定性验证的治理能力。

本轮改造必须得到以下结果：

1. 默认启动不再加载所有能力。
2. Memory、Web、Tool Catalog、Tool Scheduler 和离线评测退出默认核心路径。
3. Reliability Harness 收缩为策略、审批、审计和运行边界，不负责所有业务编排。
4. 每个可选能力都有清晰的启用入口、失败降级和独立测试。
5. `pi:raw` 继续工作，Equaxis 也能够在最小模式下独立工作。
6. 任何删除或合并都必须有证据、有替代路径、有回滚点。

一句话判断标准：

> 如果一个能力不是每次工具调用都需要，就不能因为方便而进入每次工具调用的默认链路。

## 二、现状判断

当前系统的复杂度主要不是来自单个模块，而是来自多个运行时职责同时参与一次任务：

- Pi Agent Loop 和 Extension 生命周期。
- 风险分类、审批、保护路径和 Trace。
- 工具参数修复、结果语义校验、重试和循环终止。
- MCP、CLI、HTTP 工具适配和动态目录。
- Memory 的 Node/Python Bridge、召回和持久化。
- Web 抓取、重定向检查和外部网络策略。
- DAG 调度、并发、取消、补偿和幂等。
- Harbor 评测、假设生成、实验和部署决策。

这些能力各自有价值，但不应默认形成一条长链路。当前最需要治理的是耦合方式，而不是简单减少文件数量。

## 三、目标架构

```text
                         ┌──────────────────────────┐
                         │ Pi Runtime                │
                         │ Model · Session · TUI     │
                         │ Agent Loop · Native Tools│
                         └────────────┬─────────────┘
                                      │ stable Extension API
                         ┌────────────▼─────────────┐
                         │ Equaxis Core               │
                         │ Policy · Approval · Trace │
                         │ Budget · Stop Conditions │
                         └──────┬───────────┬────────┘
                                │           │
                 ┌──────────────▼───┐   ┌──▼────────────────┐
                 │ Optional Runtime  │   │ Offline Evaluation │
                 │ Memory            │   │ Harbor Adapter     │
                 │ Web               │   │ Diagnosis          │
                 │ Catalog           │   │ Experiments        │
                 │ Scheduler         │   │ Reports            │
                 │ MCP               │   └────────────────────┘
                 └──────────────────┘
```

### 3.1 必须保留在核心路径的能力

| 能力 | 责任 | 当前主要位置 |
|---|---|---|
| 风险分类 | 对工具调用做确定性风险判断 | `src/policy.mjs` |
| 保护边界 | 保护凭据、`.git`、工作区外路径等 | `src/policy.mjs`、可靠性扩展 |
| 单次审批 | 对当前完整工具调用进行一次性 HITL 决策 | `.pi/extensions/reliability-harness.ts` |
| 审计 Trace | 记录策略、审批、执行结果和耗时，不记录敏感正文 | `.pi/extensions/reliability-harness.ts`、`src/trace-store.mjs` |
| 执行预算 | 工具次数、时间、费用或连续失败上限 | 可靠性扩展 |
| 停止条件 | 重复调用、无进展、循环和不可达状态终止 | 可靠性扩展 |

核心必须保持小而稳定。核心不能依赖 Python、外部网络、Harbor、动态工具目录或特定业务插件才能启动。

### 3.2 必须改为按需启用的能力

| 能力 | 默认状态 | 启用条件 |
|---|---|---|
| Memory | 关闭 | 用户启用 Memory，或任务明确需要长期记忆 |
| Web Crawler | 关闭 | 用户或任务明确需要公共网页访问 |
| Tool Catalog | 关闭 | 工具数量超过静态注册可管理范围，或用户显式搜索工具 |
| Tool Scheduler | 关闭 | 任务明确包含多个可并行节点，且有调度收益 |
| MCP Adapter | 关闭 | 当前会话配置了 MCP 来源 |
| 结果语义校验 | 按工具契约启用 | 工具声明了可验证的结果契约 |
| 参数修复 | 按工具契约启用 | 工具声明了可修复的参数错误 |

“关闭”表示不加载、不启动、不建立外部连接，不表示删除能力。

### 3.3 必须移出生产运行时的能力

以下内容只属于离线评测或研究流程：

- Harbor 任务读取和运行器适配。
- 能力矩阵、假设生成和 A/B 实验。
- 报告生成和可选 LLM 分析。
- Benchmark job、baseline 报告和实验产物。

评测系统可以读取 Runtime Trace，但 Runtime 不得反向依赖评测系统才能执行普通任务。

## 四、运行模式

最终应形成四种明确模式。模式选择必须是配置或启动参数，不应由模型自行决定。

| 模式 | 默认加载 | 适用场景 |
|---|---|---|
| `raw` | 无 Equaxis 扩展 | Pi 基线、故障隔离、兼容性检查 |
| `minimal` | Policy、Approval、Trace、Budget | 日常编码和普通工具调用 |
| `standard` | `minimal` 加按需契约校验 | 需要更强结果可靠性的工程任务 |
| `full` | 所有显式启用的可选扩展 | 研究、复杂编排、评测和专项任务 |

建议的行为：

- `pi:raw` 保持现有语义。
- `pi` 默认使用 `minimal` 或 `standard`，不得默认使用 `full`。
- `equaxis:full` 明确加载 Memory、Web、Catalog、Scheduler 等扩展。
- 某个可选组件启动失败时，回退到可用模式并报告原因，不得拖垮 Pi 核心。

## 五、改造顺序

### P0：冻结边界和建立基线

在任何代码重构前完成：

- 列出所有 Extension、注册工具、命令和外部进程。
- 标记每个模块的启动时副作用：进程、网络、文件、模型、数据库。
- 记录当前启动耗时、首轮工具调用耗时、内存进程数量和默认工具数量。
- 记录最小模式和完整模式的功能差异。
- 固定当前测试基线，包括类型检查、Node 测试、Memory 测试和评测测试。

交付物：

- 模块责任表。
- 默认执行路径图。
- 启动和首轮调用基线。
- 失败降级矩阵。

没有基线，不允许用“感觉更轻”作为完成依据。

### P1：建立 Profile，而不是先删除模块

新增统一的 Profile 解析层，负责决定哪些扩展被加载。Profile 层只做配置解析和扩展选择，不复制策略逻辑。

要求：

- `minimal` 不启动 Python Bridge，不访问网络，不加载动态目录和调度器。
- `full` 可以加载全部能力，但每项能力仍必须有独立失败处理。
- 未知 Profile 直接失败并给出可读错误。
- Profile 选择必须出现在启动日志和 Trace 元数据中。
- 旧入口在迁移期间保留兼容别名，不要一次性破坏脚本和文档。

### P2：把可选扩展改成惰性生命周期

按以下顺序迁移：

1. Memory：首次使用 Memory 工具或显式命令时才启动 Python Bridge。
2. Web：首次调用抓取工具时才建立网络执行路径。
3. Tool Catalog：首次搜索或配置动态工具源时才建立目录。
4. Scheduler：首次提交调度计划时才创建调度器状态。
5. MCP：只有存在有效 MCP 配置时才初始化连接。

每项迁移都必须回答四个问题：

- 未启用时是否没有启动副作用？
- 启动失败时 Pi 是否仍可继续工作？
- 用户如何知道该能力不可用？
- 如何测试启动、调用、失败和恢复？

### P3：收缩 Reliability Harness

Reliability Harness 只保留确定性治理职责：

- policy。
- approval。
- protected paths and secret blocking。
- execution budget。
- loop stop conditions。
- trace。

以下职责不得继续隐式堆在 Harness 主流程中：

- 业务级重试。
- 所有工具的参数修复。
- 所有结果的语义判断。
- 多工具 DAG 编排。
- Memory、MCP、Web 的协议细节。
- 评测诊断和部署决策。

这些能力应通过显式契约或可选执行器接入。Harness 可以提供统一挂点，但不能拥有每个领域的实现细节。

### P4：统一工具执行契约

为 MCP、CLI、HTTP、Memory 和其他工具定义同一组最小概念：

```text
ToolDescriptor
  name
  namespace
  inputSchema
  riskMetadata
  sideEffectMetadata
  resultContract

ToolInvocation
  invocationId
  toolName
  arguments
  source
  risk

ToolOutcome
  ok
  result
  error
  evidence
  retryable
  traceRef
```

适配器只负责传输和协议转换。Policy 只读取风险元数据，不读取具体协议细节。Result middleware 只验证声明过的 `resultContract`，不能把所有业务规则塞进通用层。

同一调用不得同时经过多套重试器、多个参数修复器或多个结果判断器。每类职责必须有唯一所有者。

### P5：评测彻底旁路运行时

运行时只产生事实：

- 工具调用。
- 策略决策。
- 错误。
- 耗时。
- Token 和成本。
- 任务结果。
- Trace。

评测系统负责读取这些事实，并在离线环境完成诊断、假设、实验和决策。禁止在 Pi 启动时导入 Harbor 或评测核心，禁止为了生成评测报告修改默认执行路径。

### P6：删除重复实现

只有满足以下条件，才允许删除旧实现：

- 新入口已覆盖原有行为。
- 失败和降级行为已经测试。
- 旧入口已有迁移说明或兼容别名。
- 最小模式和完整模式的回归结果已保存。
- 删除操作不影响用户已有未提交工作。

删除优先级：

1. 重复的配置解析。
2. 重复的工具调用包装器。
3. 重复的重试和错误归一化。
4. 仅用于旧实验、且没有运行时引用的适配层。
5. 无测试、无调用者、无文档引用的死代码。

## 六、职责归属表

| 问题 | 唯一责任方 |
|---|---|
| 这次调用能不能执行 | Policy + Approval |
| 是否超过本轮预算 | Reliability Core |
| 是否陷入重复或无进展 | Stop Conditions |
| 工具如何连接 MCP/HTTP/CLI | Adapter |
| 参数是否符合工具输入契约 | Tool Contract |
| 结果是否达到工具声明的结构契约 | Result Contract |
| 是否重试业务错误 | 具体工具执行器 |
| 是否并行执行多个任务 | Scheduler |
| 是否保存长期记忆 | Memory |
| 评测失败属于哪个能力缺陷 | Evaluation Core |
| 是否部署实验候选 | Evaluation Decision |

如果一个改动同时修改三行以上职责，必须先补充边界说明和测试，不得直接增加中间层掩盖冲突。

## 七、禁止事项

以下行为在减负期间禁止：

- 不得 fork 或修改 Pi 核心来解决 Equaxis 的职责问题。
- 不得把所有扩展继续追加到默认启动命令。
- 不得用一个“万能 orchestrator”替代多个边界清晰的模块。
- 不得让 Policy 调用模型、网络、Memory 或评测系统。
- 不得让 Memory Bridge 成为 Pi 启动的硬依赖。
- 不得在没有结果契约的情况下增加通用语义校验。
- 不得用 `npm audit fix`、全量格式化或无关升级掩盖架构变更。
- 不得回退、覆盖或清理用户已有的未提交修改。
- 不得以删除测试、降低断言或关闭 Trace 的方式制造“变轻”。
- 不得在没有基线和回滚点的情况下进行跨模块批量重构。

## 八、验收指标

每个阶段都必须提供证据。最终至少满足：

### 启动隔离

- `minimal` 启动不产生 Python 子进程。
- `minimal` 启动不访问外部网络。
- `minimal` 不加载 Web、Catalog、Scheduler、MCP 和 Harbor。
- 可选组件失败不会阻断 Pi 和核心治理层。

### 执行路径

- 默认工具调用的必经阶段明确为：`policy -> approval(if needed) -> execute -> trace`。
- 同一调用不会进入两套并行重试器或两套参数修复器。
- Trace 不保存 write/edit 正文和原始密钥。
- 高风险调用在无审批 UI 的模式下仍然拒绝。

### 功能回归

- `raw` 模式保持可用。
- `minimal` 模式能完成普通读、写、编辑和命令任务。
- `full` 模式保留已声明的 Memory、Web、Catalog、Scheduler 和 MCP 能力。
- 类型检查、核心测试、Memory 测试和评测测试都有明确结果。

### 复杂度下降

基线建立后，建议目标为：

- 默认启动副作用数量下降至少 30%。
- 默认启动加载的扩展数量下降至少 30%。
- 首次 Memory/Web/动态工具调用前不产生对应外部资源开销。
- 核心治理模块不再直接依赖 Python、Harbor 或具体网络协议。
- 每个运行时模块都有唯一责任、唯一入口和最小测试集。

如果性能没有提升，但故障隔离、可理解性和独立测试能力明显改善，也必须在报告中说明原因，不能只报一个总体耗时。

## 九、回滚和发布策略

每个阶段使用独立提交，提交说明必须包含：

- 变更的 Profile 或模块边界。
- 影响的默认路径。
- 新增或修改的测试。
- 失败降级方式。
- 回滚命令或回滚提交。

发布顺序：

1. 保留旧入口，新增 Profile。
2. 让 `minimal` 进入内部测试。
3. 默认入口切换到 `minimal` 或 `standard`。
4. 保留 `full` 作为兼容和研究入口。
5. 观察真实 Trace 后再删除旧包装器。

出现以下任一情况，立即回退当前阶段：

- Pi 无扩展模式不可用。
- 核心治理层依赖可选外部服务才能启动。
- 高风险调用在无审批 UI 时被放行。
- Memory、Web 或 MCP 故障导致普通任务无法执行。
- Trace 出现敏感正文或凭据。
- 默认路径的失败率或循环率显著上升。

## 十、第一批执行任务

按以下顺序开工，不跨阶段抢跑：

- [x] 建立当前 Extension、工具、外部进程和启动副作用清单。
- [x] 为现有启动入口标注 `raw`、`minimal`、`standard`、`full` 归属（`src/runtime-profiles.mjs`）。
- [x] 加入 Profile 解析和启动元数据 Trace（`scripts/equaxis.mjs` 选扩展、banner 显示、`session_start` trace 携带 profile、doctor 报告）。
- [x] 让 Memory Bridge 改为首次使用时启动（`session_start` 不再启动；autoRecall 或首次工具/命令才拉起）。
- [ ] 让 Web、Catalog、Scheduler、MCP 改为按需初始化。（Catalog/Scheduler 已归入 `standard`/`full` 选择，但尚无运行时惰性生命周期）
- [x] 将 Reliability Harness 的职责限制在策略、审批、审计、预算和停止条件（EvalLoop 已移出）。
- [ ] 定义统一 `ToolDescriptor`、`ToolInvocation`、`ToolOutcome` 契约。
- [x] 将评测导入和运行时启动彻底分离（harness 只写 trace 事实，评测/导出离线从 trace 恢复）。
- [ ] 建立最小模式的启动、故障隔离和回归测试。（profile 选择已有单测；启动副作用基线测试待补）
- [ ] 输出减负前后对比报告，再决定是否删除旧实现。

## 十一、完成定义

架构减负完成，不代表文件更少，而是满足以下判断：

> Pi 可以独立运行；Equaxis 核心可以独立治理；可选能力按需加入；离线评测独立运行；任何一个非核心模块故障，都不会让普通任务承担不必要的失败成本。

在此之前，不增加新的跨模块治理层，不扩展默认启动链路，不把新的业务逻辑放进 Reliability Harness。
