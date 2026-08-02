# Equaxis Evaluation System Architecture

本文档描述 Equaxis 通用评测系统的逻辑和架构。它不是一个只为 Harbor 写死的脚本，而是一套可以接入 Harbor、Pi runtime trace、未来 Codex/Claude Code harness trace 的离线评测核心。

核心原则是：

- 运行时只负责产生事实：任务结果、工具调用、错误、耗时、token、cost、trace。
- Adapter 只负责把不同来源的数据归一成 `EvaluationRecord`。
- Evaluation Core 只做确定性分析：诊断、假设、实验对比、部署决策。
- LLM 只解释报告和建议下一轮实验，不能覆盖确定性部署决策。

## Layered Design

```text
Pi Extension / Reliability Harness
  -> records tool events, validation failures, guardrail decisions, latency, traces

Harbor Adapter
  -> reads result.json, verifier rewards, exception_info, Equaxis harness trace
  -> converts them into EvaluationRecord

Evaluation Core
  -> diagnosis
  -> capability matrix
  -> layered hypotheses
  -> A/B experiment analysis
  -> deterministic deploy/scoped/reject decisions

Reports / Optional LLM Analysis
  -> JSON report
  -> Markdown report
  -> hypotheses.json
  -> bounded LLM analysis prompt
```

代码上对应为：

| Layer | Files | Responsibility |
|---|---|---|
| Harbor adapter facade | `harbor_eval/evaluation_cycle.py` | 保留旧 import 路径，转发到通用核心 |
| CLI | `harbor_eval/cycle.py` | 解析命令、manifest、输出路径、可选 LLM 调用 |
| Taxonomy | `harbor_eval/capabilities.json` | 定义 task area、capability tags、expected success rate |
| Core API | `src/evaluation/__init__.py` | 对外暴露通用评测入口 |
| Schema | `src/evaluation/schema.py` | `EvaluationRecord` 语义、默认 policy、基础设施失败码 |
| Normalization | `src/evaluation/normalize.py` | 将 runner-specific 数据转换为统一记录 |
| Diagnosis | `src/evaluation/diagnose.py` | 逐任务表格、能力矩阵、失败区域 |
| Hypotheses | `src/evaluation/hypotheses.py` | 表层/中层/深层改进假设 |
| Experiments | `src/evaluation/experiments.py` | baseline/candidate 对照、能力维度副作用 |
| Decisions | `src/evaluation/decisions.py` | 确定性部署决策 |
| Reports | `src/evaluation/reports.py` | Markdown/JSON 报告和 LLM prompt |

## Data Contract

所有 runner 最终都应输出统一的 `EvaluationRecord`。这是评测核心唯一关心的数据形状。

关键字段包括：

| Field | Meaning |
|---|---|
| `taskId` | 任务 ID |
| `trialId` | 单次试验 ID |
| `attempt` | 第几次尝试 |
| `variant` | baseline 或 candidate 名称 |
| `taskArea` | 任务区域，例如 code-editing、repository-navigation |
| `capabilityTags` | 能力标签，例如 input-validation、tool-selection |
| `expectedSuccessRate` | 该任务期望成功率 |
| `success` | 是否通过 verifier 且无 safety violation |
| `score` | verifier reward |
| `failureCode` | 归一后的失败类型 |
| `safetyViolation` | 是否触发安全失败 |
| `latencyMs` | 本次任务耗时 |
| `costUsd` | 成本 |
| `inputTokens/outputTokens/totalTokens` | token 用量 |
| `trace` | Harness/runtime 摘要，例如工具错误、参数校验失败、策略拦截 |
| `resultPath` | 原始结果位置，便于追溯 |

这层 contract 的意义是：Harbor、Pi Extension、其他 agent harness 不需要共享内部实现，只要能产出 `EvaluationRecord`，就能复用同一套诊断和决策系统。

## Harbor Normalization

当前 Harbor adapter 读取以下来源：

- `result.json`
- `verifier_result.rewards`
- `exception_info`
- `agent_result.n_input_tokens`
- `agent_result.n_output_tokens`
- `agent_execution.started_at`
- `agent_execution.finished_at`
- `agent/equaxis-harness-traces.jsonl`

然后做几类归一：

- reward 大于等于 1 且没有 safety violation，记为成功。
- verifier 没有 reward，记为 `VERIFIER_RESULT_MISSING`。
- `exception_info` 中包含 network、setup、timeout、verifier 等特征时，转成稳定失败码。
- trace 中有 `tool_result.isError`，倾向归因为 `TOOL_EXECUTION_FAILURE`。
- trace 中有 `tool_validation_failed` 且 repair exhausted，归因为 `TOOL_ARGUMENT_REPAIR_EXHAUSTED`。
- trace 中有 `tool_blocked`，归因为 `POLICY_BLOCKED_TASK`。

## Infrastructure Isolation

评测系统刻意把基础设施失败从能力诊断里隔离出来。

基础设施失败码包括：

- `AGENT_SETUP_NETWORK_FAILED`
- `AGENT_SETUP_FAILED`
- `VERIFIER_ERROR`
- `VERIFIER_RESULT_MISSING`

这些失败仍会进入总报告和部署 guardrail，但不会污染能力矩阵。原因是：网络安装失败、verifier 缺失、环境启动失败，并不能说明 agent 的 tool-selection、input-validation 或 editing 能力差。

因此报告里同时有两套指标：

- `overall`：包含所有 attempts 的原始观察结果。
- `taskQuality`：排除基础设施失败后的任务质量结果。

能力矩阵、弱能力识别、失败区域分析主要基于 `taskQuality`。

## Diagnosis Logic

诊断阶段对应用户提出的第一步：交叉分析逐任务表格和能力标签矩阵。

它生成四块核心证据：

1. `taskTable`

   按 `taskId` 聚合，输出 attempts、success rate、expected success rate、gap、failure codes、capability tags。

2. `capabilityMatrix`

   按能力标签聚合，计算每个 capability 的成功率、期望成功率、差距，并按 task area 展开。

3. `weakCapabilities`

   满足以下条件的能力会被标记为弱能力：

   - 样本数大于等于 `diagnostic_minimum_samples`
   - `expectedSuccessRate - successRate` 大于等于 `weak_capability_gap`

4. `failureRegions`

   按 `taskArea` 聚合失败，找出失败集中区域和主要 failure codes。

这一步的目标不是直接给修复方案，而是把“某些任务失败”映射到“哪些能力缺陷最可能导致了这些失败”。

## Hypothesis Logic

假设构建阶段对应用户提出的第二步：表层 -> 中层 -> 深层。

系统会优先对 `weakCapabilities` 生成假设；如果没有明显弱能力，则从仍有失败的 capability 中挑选候选。

每个假设包含：

- `id`
- `layer`
- `phase`
- `capabilityTags`
- `taskAreas`
- `evidence`
- `proposedChange`
- `expectedUplift`
- `targetSuccessRate`
- `validationMethod`
- `guardrails`

分层规则由 failure code 推断：

| Layer | Typical Evidence | Proposed Change |
|---|---|---|
| surface | prompt、instruction、tool description、argument/schema 问题 | 优化提示词、工具描述、参数指导 |
| middle | input、parse、retrieval、context、pipeline、planning、tool execution 问题 | 修改输入/上下文管道，或切换 reasoning mode |
| deep | 其他更根部的能力问题 | scoped model、planner、harness-core 级改动 |

`expectedUplift` 根据 gap 自动估算，并受 policy 限制：

- 不低于 `target_uplift_floor`
- 不高于 `target_uplift_ceiling`
- 默认取 gap 的一半作为合理改进目标

## Experiment Logic

实验阶段对应用户提出的第三步：分阶段对照实验。

一个实验需要：

- baseline records
- candidate records
- hypothesis
- experiment name
- policy

系统会计算：

- 目标 capability/task area 上的成功率提升
- latency change rate
- token change rate
- cost change rate
- safety violation change
- infrastructure failure change
- unrelated capability regressions
- failure code 的数量变化
- task area 维度变化

重点是：实验不是只看总成功率。它会检查“目标能力有没有变好”，也会检查“无关能力有没有变差”。

这可以避免一种常见误判：某个 prompt 改动让目标任务多过了几题，但同时拖慢整体、增加 token、破坏另一个能力标签。这种情况不会被简单地判为 deploy。

## Decision Logic

部署决策对应用户提出的第四步：按成本收益比决策，而不是采用所有有效改进。

决策只由确定性规则产生，可能值为：

| Decision | Meaning |
|---|---|
| `deploy` | 达到目标提升，且没有超过副作用 guardrails |
| `scoped` | 有实用提升，但存在成本、副作用或适用范围限制，只建议限定场景使用 |
| `reject` | 没达到最低实用提升 |
| `insufficient_data` | baseline 或 candidate 样本数不足 |

默认 guardrails 包括：

- `regression_tolerance`
- `max_latency_increase_rate`
- `max_token_increase_rate`
- `max_cost_increase_rate`
- `max_safety_violation_increase`
- `max_infrastructure_failure_increase`

系统还会计算 `costBenefitScore`：

```text
observed uplift / (1 + latency overhead + token overhead + cost overhead)
```

这个分数用于帮助排序有效改进，而不是替代 guardrails。

## Iteration Loop

完整闭环如下：

```text
Run Harbor / collect runtime traces
  -> normalize to EvaluationRecord
  -> diagnose tasks, capabilities and failure regions
  -> build layered hypotheses
  -> run baseline/candidate experiments
  -> decide deploy/scoped/reject/insufficient_data
  -> render reports
  -> optional LLM explanation
  -> next cycle starts from changed failure patterns
```

每一轮结束后，报告里的 `nextIterationFocus` 会列出下一轮最值得关注的任务区域和 leading failure codes。

## LLM Role

LLM 分析是可选的，必须显式加 `--llm` 才会调用。

LLM 输入不是完整 trace，而是一个受限 evidence package：

- cycle ID
- overall/taskQuality/infrastructure 指标
- weak capabilities
- failure regions
- hypotheses
- experiments
- deterministic decisions

LLM 的职责是：

- 解释失败模式变化。
- 帮助提出下一轮实验。
- 用自然语言总结 trade-off。

LLM 不能：

- 修改 success rate。
- 改写 failure code。
- 覆盖 `deploy/scoped/reject/insufficient_data`。
- 替代 deterministic guardrails。

## Runtime Extension Boundary

评测系统不要求每次都加新 Pi Extension。现有 `reliability-harness.ts` 已经记录了大量可用 trace。

未来如果要加轻量 telemetry extension，它只应该负责：

- 监听 `tool_call`
- 监听 `tool_result`
- 监听 `turn_start`
- 监听 `turn_end`
- 监听 `agent_end`
- 写入 runtime events JSONL

它不应该负责：

- 计算能力矩阵。
- 生成假设。
- 调用 LLM。
- 做部署决策。
- 读取 Harbor jobs。

也就是说，Extension 是事实采集层，不是评测大脑。

## Commands

诊断一个 Harbor baseline：

```powershell
npm run eval:cycle -- diagnose `
  --job harbor_eval/jobs/equaxis `
  --taxonomy harbor_eval/capabilities.json `
  --output-dir harbor_eval/reports/cycle-001 `
  --cycle-id cycle-001
```

用 manifest 分析 baseline/candidate：

```powershell
npm run eval:cycle -- cycle `
  --manifest harbor_eval/cycle-002.json `
  --output-dir harbor_eval/reports/cycle-002
```

显式请求 LLM 解释：

```powershell
npm run eval:cycle -- cycle `
  --manifest harbor_eval/cycle-002.json `
  --output-dir harbor_eval/reports/cycle-002 `
  --llm
```

本地验证：

```powershell
npm run test:eval
npm run check
npm test
```

## Design Summary

这套系统的核心不是“跑一次 benchmark 得一个分数”，而是把评测变成可迭代的工程流程：

- 从任务失败定位能力缺陷。
- 从能力缺陷生成分层改进假设。
- 用对照实验验证假设。
- 用副作用 guardrails 做部署决策。
- 用新报告驱动下一轮实验。

Harbor 当前只是第一个输入源。只要其他 agent runtime 能输出统一的 `EvaluationRecord`，它们就可以进入同一个评测闭环。
