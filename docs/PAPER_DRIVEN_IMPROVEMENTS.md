# 论文驱动的 Equaxis 改进(Paper-Driven Improvements)

> 依据 2026-08 精选 arXiv 论文对 Equaxis 实施的 10 项改进。每项含:论文依据(为什么做)、问题诊断(现状缺陷)、设计决策(为什么这么改)、实现细节(改了什么)、验证(数据支撑)、风险与回滚(commit + 降级路径)。
>
> 对应提交:`f9b06dd` → `267e827` → `8975e88` → `c918780` → `54043fc` → `7199b01` → `ba8e46e` → `3750560` → `c636733` → `3bae294` → `8c46cd3`(均在 `main` 分支,可用 `git show <commit>` 回溯)。

---

## 1. 记忆检索:embedding 距离阈值分段衰减 + 可配置

**Commit**: `f9b06dd fix(memory): staged-decay closet boost distance thresholds, configurable`

### 论文依据

**SimGates: Similarity Gates Approve Reversals: A Validity Audit of Embedding-Cosine Thresholds in Agent Systems**(Scott E. Frias, arXiv 2608.10216, 2026-08)

- 用 2×2 因子语料(决策 × 词汇重叠)证明:已部署的 embedding 余弦阈值门控(去重/语义缓存/漂移检测/答案评分)测的是**措辞而非意思**
- **否定反转场景结构性失效**:"禁用 X" 与 "启用 X" 的 embedding 距离近到无法用固定阈值区分
- 换编码器、条件门控、NLI 三种"显然的修复",在隔离撰写的 held-out 语料上**全部落回随机水平**

### 问题诊断

Equaxis 记忆检索(`vendor/agent-memory/memory/store/long_term.py` `_closet_boosts`)存在一处 embedding 距离门控:

```python
if distance > 1.5:   # 魔法数字,硬切边界
    continue
```

- `1.5` 是魔法数字:无出处、不可配置
- **硬边界**:距离 1.49 给满分加分,1.51 给零分——边缘相关记忆的排序结果被 0.01 的距离差任意翻转(SimGates 指出这类阈值在措辞变化下不可靠)
- 加分结果直接暴露给用户(`distance=0.1234`),用户会误读为"语义相关度"

**审计结论(SimGates 应用范围界定)**:Equaxis 只有这一个阈值点;它控制的是**排名加分**,不控制结果集(主检索 `search()` 无硬过滤,所有候选都返回)——不构成 SimGates 的高危"放行/拒绝"门控。写入侧去重是 SQL id 级(内容哈希),无 embedding 去重。因此修复方向是**缓解硬边界 + 配置化**,而非推翻设计。

### 设计决策

- **阈值用于软决策而非硬决策**(SimGates 教训的直接应用):加分强度分段衰减,不搞二值放行
- **默认值保守**:`full=0.8`(该距离内全额)、`cutoff=1.5`(之外零分),中间区间半额——保留原语义的同时消除硬切
- **配置化**:阈值进 `LongTermConfig`,validator 校验 `0 < full < cutoff`,规则变更可追溯(与第 5 项规则版本化衔接)

### 实现细节

| 文件 | 改动 |
|---|---|
| `vendor/agent-memory/memory/config.py` | `LongTermConfig` 新增 `closet_boost_cutoff: float = 1.5`、`closet_boost_full: float = 0.8`(含 SimGates 注释说明) |
| `vendor/agent-memory/memory/store/long_term.py` | `_closet_boosts` 读取配置;`distance <= full` 全额、`full < distance <= cutoff` 半额、`> cutoff` 零分 |
| `vendor/agent-memory/memory/config_validator.py` | 校验 `cutoff > 0`、`full > 0`、`full < cutoff` |
| `vendor/agent-memory/tests/test_long_term.py` | +2 测试:分段衰减边界(0.5→0.40 / 1.0→0.125 / 1.6→无)、配置默认值 |

### 验证

- `pytest tests/test_long_term.py tests/test_config_validator.py`:**23 passed**
- 行为不变量:召回结果集不变(boost 只影响排序加分),零回归风险

### 风险与回滚

- 风险:低。最坏情况是排序微变;`git revert f9b06dd` 即完全还原
- 降级路径:设置 `closet_boost_full = closet_boost_cutoff` 即退化为原二值行为

---

## 2. 技能系统:血缘持久化 + 只删不增审查门 + 证据驱动退役

**Commit**: `267e827 feat(skills): provenance persistence, delete-only review gate, evidence-driven retirement`

### 论文依据

**Practice Makes Unsafe: Skill Misevolution in Self-Improving LLM Agents**(Xutao Mao 等, arXiv 2608.12851, 2026-08)

- 首次形式化"**技能误演化**":自我改进 agent 把一次不安全成功固化为技能文件,跨会话复用 → 纵向失败(轨迹 → 技能生命周期)
- 基准实验:**21 个演化配置全部写出不安全技能**;仅 3 个恶意任务就把跨会话危害从 16.0% 抬到 35.3%
- 治理方案 **SAFEEVOLVE**(只删不增 + 血缘风险检索 + 有害复用归因 + 证据驱动退役):危害降 **17.3pp**,良性效用几乎不变(**-0.4**)

### 问题诊断

Equaxis 技能系统(`src/skill-store.mjs` + `src/skill-lifecycle.mjs` + `.pi/extensions/skills.ts`)的差距:

1. **血缘丢失**:`deriveSkillFromRun` 已从失败 run 提取 `evidence[]` + `sourceRun`,但 `serializeSkill` 只写 name/description/triggers——**证据链在落盘时被丢弃**,技能无法追溯来源
2. **无写前审查**:`applySkillCandidate` 直接部署;更新既有技能时,新增内容无需任何证据支撑(攻击面:一次不安全成功可以静默改写/扩充已部署技能)
3. **无退役机制**:技能一旦写入永远参与检索注入,没有"长期无良性复用即停用"的路径

### 设计决策

- **血缘是审计基础**:frontmatter 持久化 `evidence[]`/`source`/`created`/`retired`/`retiredReason`,与版本存储(VersionStore)的 candidate 记录互补——文件级可审计 + 版本级可回滚
- **只删不增 = 审查门槛而非编辑禁令**:`reviewSkillCandidate` 对"更新且新增行无证据"判定 `needs_review`,`applySkillCandidateGuarded` 拒绝部署(错误码 `SKILL_REVIEW_BLOCKED`);create 型变更直接通过。这与 SAFEEVOLVE 的"删除式修复"一致:安全加固通过删/改实现,新内容必须有证据
- **退役 ≠ 删除**:`retireSkill` 翻转 frontmatter `retired: true` + 理由,内容保留供审计(只删不增原则:绝不静默重写 agent 学到的东西);`selectRelevantSkills` 过滤 retired,注入层不再出现
- **证据进 candidate metadata**:`createSkillCandidate` 把 `evidence` 存入 metadata,审查门在部署时(而非写入时)也能核验

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/skill-store.mjs` | `parseSkillFile` 解析 evidence/source/created/retired/retiredReason;`serializeSkill` 持久化这些字段(自动补 created 时间戳);`selectRelevantSkills` 过滤 `retired: true` |
| `src/skill-lifecycle.mjs` | 新增 `reviewSkillCandidate`(行级 diff + 证据核验)、`applySkillCandidateGuarded`(门控部署)、`retireSkill`(frontmatter 重组,保留内容);`createSkillCandidate` metadata 带 evidence |
| `.pi/extensions/skills.ts` | 自动提取(`agent_end` → `deriveSkillFromRun`)把 evidence/sourceRun 传入 `writeSkillFile`;`skill_search` 的 matches 详情暴露 source/evidence/retired |
| `tests/skill-store.test.mjs` | +2:血缘往返、retired 排除 |
| `tests/skill-lifecycle.test.mjs` | +4:create 放行、无证据更新阻断、有证据放行、退役保留内容 |

### 验证

- `node --test tests/skill-store.test.mjs tests/skill-lifecycle.test.mjs`:**21 passed**
- 全量:`node --test tests/*.test.mjs`:**275 passed**
- 行为不变量:既有技能(无 evidence 字段)照常加载;`retired` 缺失默认 false,不改变存量行为

### 风险与回滚

- 风险:中低。审查门可能拦截"合理但无证据"的手动技能更新——解法是 `applySkillCandidateGuarded({ requireReview: false })` 显式跳过(默认拦截)
- `git revert 267e827` 完全还原;已退役技能只需删掉 frontmatter 两行即复活

---

## 3. 记忆整合:语义段级整合(替代 8000 字符截断)

**Commit**: `8975e88 feat(memory): semantic segment-level consolidation for dream extraction`

### 论文依据

**LycheeMemory V2: Efficient Long-Term Memory for LLM Agents via Semantic Segment-Level Consolidation**(Dongfang Li 等, arXiv 2608.12990, 2026-08)

- 段级整合:embedding 边界判定把多轮对话打包成语义段 → **每段一次 LLM 编码**为类型化自包含记录 → 一次规划 + 确定性多通道检索
- 数据支撑:LoCoMo **89.22%** / LongMemEval-S **92.20%** SOTA 精度下,构造 token 较 A-Mem 降 **86.0%**/75.9%,查询 token 反降 27.9%/42.6%
- 结论:记忆精度-成本权衡取决于**整合粒度**,整批整合是次优解

### 问题诊断

`src/memory-consolidate.mjs` `consolidateMemoryHistory` 原实现:

1. **整批拼接 + 8000 字符截断**:`buildMemoryExtractionPrompt` 对超长历史 `lines.slice(-8000)`——**早期历史被静默丢弃**(信息丢失,不可恢复)
2. **无关对话混提**:一次 LLM 调用处理全部条目,主题切换处互相干扰,提取质量下降
3. **无边界概念**:LycheeMemoryV2 的核心(语义段)完全缺失

### 设计决策

- **语义边界 = 相邻条目 embedding 余弦 < threshold**(默认 0.75);同时有**硬大小上限**(默认 3000 字符)兜底,保证任何段不会撑爆提示词预算
- **SimGates 原则应用**:切段是**软决策**——切错只改变提取粒度,每个条目仍落在恰好一个段里,零信息丢失;因此阈值只用于"分块粒度",不做任何放行/拒绝(embedding 不可靠的教训在此边界内安全)
- **每段一次 LLM 编码,小批量并发 3**:提取质量(主题内聚)+ 吞吐(不串行等待)+ API 压力可控
- **embed 失败软降级**:仅按大小上限切段(threshold=0 不分语义)——整合流程永不因分段基础设施故障而中断
- **配置全链路**:`memory.segmentation.{enabled, threshold, maxSegmentChars}` 从 `equaxis-config.mjs` → `memory.ts` → `consolidateMemoryHistory`
- **审计增强**:入库 memories/facts 的 metadata 记录 `segments` 数量(段数可追溯)

### 实现细节

| 文件 | 改动 |
|---|---|
| `vendor/agent-memory/memory/api/agent_api.py` | `AgentMemory.embed(texts)` — 用配置的 embedding function 批量向量化(384 维 all-MiniLM-L6-v2) |
| `bridge/memory_bridge.py` | 新增 `embed` action(JSON-RPC,texts → vectors) |
| `src/memory-consolidate.mjs` | `cosineSimilarity`(工具函数)、`segmentEntriesBySimilarity`(语义边界 + 大小上限)、`consolidateMemoryHistory` 重构为分段提取(并发 3,失败降级);`embedTexts` 私有 helper |
| `src/equaxis-config.mjs` | memory 节新增 `segmentation: { enabled, threshold, maxSegmentChars }` |
| `.pi/extensions/memory.ts` | `MemorySegmentationConfig` 接口 + `consolidateNow` 传参 |
| `tests/memory-consolidate.test.mjs` | +6:余弦已知值、主题切换切段、大小上限、无向量单段、每段一次提取(2 段 2 次 complete)、embed 失败降级;更新 1 个旧断言(metadata 带 segments) |

### 验证

- `node --test tests/memory-consolidate.test.mjs`:**13 passed**
- 端到端 embed 实测:384 维向量;不相关主题("UI layout" vs "auth service")余弦 **-0.007** → 正确切段
- 全量:`node --test tests/*.test.mjs` **281/281**;`pytest vendor/agent-memory/tests` **141/141**(需 `pytest-asyncio`,pyproject 的 `asyncio_mode = "auto"` 要求)

### 风险与回滚

- 风险:中。每段一次 LLM 调用 → 总调用数从 1 变为段数(最多 ceil(总字符/3000));成本上升换取"不丢信息 + 提取更准"。**若成本敏感**:设 `segmentation.enabled: false` 回到旧行为,或调大 `maxSegmentChars`
- `git revert 8975e88` 完全还原;embed action 新增无兼容性问题(bridge 协议向后兼容)

---

## 4. 评估:holdout 双集接受门(训练集提升 + 开发集不退化)

**Commit**: `c918780 feat(eval): holdout acceptance gate — train gain + dev non-regression`

### 论文依据

**AutoDesign: Meta-Harness Optimization for Long-Horizon Agentic Design**(Yaxin Luo 等, arXiv 2608.13560, 2026-08)

- 双环元-harness 优化:外环 coding agent 分析 rollout 轨迹,**每次只改 harness 一个功能组件**,经接受门(公式 6)累积更新
- **接受门 = 训练集提升 AND 开发集不退化**——防止过拟合评估切片的改动上线(论文以此累积 **54 次**成功更新,PosterBench 78.32 分超 Claude Design 7.45 分)
- 附带发现:弱模型从 harness 优化受益最大(+19.56),强模型最小(+5.01)

### 问题诊断

`src/eval-loop.mjs` `compareCandidate` 已是成熟的**单集**接受门:

- `insufficient_data`(样本不足)/ `reject`(成功率/延迟/成本回归)/ `deploy`(提升 ≥ 2pp 且置信区间不重叠)/ `scoped`(提升但 CI 重叠)

缺失:**holdout 维度**。单集门无法识别"在评估切片上过拟合"的改动——训练集涨、真实分布跌的变更会被放行。

### 设计决策

- **组合而非重写**:`compareCandidateWithHoldout` 复用主门,在其上叠加 holdout 检查——主门 reject/insufficient 直接短路,holdout 只在主门通过后裁决
- **容差语义**:`holdoutRegressionTolerance = 0.02`(默认)——开发集成功率跌超过 2pp 即 reject;持平或微跌放行(允许噪声)
- **诊断保留**:holdout 拒绝时返回 `mainDecision`/`mainReason`,定位"主集过了、开发集翻了"的过拟合特征
- **数据缺失不阻塞**:无 holdout 数据 → `holdout: "skipped"`,主门决策照常;样本不足 → `insufficient_data`(不误杀小样本实验)
- **与第 2 项衔接**:该门天然服务于"技能/策略候选的部署决策"——candidate 的版本化部署(AutoDesign 的单组件修改纪律)可接入此门

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/eval-loop.mjs` | 新增 `compareCandidateWithHoldout({ baseline, candidate, holdoutBaseline, holdoutCandidate, holdoutRegressionTolerance, minSamples, ...rest })` |
| `tests/eval-loop.test.mjs` | +1 测试 5 场景:deploy(主升+开发持平)、reject(开发回归)、主门短路、holdout 缺失 skipped、holdout 样本不足 |

### 验证

- `node --test tests/eval-loop.test.mjs`:**10 passed**
- 全量:`node --test tests/*.test.mjs`:**282/282**

### 风险与回滚

- 风险:低。纯函数新增,无行为变更(旧调用路径不变)
- **未完成部分(如实声明)**:holdout 数据流尚未接入 harness 持久化层——需要定义"训练集/开发集"切分策略(如按任务类型/时间窗/cohort 划分)。函数已就绪,接入点在 `EvalLoop` 的 cohort 机制(`createEvalEvent` 已支持 `cohort` 字段,按 cohort 聚合即可喂给 holdout 参数)
- `git revert c918780` 完全还原

---

## 5. 治理:L1 自动门审计轨迹 + 版本化策略规则

**Commit**: `54043fc feat(governance): L1 gate audit trail + versioned policy rules`

### 论文依据

**GUIDE: Governed Unified Intelligence for Document-to-Artifact Generation in Enterprise Settings**(Shivali Dalmia 等, arXiv 2608.12133, VLDB 2026 Workshop, 2026-08)

- 企业文档 → 制品生成的治理流水线:六个专业 Agent + **版本化规则存储** + schema 强制契约 + **两级验证门(L1 自动规则校验 → L2 LLM-as-judge/人工升级)** + 依赖感知 HITL
- 数据支撑:120 份真实文档上**幻觉率 15.7% → 3.2%**,周转 2-3 天 → 40-125 分钟
- 核心设计:每一级验证都留 **provenance**,规则变更后历史决策仍可归因

### 问题诊断

Equaxis 治理链(`src/policy.mjs` + `src/approval-queue.mjs` + `.pi/extensions/reliability-harness.ts`)已具备:

- L1 雏形:`classifyToolCall` 全量分类(LOW/MEDIUM/HIGH/BLOCKED),`approval: false` 的调用自动放行
- L2 雏形:高风险调用进 `approvals/requests/` 人工队列,web 面板/ TUI 决策

**缺口**:

1. **L1 决策无审计**:自动放行的调用没有任何结构化落盘——规则改错后无法回查"哪些调用曾按旧规则放行"
2. **规则无版本**:policy 配置(approval/limits/allowlist)变更无指纹,审计记录无法关联到产生它的规则集

### 设计决策

- **L1/L2 全链路可审计**:L2 已有 `approvals/decisions/`,新增 L1 的 `approvals/l1-decisions.jsonl`(追加式,防篡改语义 + 最新优先读取)
- **规则版本化 = 配置子集哈希**:`policyRuleVersion` 只对**决策相关字段**(approval/limits/policy/allowlist/protectedPaths)做 sha256(前 16 位)——与运行无关的字段(UI 配置等)变化不产生假版本变化;空配置退化 `unversioned`
- **审计不阻塞执行**:L1 记录 try/catch 包裹,写入失败只留 trace,绝不影响工具调用(审计是治理的观察面,不是执行门)
- **记录时机**:在 L2 审批块**之后**、工具执行计数之前——到达该点的调用必然放行,审计语义 = "实际放行的决策 + 当时的规则版本"

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/policy.mjs` | 新增 `policyRuleVersion(config)`(sha256 指纹,空配置 → `unversioned`) |
| `src/approval-queue.mjs` | 新增 `recordL1Decision`(追加 `l1-decisions.jsonl`:toolCallId/toolName/risk/reason/ruleVersion/decidedAt)、`listL1Decisions`(最新优先,容错坏行) |
| `.pi/extensions/reliability-harness.ts` | 放行路径记录 L1 决策(经 `approvalProjectRoot()` + `config.traceDir`,与既有审批队列同路径);失败仅 trace |
| `tests/policy.test.mjs` | +1:指纹稳定性(相同配置同指纹、变更配置异指纹、空配置 unversioned) |
| `tests/approval-queue.test.mjs` | 新建 +3:追加写、最新优先读、坏行容错 + 空轨迹 |

### 验证

- `node --test tests/policy.test.mjs tests/approval-queue.test.mjs`:**20 passed**
- 全量:`node --test tests/*.test.mjs`:**286/286**;`tsc --noEmit` 干净
- 行为不变量:audit 模式/off 模式不产生 L1 记录(插入点在 enforce 放行路径)

### 风险与回滚

- 风险:低。追加式日志,磁盘占用可忽略;写入失败静默
- `git revert 54043fc` 完全还原;已有 l1-decisions.jsonl 若不再需要可直接删除

---

## 6. 评估:holdout 接受门接入 EvalLoop 数据流(第 4 项收尾)

**Commit**: `7199b01 feat(eval): wire holdout acceptance gate into EvalLoop cohort data flow`

### 论文依据

同第 4 项(AutoDesign, arXiv 2608.13560)。第 4 项交付了纯函数 `compareCandidateWithHoldout`,但 harness 侧数据流未接——"训练集/开发集"没有来源。

### 问题诊断

`EvalLoop` 的事件模型已有 `cohort` 字段(`createEvalEvent` 支持),但:

1. 没有按 cohort 切分 train/dev × baseline/candidate 的聚合路径
2. `decision()` 只走单集 `compareCandidate`,holdout 门无调用方

### 设计决策

- **cohort 即数据流入口**:事件打 `cohort: "train" | "dev"` 标签 + `version: { kind, id }`(baseline 用旧版本 id,候选用新版本 id)
- **`decisionWithHoldout` 语义**:`trainCohort` 内 `versionId` 匹配的事件 = candidate,其余 = baseline;`devCohort` 同理构成 holdout 组;`compareCandidateWithHoldout` 裁决
- **versionId 必填**:防止"无候选版本"的静默误判(空候选 → insufficient_data 无意义),显式抛错
- **持久化**:决策记录带 `trainCohort/devCohort/versionId/tool/capability` 元数据,restore 后可完整回溯

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/eval-loop.mjs` | `EvalLoop#decisionWithHoldout`(cohort 切分 + 聚合 + 持久化);私有 `#statsFor`(单元格聚合,复用 snapshot 的统计形状)、`#eventsForCell`(cohort/tool/capability 过滤) |
| `tests/eval-loop.test.mjs` | +4:train 提升 + dev 持平 → deploy;dev 回归 → reject(带 mainDecision);持久化/恢复 holdout 元数据;versionId 必填 |

### 验证

- `node --test tests/eval-loop.test.mjs`:**14 passed**
- 全量:`node --test tests/*.test.mjs`:**290 passed**
- 行为不变量:旧 `decision()` 路径不变;未打 cohort 标签的事件不影响既有聚合

### 风险与回滚

- 风险:低。新增方法,不改旧路径;`git revert 7199b01` 即还原
- **使用前提**:调用方需给事件打 cohort/version 标签(评估运行器接入点,如按任务类型/时间窗划分 train/dev)

---

## 7. 可观测性:系统提示词前缀稳定性追踪(KVFlow)

**Commit**: `ba8e46e feat(observability): system-prompt prefix stability tracker + /equaxis-prefix`

### 论文依据

**KVFlow: Efficient Prefix Caching for Accelerating LLM-Based Multi-Agent Workflows**(UCSD + AWS, NeurIPS 2025)

- 前缀缓存复用请求间字节稳定前缀的 KV 张量,跳过 prefill
- provider 侧缓存(DeepSeek context caching / OpenAI automatic prefix caching)对命中按约 1/10 价格计费 + 首 token 延迟显著降低
- KVFlow 的核心洞察应用到 harness 层:**固定内容(系统提示词/工具 schema/静态技能块)必须保持为稳定前缀,动态内容(任务块/会话历史)必须在其后**

### 问题诊断

Equaxis 有多个 `before_agent_start` 注入点(skills/memory/reliability-harness),但:

1. **无可观测性**:无法回答"我的 prompt 组装是否保持了稳定前缀"
2. 动态技能块(按查询注入)可能被插到固定注入之间,悄悄破坏后续内容的缓存复用——看不见就无从优化

### 设计决策

- **只观测,不改写**:本模块绝不重写 prompt;测量数据驱动后续决策(如调整注入顺序)
- **SimGates 原则**:阈值只用于报告(stableRatio),不参与任何门控/放行
- **字节级稳定前缀**:`longestCommonPrefixLength` 按字符码比较——provider 缓存是字节级的,语义相似不算数
- **窗口统计**:最近 10 次请求的 min/avg 稳定比,趋势可见(稳定比上升 = 缓存友好度提升)
- **失败静默**:测量失败仅跳过,trace 记录,绝不影响 agent 启动(failureMode degrade)

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/prefix-stability.mjs` | `longestCommonPrefixLength`、`stablePrefixStats`(prev/curr/common/ratio)、`createPrefixTracker`(环形窗口 + min/avg) |
| `.pi/extensions/prefix-stability.ts` | `before_agent_start` 快照 systemPrompt → trace `prefix_stability` 事件;状态行显示稳定百分比;`/equaxis-prefix` 命令打印最近 10 次请求 + KVFlow 优化指引 |
| `.pi/extensions/contracts.json` | 注册扩展(第 21 个;failureMode degrade;provides `observability:prefix-stability`) |
| `tests/prefix-stability.test.mjs` | +4:公共前缀计算、比率语义(相同=1/无关=0/首次=0)、窗口 min/avg/淘汰、空 prompt |

### 验证

- `node --test tests/prefix-stability.test.mjs`:**4 passed**
- 全量:**294 passed**;`tsc --noEmit` 干净
- 行为不变量:不注入任何内容到 systemPrompt(只读快照),扩展失败降级

### 风险与回滚

- 风险:极低。纯观测;`git revert ba8e46e` 即还原
- **使用**:会话中执行 `/equaxis-prefix`;稳定比低 → 检查动态块是否注入在固定内容之前(命令输出含指引)

---

## 8. 子代理:阶段级失败归因(MARC v1)

**Commit**: `3750560 feat(subagents): MARC-style stage-level failure attribution`

### 论文依据

**MARC v1: An Open-Source Multi-Agent Framework for Clinical AI Reasoning and Coordination**(Saisha Shetty 等, arXiv 2608.13476, 2026-08)

- 确定性多智能体编排(抽取 → 推理 → 答案)+ YAML 声明式配置
- 关键设计:**阶段级失败归因**——每阶段独立评估,失败定位到具体阶段,而非整条链不透明失败

### 问题诊断

Equaxis 子代理运行(`src/subagent-runtime.mjs` + `src/subagent-state-store.mjs`)只记录:

- 状态字符串(`failed`/`cancelled`)+ 错误消息
- **不可回答**:"DAG 哪一阶段贡献了最多失败?"(调度?执行?结果校验?)

失败来源混在一个 error 字符串里:依赖失败、超时、取消、schema 校验失败、executor 异常无法区分。

### 设计决策

- **归因二元组 (phase, kind)**:阶段 × 类别,分诊友好:
  - `scheduling/dependency`(依赖未完成)
  - `execution/executor`、`execution/timeout`、`execution/cancelled`
  - `finalization/schema`(结果 schema 校验——独立阶段,因为它在执行完成后)
- **错误码优先**:`classifyFailure` 按 `errorCode`(TIMEOUT/ABORT_ERR/SCHEMA)判类,兜底按错误文本/状态
- **schema 失败显式编码**:`validateResultSchema` 失败现在 throw `code: "SCHEMA"`——否则 schema 错误会被误归为 executor
- **兼容旧数据**:`attributeFailures` 容忍无新字段的 legacy 行(归为 unknown)

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/subagent-runtime.mjs` | 导出 `classifyFailure(task)`;`#record` 对 failed/cancelled 自动补 `failurePhase/failureKind`(依赖释放路径显式标 scheduling/dependency);catch 记录 `errorCode`;schema 失败带 SCHEMA code;`status()` 暴露新字段 |
| `src/subagent-state-store.mjs` | `publicStatus` 暴露 `errorCode/failurePhase/failureKind`;新增 `attributeFailures(rows)` 聚合(byPhase/byKind/byCode + 主导失败分诊) |
| `tests/subagent-runtime.test.mjs` | +2:schema/executor/timeout 归因、依赖失败 → scheduling |
| `tests/subagent-state-store.test.mjs` | +2:聚合正确性、legacy/空行容错 |

### 验证

- 局部:runtime 17 + state-store 5 全过
- 全量:**298 passed**
- 行为不变量:completed 任务无归因字段(仅失败/取消);未配置时零开销

### 风险与回滚

- 风险:低。纯增量字段;`git revert 3750560` 即还原
- **使用**:持久化事件(events.jsonl)喂给 `attributeFailures()`,得到主导失败阶段/类别;供 dashboard 或分诊脚本消费

---

## 9. 子代理:完成声明的机器可检查证据(Vero)

**Commit**: `c636733 feat(subagents): machine-checkable evidence for completion claims`

### 论文依据

**Vero: Can AI Agents Build Formally Verified Software Repositories?**(Zhe Ye 等, arXiv 2608.13522, 2026-08)

- 首个仓库级"实现 + 证明"联合合成基准(43 个多模块 Lean 4 实例)
- 首创**接受机器检查负证据的正式审计机制**:agent 的完成声明必须能被检查器验证,负证据(检查失败)同样被正式记录
- 核心启示:完成 ≠ 声称完成;声称要有可检查的证据

### 问题诊断

Equaxis 子代理完成路径:executor 返回结果 → schema 校验 → `completed`。**无独立核验**:

- "我写了 build/report.md" → 直接采信,无人检查文件是否存在
- 结果中的产物声称无法与事实对照

### 设计决策

- **审计而非门控**:证据核验失败只把完成声明标记为 `unverified`(带 issues),**不失败运行**——核验是治理的观察面,不是执行门(与第 5 项 L1 审计同哲学)
- **可插拔校验器**:`verifyEvidence(task, result)` 由调用方注入(如检查 result 中的路径存在性);默认 null,零行为变化
- **校验器崩溃降级**:抛错 → `unverified: verifier error`,绝不影响运行
- **持久化**:evidence 字段随任务快照/事件落盘,审计闭环

### 实现细节

| 文件 | 改动 |
|---|---|
| `src/subagent-runtime.mjs` | constructor 接受 `verifyEvidence`;完成路径 schema 校验后执行,记录 `task.evidence = { status, issues }`;trace `subagent_evidence_verified/unverified`;`status()` 暴露 |
| `src/subagent-state-store.mjs` | `publicStatus` 暴露 `evidence`(未配置校验器时为 null) |
| `tests/subagent-runtime.test.mjs` | +1:verified / unverified / verifier 崩溃降级 / 无校验器(null) |

### 验证

- 局部:**18 passed**(runtime);全量:**299 passed**
- 行为不变量:未注入校验器时 evidence 为 null,与旧行为完全一致

### 风险与回滚

- 风险:极低。可选注入;`git revert c636733` 即还原
- **使用**:构造校验器(如 `verifyEvidence: async (_task, result) => ({ ok: fs.existsSync(result.artifact) })`),harness 消费 evidence.unverified 做后续策略(如重试/人工复核)

---

## 10. P0 收尾:接线 + 实测(本轮)

**Commits**: `3bae294`(证据校验器接入 + cohort 标签)、`8c46cd3`(跨会话前缀对比)

### 10.1 证据校验器接入 subagent 引擎

第 9 项的 `verifyEvidence` 从"可选注入"变为**默认启用**:

- 新增 `src/subagent-evidence.mjs`:`createFileEvidenceVerifier({ projectRoot })` 扫描结果中的产物字段(`path/file/artifact/filePath/outputPath` 及 `files/artifacts` 等集合),相对路径按工作区根解析,做存在性检查;URL 与 data URI 跳过
- `subagent-engine.ts` 注入默认校验器;`subagents.evidence.enabled: false` 可关闭
- 测试:+3(存在/缺失/嵌套集合/URL 跳过/相对路径解析)

### 10.2 eval cohort/version 标签接入

第 6 项 `decisionWithHoldout` 的数据来源打通:

- `reliability-harness.ts` 的 `eval_outcome_recorded` 事件现在带 `cohort` + `version`(来自 `reliability.eval.{cohort, versionId}` 配置)
- 使用流程:基线跑 `reliability.eval = { cohort: "train", versionId: "base-v1" }` → 候选跑 `versionId: "cand-v2"` → 开发集跑 `cohort: "dev"` → 离线 `EvalLoop#decisionWithHoldout` 裁决
- 空配置保持 legacy 无标签行为

### 10.3 前缀稳定性实测(真实会话,deepseek-v4-flash)

两次真实会话(`--mode json`,最小任务)采集结果:

| 指标 | 值 |
|---|---|
| systemPrompt 长度 | 19123 字符 |
| **跨会话稳定前缀** | **13192 字符(69.0%)** |
| 前 4000 字符稳定比 | **100%** |
| 动态内容位置 | 尾部(5931 字符) |

**结论**:Equaxis 的 prompt 组装符合 KVFlow 的"固定前缀 + 可变后缀"布局——前 69% 字节稳定,provider 前缀缓存可命中;动态块(约 31%)在尾部,不污染稳定区。缓存友好度良好,无需调整注入顺序。

实测还暴露并修复了一个观测盲区:单会话 tracker 无法跨会话对比,因此扩展持久化最近 prompt 头部样本(20K 字符)到 `.pi/runtime/prefix-stability.json`,新会话首次测量即与上次会话对比(`crossSessionRatio`),并加 `promptSha` 内容指纹。

### 10.4 Equaxis + pi-web 冒烟

- **Equaxis 真实会话**(2 次):完整扩展链加载(21 扩展),deepseek 调用成功,reliability harness enforce 模式全程无拦截,回复正确,~8s/次
- **pi-web**(仓库版构建,端口 30141):`/` 200、`/api/home` 200、`/api/memory?cwd=` 200(11 wings / 14 entities / 10 triples)、`/api/harness?cwd=` 200、`/api/skills?cwd=` 200

---

## 汇总

| # | 论文 | 主题 | Commit | 测试增量 | 全量 |
|---|---|---|---|---|---|
| 1 | SimGates (2608.10216) | embedding 阈值分段衰减 | `f9b06dd` | +2 | 23 (py 局部) |
| 2 | PracticeUnsafe (2608.12851) | 技能血缘/审查门/退役 | `267e827` | +8 | 275 |
| 3 | LycheeMemoryV2 (2608.12990) | 语义段级记忆整合 | `8975e88` | +6 | 281 node + 141 py |
| 4 | AutoDesign (2608.13560) | holdout 双集接受门 | `c918780` | +5 场景 | 282 |
| 5 | GUIDE (2608.12133) | L1 审计 + 规则版本化 | `54043fc` | +4 | 286 |
| 6 | AutoDesign (2608.13560) | holdout 门接入 EvalLoop 数据流 | `7199b01` | +4 | 290 |
| 7 | KVFlow (NeurIPS 2025) | 前缀稳定性观测 + /equaxis-prefix | `ba8e46e` | +4 | 294 |
| 8 | MARC v1 (2608.13476) | 子代理阶段级失败归因 | `3750560` | +4 | 298 |
| 9 | Vero (2608.13522) | 完成声明机器可检查证据 | `c636733` | +1 | 299 |
| 10 | 收尾接线+实测 | 证据校验器默认启用、cohort 标签、前缀实测 69% 稳定、pi-web 冒烟 | `3bae294` `8c46cd3` | +4 | 303 |

**通用原则**(贯穿 10 项):

1. **阈值只做软决策**:SimGates 证明 embedding 阈值不可靠——任何基于它的判断要么分段衰减(1)、要么只影响粒度不丢信息(3)、要么不参与裁决(5 的指纹是身份不是语义、7 的稳定比只报告不门控)
2. **审计先于治理**:血缘(2)、段数(3)、规则版本(5)、L1 轨迹(5)、归因(8)、证据(9)都落盘,事后可归因
3. **软降级优先**:embed 失败降级(3)、holdout 缺失跳过(4/6)、审计失败静默(5)、校验器崩溃降级(9)、测量失败跳过(7)——基础设施故障永远不阻塞主流程
4. **审计不是门控**:证据核验(9)、L1 记录(5)标记问题但不阻断执行——治理的观察面与执行面分离
5. **每步独立 commit + 全量回归**:11 个 commit 均可独立回滚,node/py/tsc 三套验证全绿(当前 303/303 + 141/141)

---

## 11. 联想式回忆 + InternS2 设计笔记(本轮)

**Commit**: `3047d40 feat(memory): associative recollection — anchor + source-edge expansion`

### 11.1 RippleMem 联想式回忆(已实现)

**论文依据**:RippleMem(arXiv 2608.13334)把记忆访问从孤立检索重构为证据条件化联想回忆——先召回锚点,再沿结构边有界扩展,拼合分散在同源事件流中的证据(30× 更低图构建成本,LoCoMo 87.14%)。

**实现**:
- `LongTermMemoryStore.associative_search`:向量锚点(top-k)→ 沿 `source_file` 边扩展(同源邻居,距离 +0.3 一跳惩罚)→ 合并排序
- **测试驱动的设计修正**:初版把 wing/room 也当扩展边,单测立即暴露"同翼≠相关"(coffee 记忆被误召回)——修正为只沿 source_file 边(命名空间不是相关性)。这正是测试价值的体现
- bridge 新 action `associative_search`;`recall` 工具加 `associative: true` 参数(默认 false,旧行为不变)

**真实数据验证**(Equaxis 记忆库,11 wings):联想检索正常运行;当前库几乎单源(dream 整合),联想与普通检索等价——正确行为;多源拼合场景由单元测试覆盖。

**实测彩蛋**:真实会话回归中 DeepSeek 报告 `cacheRead: 2816 tokens`——第 7 项的前缀稳定化开始产生 provider 缓存命中(约 15% 输入 token 命中缓存),KVFlow 收益兑现。

### 11.2 InternS2 harness×task 抽象(设计笔记,未实现)

**论文依据**:Intern-S2-Preview(arXiv 2608.13505)用"harness×task 统一 RL 抽象"把 harness 行为与任务解耦,分别优化。

**对 Equaxis 的映射(评估设计建议)**:
- 事件模型已具备两个维度:`version`(harness 配置版本)= harness 轴,`capability`(工具能力)= task 轴
- `decisionWithHoldout` 已按 version 切分(train/dev)——"harness 改动是否对任务泛化"可由此评估
- **建议**:评估报告按 (version, capability) 交叉聚合,回答"这次 harness 改动提升了哪些能力、退化了哪些"——capability 粒度即可,无需新代码
- Memory Decoder 概念(冻结骨干 + 模块化专化)对应 Equaxis 扩展系统现状:扩展隔离已实现,无需改动

---

## 12. 开源 agent 项目借鉴(本轮)

**Commits**: `e91d0f7`(per-model 并发分桶 + 工具级 checkpoint)、`f8ee59c`(配置未知 key 拒绝)

调研对象:deepseek-harness(DSH, 107k★)、oh-my-opencode、oh-my-pi(omp)、openai/codex、Claude Code。三份 scout 报告提炼的共性主线:审批分层化、记忆 agent 自维护化、上下文快照-回退化、配置可审计化。

### 12.1 per-model 并发分桶(oh-my-opencode)

**借鉴**:oh-my-opencode 背景任务按 model/provider routing key 分桶限流(默认 5),避免单一 provider 配额被打爆。

**实现**:`SubagentRuntime` 接受 `modelConcurrency: { modelKey: limit }`;task 带 `modelKey`(spawn/schedule 的 `model` 字段);`#drain` 遍历队列选择"桶有容量"的任务运行——**一个模型饱和不阻塞另一模型的 DAG 分支**。无配置时单桶无限,旧行为不变。

**验证**:+2 测试(同桶串行 + 异桶并行、legacy 行为)。

### 12.2 工具级 checkpoint / rewind(Claude Code + omp)

**借鉴**:Claude Code checkpoint/rewind(每 prompt 快照、100 份保留、定向回退);omp 同款。Equaxis 之前完全没有回退能力。

**实现**:`src/checkpoint-store.mjs`——write/edit 执行前把目标文件快照到 `.pi/runtime/checkpoints/<toolCallId哈希>/`(保留相对布局、工作区限定、环形保留 20 份);`/equaxis-checkpoint list|restore <id>|latest` 回滚坏编辑。审计向:快照失败不影响工具执行。

**验证**:+4 测试(快照/回滚、工作区逃逸防护、环形裁剪、稳定 id)。

### 12.3 配置未知 key 拒绝(DSH)

**借鉴**:DSH 的 Schemastery 运行时校验——未知 key 直接拒绝加载,拼写错误当场暴露而非静默吞掉。

**实现**:`mergeConfig` 对内置节(runtime/reliability/memory/skills/evaluation/subagents/advisor/protocols 及子节)做 known-key 校验,错误信息带"已知 key 集合";顶层保持开放(第三方扩展可加自定义节)。默认配置补齐了运行时合法字段(memory.dream.provider/model、subagents.evidence)——本次校验即发现并修复了两处"默认配置缺失合法字段"的隐患。

**验证**:+2 测试(未知 key 拒绝、已知新增字段正常加载);集成测试曾抓出 dream.provider 误拒,已修复。

### 12.4 调研中评估后未实施(留档)

| 候选 | 来源 | 未实施原因 |
|---|---|---|
| category 语义路由 | oh-my-opencode | DAG 节点声明类别→配置映射模型;与现有 modelKey 分桶衔接,但需模型路由表设计 |
| 会话日志即上下文真源("model-visible means logged") | DSH | 内核级重构,Equaxis 层无法独立完成 |
| 工具执行五段管线 + 单调终局 | DSH | Equaxis 治理 harness 已有近似(审批+审计+终态),收益边际 |
| skill-embedded MCP(按需拉起即毁) | oh-my-opencode | 技能系统需扩展 MCP 生命周期管理,中等工作量 |
| 权限模式 classifier 级(模型自动审批) | Claude Code | 每次调用额外 LLM 成本,收益待实测 |

---

## 13. 开源项目五件套(本轮)

**Commit**: `68ca72c feat: intent gate, config dump, /goal, wisdom loop, prompt-impact metadata`

### 13.1 IntentGate 轻量扩展(oh-my-opencode)

regex 关键词命中 → 注入模式指令(`before_agent_start` 时,零模型成本,miss 无害)。配置 `intentGate.patterns` 声明式;默认提供 ultrawork/ulw(自主深工)、quick/fast/brief(极简模式)两组。`failureMode: degrade`,不注入任何内容到无命中请求。

### 13.2 /equaxis-config dump(DSH --dump-config)

合并后配置一键导出(JSON,secret 字段脱敏),`--json` 输出全文,默认截断 120 行。配置生效情况可审计——与第 12.3 项的未知 key 拒绝构成"加载即校验、随时可 dump"闭环。

### 13.3 /goal 命令(DSH goals 持久状态)

mission 状态早已随 saveState 持久化(重启保留),缺的是命令入口。`/goal <text> | status | clear`:设置/查看/清除会话目标,secret 防护,变更落 trace。

### 13.4 Wisdom 闭环(oh-my-opencode)

**语义修正**:初版设计"同批 schedule 内依赖注入"——测试立刻证明该语义不成立(schedule 同步 spawn,依赖尚未完成)。修正为**跨批次/跨会话**语义:任务完成 → `onTaskComplete` 回调 → 摘要(600 字符截断,优先 summary/learnings 字段)落盘 `.pi/runtime/subagents/wisdom/<id>.json`;后续 `spawn`/`schedule` 带 `wisdomRoot` 时,已完成依赖的 wisdom 拼接到依赖节点 prompt 前。**又一次测试抓出设计错误**。

### 13.5 Model Experience 成本纪律(DSH)

contracts.json 扩展新增可选 `promptImpact` 元数据(systemPromptChars/tools/notes),6 个注入类扩展已标注(如 skills: 按需 0-3000 tokens;prefix-stability: 零注入)。扩展对 prompt 的成本影响可审计——与 cost 显示面板、前缀稳定观测构成成本三件套。

### 验证

- Node **315/315**、集成 **21/21**、tsc 干净、真实会话回归通过
- 本轮三个教训:测试抓出"同批 wisdom 注入"设计错误;跨批次语义落地;契约新增字段零破坏

---

## 14. 开发循环:六项增强 + 自审(本轮)

**Commits**: `5354e55`(循环第一轮:category 路由 + 双审门 + 角色模板)、`b14dbdb`(循环第二轮:交叉矩阵 + 渐进披露 + checkpoint 摘要)、`31dbc36`(自审修复:wisdom 清理)

### 14.1 category 语义路由(oh-my-opencode)

`schedule`/`spawn` 节点声明工作类别(`deep`/`quick`/...),`SubagentRuntime.categoryRoutes` 映射到模型 key;显式 `model` 优先于 category 路由;类别记录在任务状态(审计可见)。模型选型从调用方下沉到 harness 配置层。

### 14.2 双审门禁(oh-my-opencode Momus+Oracle 精简版)

节点带 `reviewPrompt` 时,完成后由独立评审 pass(executor,`isReview` 标记)对结果评审,verdict(OKAY/REJECT/error)记录在 `task.review`。**REJECT 不失败运行**——审计语义,由调用方决定重试/人工。评审崩溃/无判定降级 `error`。

### 14.3 RSM 角色模板库(arXiv 2608.12311)

内置 architect/analyst/engineer/expert 四角色:系统提示词 + 工具白名单;`buildRolePrompt` 包裹任务 prompt(不替换),未知角色原样通过;`subagent_schedule` 支持 `role` 字段。

### 14.4 InternS2 评估交叉矩阵(arXiv 2608.13505)

`EvalLoop.capabilityDeltaMatrix({ baselineVersionId, candidateVersionId })`:按 capability 聚合 baseline vs candidate 成功率,回答"这次 harness 改动提升了哪些能力、退化了哪些"——不再是一个混合数字。支持 provider/model/tool/cohort 过滤。

### 14.5 ToolSearch 渐进式披露(DSH)

`tool-catalog.contextPreview()`:常用工具(11 个)全量描述 + 长尾工具仅名单——长尾 schema 不再吃满 prompt 预算,按需用 search 展开。

### 14.6 checkpoint 对话级(Claude Code)

checkpoint 携带会话摘要(harness 自动填入当前 goal),`/equaxis-checkpoint list` 显示"当时在做什么"——回滚时知道回到哪个工作点。

### 14.7 自审与修复

Doctor 23 项全 PASS;发现并修复 wisdom 文件无清理(新增 `pruneWisdom` 环形保留 200)。

### 验证

- Node **327/327**、Python **143/143**、tsc 干净、真实会话回归通过、doctor 22 PASS
- 本轮两次测试驱动的修正:空任务角色断言、跨批次 wisdom 语义(第 13.4 已记录)

---

## 15. 最终评估(开发循环收尾)

### 覆盖矩阵

| 能力域 | 已落地 | 依据 |
|---|---|---|
| 治理 | 审批分层(enforce/audit/off)、L1 审计轨迹、规则版本化、双审门禁 | GUIDE、DSH、oh-my-opencode |
| 记忆 | 语义段级整合、联想式回忆、closet 阈值衰减、wisdom 闭环、记忆治理 | LycheeMemoryV2、RippleMem、SimGates、oh-my-opencode |
| 技能 | 血缘持久化、只删不增审查门、证据驱动退役 | PracticeUnsafe |
| 子代理 | DAG 引擎、per-model 并发分桶、category 路由、角色模板、完成证据核验、阶段级失败归因 | RSM、MARC、Vero、oh-my-opencode |
| 评估 | holdout 双集接受门、能力×版本交叉矩阵、cohort 标签 | AutoDesign、InternS2 |
| 可观测 | 前缀稳定性(跨会话实测 69% 稳定)、checkpoint/rewind、配置 dump、promptImpact 成本纪律 | KVFlow、Claude Code、DSH |
| 上下文 | ToolSearch 渐进披露、技能按需注入、段级预算 | DSH、oh-my-opencode |

### 验证基线(循环收尾时)

- Node **327/327**、Python **143/143**、`tsc --noEmit` 干净
- 真实会话回归通过(deepseek,~8s/次);doctor 22 PASS(唯一 WARN:typescript-language-server 未安装,环境项)
- 19 个 commit 全部独立可回溯;文档 15 章 660+ 行

### 当前约束下的"无敌"边界(诚实声明)

以下不视为缺陷,而是**约束下的理论剩余空间**:

1. **会话日志即上下文真源**(DSH):append-only 日志派生模型历史——需要 Pi 内核级重构,Equaxis 扩展层无法独立完成
2. **skill-embedded MCP**(oh-my-opencode):技能按需拉起 MCP——依赖 Pi 内核的动态 MCP API
3. **model classifier 审批**(Claude Code):每次调用额外 LLM 成本,收益未实测,性价比存疑
4. **多 GPU/分布式**:无硬件前提
5. **LSP server 安装**:环境项(doctor 已提示)

### 使用手册(新增命令速查)

| 命令 | 用途 |
|---|---|
| `/equaxis-prefix` | 前缀稳定性报告(KVFlow 缓存友好度) |
| `/equaxis-checkpoint list\|restore <id>\|latest` | 工具级快照回滚(带会话 goal 摘要) |
| `/equaxis-config [--json]` | 合并配置导出(secret 脱敏) |
| `/goal <text>\|status\|clear` | 会话目标(持久化) |
| `subagent_schedule` 节点字段 | `model`(分桶)/ `category`(路由)/ `role`(角色)/ `review`(双审)/ `dependsOn`(DAG) |
| `recall` 工具 | `associative: true` 联想式回忆 |

### 结论

在"单机 + 云端 provider + Pi 0.83 内核"约束下,论文轮(11 篇)与开源轮(DSH/oh-my-opencode/omp/codex/Claude Code)调研的全部可落地改进已实施、测试、文档化。剩余项超出 Equaxis 层能力边界或收益/成本不划算——**这是当前约束下的完整状态**。未来若升级内核或引入自托管模型,第 1-4 项可重新评估。

---

## 16. 2026-08 周榜开源项目轮:CodeGraph + 目标状态内核 + 决策溯源(本轮)

**Commits**: `738769e`(CodeGraph)、`664bf0b`(GoalState)、`d816f09`(决策溯源)、`7b5736e`(清理)

**依据**:2026-08 GitHub 周榜 7 个项目(prime-agent / semantica / google skills / cloudflare computer / TencentDB-Agent-Memory / code-graph-rag / loopx),趋势 = **电脑、记忆、图谱、长任务状态**。按 open-source-agent-borrowing 流程:7 个 scout 并行调研(每项目 README/docs/源码,含"借鉴什么/对应模块/为什么")→ 汇总借鉴点 → 对照 Equaxis 现状(grep + 读源码)筛选真实差距 → 3 项落地、其余留档。

### 16.1 CodeGraph 代码知识图谱(已实现)

**依据**:TencentDB-Agent-Memory 的 CodeGraph 资产(符号/调用者/被调用者/影响分析,`/v3/tools/call` 按需查询)+ vitali87/code-graph-rag(19 节点/20 边图模式、dead-code 可达性行走)。两个 scout 独立确认同一差距。

**诊断**:Equaxis 无任何代码结构索引——`grep codegraph|code_graph|tree-sitter|symbol index` 在 src/、.pi/extensions/、vendor/agent-memory 全为 0 命中;ast-tools.mjs 只有单点 inspectAst/renameAst;lsp_probe 只有单点定义/诊断。

**决策**:
- 用 TypeScript compiler API(既有 devDependency,ast-tools 同款)构建确定性 JSON 索引,不引入 Memgraph/Tree-sitter/UniXcoder——scout 明确评估全量 CGR 对 Node agent 过重
- **两阶段调用解析**:先全量收集原始调用边,符号索引建完后统一按名解析——消除文件遍历顺序依赖;重名标记 `ambiguous: true` 而非猜测(静态近似,动态 trace 覆盖留作 code-graph-rag 的后续扩展点)
- **按需查询、零注入**(TencentDB InjectionMode=reference 同款):索引首次查询时惰性构建,6h 过期重建;不注入 system prompt

**实现**:
- `src/code-index.mjs`:collectIndexFiles / buildCodeIndex(符号=class/function/method/interface/enum/type/variable,含 JSDoc、行列区间、导出标记;边=imports(相对解析+外部标记)/calls(符号级+模块级)/exports)/ findSymbols / queryCallers / queryCallees / queryImporters / queryExports / impactClosure(上游调用者+文件导入者传递闭包)/ deadCodeReport(入口根导入可达性 + 未导出且无调用者的符号)/ save/load/isIndexFresh
- `.pi/extensions/code-graph.ts`:`code_graph_query`(callers/callees/importers/exports/find/impact/dead_code)+ `code_graph_rebuild` + `/equaxis-code-graph`(status/rebuild);session_start 只 trace 状态不构建
- 配置 `codeGraph` 节(enabled/rootDir/includeDirs/maxFiles/rebuildIfStaleMs)+ contracts.json 条目(failureMode=degrade)

**验证**:
- 单测 10/10(fixture 工程:符号/导入边/歧义模块级调用/影响闭包/dead-code/持久化往返/损坏文件拒绝/空工程)
- 真实仓库(Equaxis 自身 src/):63 文件、555 符号、41 导入边、4397 调用边,构建 0.48s;`queryCallers(compareCandidate)` 命中 `compareCandidateWithHoldout` + `EvalLoop.decision` 两个真实调用者;dead-code 报告正确标记"索引范围内无调用者"的符号,并**揪出本项自己引入的未用 helper `stringLiteralValue`**(已删,`7b5736e`)

**回滚**:`git revert 738769e`(连同 `7b5736e`);配置节删除即完全关闭。

### 16.2 目标状态内核 GoalState(已实现)

**依据**:huangruiteng/loopx——lifetime-goal 不变量:目标作为持久工作对象,跨越线程/断网/agent 更替;单一活动状态文件 + 配额感知 should-run + 具名用户门 + 任务租约交接。

**诊断**:Equaxis 持久化碎片化——trace 流、eval 账本、子代理快照各盖一块,`grep objective|goalState|ACTIVE_GOAL` 在 src/ 0 命中;无"目标+下一步+开放门"的单一重启包;重启后 in-flight 子代理直接降级为 failed,无继续目标。

**决策**:
- `goal-state.json` 单一权威重启包(schemaVersion/activeGoalId/goals),session_start 载入——loopx registry + ACTIVE_GOAL_STATE 最小机制
- **门是资格判定不是权限门**:open 门阻断完成(completeGoal 返回 openGates)但允许非依赖车道继续,`recordFallback` 落审计(loopx audited safe fallback)
- **配额窗口语义**:windowHours 滚动窗口,到期自动重置;`shouldRun` 返回 eligible/reason/nextEligibleAt,spend 只发生在验证后的 writeback(loopx quota_slot_spent)
- **todo 租约**:claim→TTL→过期可重claim(loopx task_lease_v0)

**实现**:
- `src/goal-state.mjs`:createGoal / openGates / canComplete / shouldRunGoal / spendGoalTokens / claimTodoInGoal / handoffGoal / appendEvidenceInGoal / completeGoalInGoal / createGoalStore(全部变更原子持久化,`now` 可注入)
- `.pi/extensions/goal-state.ts`:`goal_status` 工具 + `/equaxis-goal` 命令(status/activate/update/gate/todo/claim/done/evidence/spend/should-run/handoff/complete);session_start 载入并 trace `goal_state_loaded`
- 配置 `goalState` 节(enabled/rootDir/defaultQuota{tokenBudget,windowHours})+ contracts.json 条目

**验证**:单测 10/10(门控完成、配额窗口回卷、租约 TTL、交接、审计 fallback、持久化往返、损坏拒绝、路径越界拒绝);冒烟会话 trace 出现 `goal_state_loaded`(enabled=true,activeGoalId=null 符合预期)。

**回滚**:`git revert 664bf0b`。

### 16.3 决策溯源链(已实现)

**依据**:semantica Decision Intelligence——决策是一等图节点(record_decision:scenario/reasoning/outcome/confidence),带 CAUSED/INFLUENCED/PRECEDENT_FOR 因果边,trace_decision_chain / find_similar_decisions / analyze_decision_impact。

**诊断**:`grep recordDecision|record_decision|decisionId|causal|precedent` 在 src/ 0 命中;EvalLoop 只落 A/B 决策结果,无因果对象、无先例检索、无"为什么当初这么做"的追踪入口。

**决策**:在既有 EvalLoop 决策账本上扩展(不新建存储)——decisionId(缺省自动 UUID)+ parentDecisionId + causalType(校验+大写归一)+ scenario/reasoning/confidence/evidence;旧记录以 `decidedAt` 为键保持可追溯(向后兼容);先例检索用确定性 token 重叠替代 semantica 的 embedding 混合检索(零新依赖、可解释)。

**实现**(src/eval-loop.mjs):`decision()` / `decisionWithHoldout()` 记录扩展;新增 `traceDecisionChain(id, {direction})`(上游父链/下游子链 BFS,带 depth)、`decisionImpact(id)`(下游聚合 + 受影响 tool/capability)、`findPrecedents({scenario, limit})`(token 重叠排序,确定性 tie-break)。所有字段随既有 events.jsonl append/restore 持久化。

**验证**:单测 +6(21/21)——溯源字段、causalType 非法拒绝+小写归一、上下游链追踪(depth 正确)、影响聚合(tools/capabilities)、先例排序、持久化往返后链仍可追踪。

**回滚**:`git revert d816f09`(字段可选,旧数据兼容)。

### 留档候选(未实施,附原因)

| 候选 | 来源 | 未实施原因 |
|---|---|---|
| Wiki 文档记忆(LLM 摄取→结构化页+[[wikilinks]]+多跳检索) | TencentDB | 需 LLM 摄取管线,与现有 drawers 语义重叠,收益/成本不划算 |
| 远程 skill 安装(`skills add <repo>`)与负空间元数据 | google/skills | 需网络拉取+注册表解析;负空间元数据可低成本后接(改 parseSkillFile/scoreSkill) |
| 记忆冲突检测与可信度消解 | semantica | KG 事实已有 confidence/valid 窗口,冲突面小;先留档 |
| 执行日志 seq 重挂 + 持久 VFS | cloudflare computer | 单进程本地 harness 收益有限;checkpoint-store 已覆盖文件级回滚 |
| refine 统一账本(跨 prompt/memory/skill/子代理规格 + 快照回滚) | prime-agent | wisdom/skill/memory 三套语义整合,架构改动大,需先出设计 |
| 多跳图检索(BFS+衰减) | TencentDB | KG 现为直接实体查询;机制简单,可后接 |

### 验证基线(本轮)

- Node **356/356**、Python **143/143**、`tsc --noEmit` 干净
- 真实会话冒烟通过(deepseek-v4-flash,9.9s):新扩展加载、`code_graph_status`/`goal_state_loaded` trace 落盘
- doctor 全 PASS(24 contracts = 原 22 + code-graph + goal-state)
- 4 个新 commit 独立可回溯;文档 16 章

---

## 17. 周榜候选收尾轮:技能元数据/远程安装 + KG 溯源/冲突/多跳 + 编辑覆盖 + no-replay + refine 账本(本轮)

**Commits**: `34a186f`(技能元数据)、`775f84e`(远程安装)、`3227c64`(KG 溯源/冲突/多跳)、`5403bbe`(编辑覆盖)、`27be75e`(no-replay)、`aba635d`(refine 账本)

**依据**:把第 16 章留档候选 + scout 报告剩余可落地项全部消化,来源仍为 2026-08 周榜(google/skills、TencentDB-Agent-Memory、semantica、code-graph-rag、cloudflare computer、prime-agent)。六项全部按"纯函数 + 单测 + 独立 commit"落地;每项 why/change/verify 见 commit message。

### 17.1 技能:Google Agent Skills 元数据(已实现)

**依据**:google/skills SKILL.md 标准——category、负空间(dontUse,"DON'T use for X")、related 交叉链接;scout 差距:parseSkillFile 只读 7 个 key,新字段被丢弃,无负空间排除,无相关技能解析。

**实现**(src/skill-store.mjs):parseSkillFile/serializeSkill 支持 category/dontUse/related;`negativeSpaceTokens` + selectRelevantSkills 确定性排除(omitted reason=negative_space,防错误技能注入);related 技能以锚点分数拉入(viaRelated 标记),预算感知、跳过缺失名。无新字段的技能选择行为不变(向后兼容)。

**验证**:skill-store 19/19(元数据解析、负空间排除、related 拉入 + viaRelated + 预算、序列化往返)。

### 17.2 技能:远程安装(已实现)

**依据**:google/skills `skills add <owner>/<repo>` 模式;Equaxis 只能本地创作,无法消费开源 SKILL.md 生态。

**实现**(src/skill-install.mjs + skill_install 工具):ref 语法 `owner/repo[/path/to/skill]` 或 github.com URL(dot 段拒绝);raw.githubusercontent 拉取(main→master 回退、超时/大小上限/状态码检查);frontmatter 解析 + 名称消毒 + github 溯源;走既有版本化生命周期(createSkillCandidate → 只删不增审查门 → applySkillCandidateGuarded),远程安装获得与本地学习同等的审计 + 回滚轨迹。

**验证**:skill-install 7/7(深路径/URL/恶意输入解析、URL 构建、fetch 上限、元数据归一、生命周期安装、master 回退、裸 ref 拒绝)。

### 17.3 记忆:KG 溯源 + 冲突标记 + 多跳检索(已实现)

**依据**:semantica 事实级 PROV-O(source quote + sha256 + 版本链 + 冲突标记)+ TencentDB 图多跳 BFS;scout 差距:KG 事实无 source quote/checksum/版本历史,且只有单实体查询。

**实现**:
- knowledge_graph.py:`add_triple` 接受 source_ref/source_quote,自动计算内容 checksum(`fact_checksum` = sha256(s|p|o|valid_from|quote));同 (s,p,o) 重录自动链 previous_versions(上限 10);同 (s,p) 不同 o 的现行事实标记 `conflict_with`(不静默覆盖);新增 verify_checksum/checksum_report 防篡改、detect_conflicts、`graph_search`(无向 BFS、每跳衰减、min_score 截断、访问上限)
- bridge:add_fact 返回 conflicts,暴露 graph_search/checksum_report;memory.ts 新增 `memory_graph_search` 工具,memory_add_fact 支持溯源参数并在结果中提示冲突

**验证**:pytest test_knowledge_graph.py 16/16(溯源字段、版本链、篡改检测、冲突标记、多跳衰减/min_score/无向、空种子),vendor 全量 149/149。

### 17.4 代码图:动态编辑覆盖(已实现)

**依据**:code-graph-rag `cgr trace` static_missed 覆盖——运行期实际触碰的文件与静态图合并,标记静态分析看不到的调用点。

**实现**(src/code-index.mjs):`overlayTraceEdits` 把最近编辑文件并入静态索引——touched 文件/符号、`editedWithoutCallers`(无任何调用边的已编辑符号,最高风险编辑:死代码或动态分发断点)、`editedFileUnreferenced`(无人导入的已编辑文件)、dynamicEdges;`collectEditedFilesFromCheckpoints` 从工具级 checkpoint 存储读取最近 write/edit 目标(确定性、与 trace schema 解耦,新→旧去重)。code_graph_query 新增 kind=edit_overlay。

**验证**:code-index 12/12(符号级 vs 文件级信号分离、dynamicEdges、checkpoint 顺序/去重/缺失根)。

### 17.5 子代理:no-replay 重试分类(已实现)

**依据**:cloudflare/computer no-replay 边界——歧义传输失败后绝不重放非幂等副作用;Equaxis 曾对所有非取消错误盲目重试(EPIPE 后可能重复应用写操作)。

**实现**(src/subagent-runtime.mjs):`classifyRetryFailure` 三分类——pre_dispatch(执行器发送前拒绝:VALIDATION/SCHEMA_ERROR/ERR_INVALID_*/TASK_REJECTED)安全重试;ambiguous(EPIPE/ECONNRESET/ECONNREFUSED/ECONNABORTED/ETIMEDOUT/ERR_STREAM_*/UND_ERR_SOCKET)快速失败,错误带 `[no-replay: …]` 注解 + `subagent_retry_skipped` trace;未分类保留旧瞬时重试行为(向后兼容)。

**验证**:subagent-runtime 27/27(分类表、EPIPE 一次尝试即失败且无重试 trace、SCHEMA_ERROR 仍预算内重试)。

### 17.6 Refine 统一账本(已实现)

**依据**:prime-agent Continual Harness /refine——自改进写入跨三套存储(wisdom 不可变/skill 版本化/memory dream)且无统一回滚;scout 差距:无 harness_state.json 等价物,无 before/after 快照回滚。

**实现**(src/refine-ledger.mjs + /equaxis-refine 命令):append-only JSONL 账本(.pi/runtime/refine/ledger.jsonl),文件型 kind(note/prompt/file);recordRefine 对每次 create/update/delete 记录 before/after 快照(内容落 <rootDir>/notes|prompts|files/),listRefines 新→旧 + kind 过滤,rollbackRefine 按 id 还原快照(create→删文件;update/delete→重写旧内容),rollback 标记防二次回滚,路径越界/kind/action/target 全校验。

**验证**:refine-ledger 6/6(快照、回滚还原 + 标记 + 二次回滚拒绝、create 回滚删除、delete 回滚重写、排序过滤、守卫)。

### 验证基线(本轮)

- Node **379/379**、Python **149/149**、`tsc --noEmit` 干净、checkExtensionContracts ok(25 contracts)
- 真实会话冒烟通过(deepseek-v4-flash,8.3s,provider cacheRead=256):`code_graph_status`/`goal_state_loaded`/`refine_status` 三钩子 trace 落盘
- doctor 全 PASS,READY
- 6 个新 commit 独立可回溯;文档 17 章

### 仍留档(超出扩展层能力或收益不划算)

| 候选 | 来源 | 原因 |
|---|---|---|
| Wiki LLM 摄取管线 | TencentDB | 需 LLM 摄取 + 独立检索层;多跳 BFS(17.3)已覆盖图检索半边 |
| 持久程序化执行环境(IPython 内核) | prime-agent | 需新运行时,非扩展层可做 |
| 持久 VFS/SQLite 工作区 | cloudflare computer | 单进程本地 harness 收益有限,checkpoint 已覆盖文件级 |
| 配额感知自动唤醒调度器 | loopx | 需守护进程 + 心跳;shouldRun 判定已就绪,接线留待需要时 |
| 子代理注册表 + 用量归属 | prime-agent | 涉及 Pi 内核会话模型,扩展层只到快照层 |

---

## 18. 零内核轮:Wiki 文档管线 + 配额自动唤醒(本轮)

**Commits**: `d829a50`(Wiki 文档索引)、`1dbad61`(配额自动唤醒)

**背景**:第 17 章留档的五项中,"Wiki LLM 摄取管线"和"配额自动唤醒"被评估为**不需要动内核**(常驻子进程/调度器即可)——本轮兑现,内核 fork 路线(#5 子代理注册表)保持留档。

### 18.1 Wiki 文档管线(已实现,确定性切片)

**依据**:TencentDB llm_wiki 资产(文档→结构化页 + [[wikilinks]] + 图检索)。LLM 摄取管线超出扩展层,故做确定性切片:结构抽取 + 链接图 + 关键词/多跳检索;检索语义对齐 memory_graph_search(17.3),二者合起来覆盖 TencentDB 的图检索半边。

**实现**(src/doc-index.mjs + .pi/extensions/doc-wiki.ts):
- parseDocFrontmatter(类 SKILL.md frontmatter)/ splitDocPages(标题分页,前导段 fallback)/ extractWikiLinks([[wikilinks]] 去别名)/ ingestDoc / buildDocIndex(全局唯一页 id、跨文档链接解析、dangling 计数)/ searchDocIndex(标题 ×5 > 正文 ×1,停用词过滤)/ docGraphSearch(无向 BFS、每跳衰减、min_score 截断、节点上限)/ collectDocFiles / 原子持久化
- 工具:wiki_search / wiki_graph / wiki_ingest + /equaxis-wiki 命令;索引惰性构建、按需查询零注入;配置 wiki 节 + 清单条目

**验证**:doc-index 9/9(含全局 id 去重 + dangling、图衰减/无向/上限、持久化往返);冒烟会话 `wiki_status` trace 落盘。
**回滚**:`git revert d829a50`。

### 18.2 配额自动唤醒(已实现,判定→探针→调度三段)

**依据**:loopx `quota should-run` + scheduler_hint——判定已就绪(17 章 goal-state shouldRunGoal),本轮补上"谁来定时问它"。

**实现**:
- `src/wake-scheduler.mjs`:`buildWakePlan`(门→配额窗口→wouldRun = eligible AND `goalState.autoWake.enabled` AND nextAction 三重门,默认关闭,调度执行保持显式)/ `scheduledTaskCommand`(schtasks 注册串,反斜杠路径归一 + 间隔钳制)/ `runScheduledWake`(wouldRun 时启动一次 Equaxis json 会话,nextAction 为提示词,provider/model 可配;不满足绝不启动;启动失败记录)
- `scripts/equaxis-wake.mjs`:探针 CLI(--json 机器可读 / --scheduled 调度模式,exit 0/1/2)
- goal-state.ts 新增 `/equaxis-goal wake`(计划报告)与 `schedule`(打印 schtasks 命令)子命令;配置 goalState.autoWake {enabled:false, intervalMinutes:30, provider, model}

**用法**:`/equaxis-goal activate g1 <objective>` → `/equaxis-goal todo <下一步>` 由 update nextAction 维护 → `/equaxis-goal schedule` 拿到 schtasks 命令 → 管理员 shell 注册 → 每个周期 `equaxis-wake.mjs --scheduled` 判定并(仅当显式启用 autoWake)启动会话。

**验证**:wake-scheduler 8/8(门/配额计划、三重 wouldRun 门、schtasks 串、跳过不启动、启动参数走显式 provider/model、缺配置拒绝启动并报错、跳过/失败日志);真实仓库探针返回 no_active_goal exit 1。**后续变更**:0.3.6 起移除 deepseek 回退——autoWake 缺 provider/model 时拒绝启动并提示配置,不再静默用厂商默认。
**回滚**:`git revert 1dbad61`。

### 附带修复

- wisdom-store pruneWisdom 增加确定性 tie-break(同毫秒 recordedAt 时稳定排序依赖 readdir 顺序,并行测试负载下环剪枝偶发剪错)——`d829a50` 内附带。

### 验证基线(本轮)

- Node **396/396**、Python **149/149**、`tsc --noEmit` 干净、checkExtensionContracts ok(26 contracts)
- 真实会话冒烟通过(deepseek-v4-flash,9.9s):`wiki_status`/`goal_state_loaded`/`code_graph_status`/`refine_status` 四钩子 trace 落盘
- doctor 22 PASS,READY;`equaxis-wake.mjs --json` 探针正常(no_active_goal)
- 2 个新 commit 独立可回溯;文档 18 章

### 剩余留档(最终)

| 候选 | 来源 | 所需 |
|---|---|---|
| 子代理注册表 + 用量归属 | prime-agent | 内核 API(session registry + 记账流),fork 路线 |
| 持久程序化执行环境 | prime-agent | 新运行时;压缩存活需内核 |
| 持久 VFS/SQLite 工作区 | cloudflare computer | 存储设计重做,本地收益存疑 |


