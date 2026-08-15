<div align="center">

<img src="assets/equaxis-pink-terminal-logo.svg" alt="Equaxis" width="420" />

# EQUAXIS · 衡枢

**被治理的 Agent 运行时 · The governed agent runtime**

</div>

> 🇨🇳 **衡枢 Equaxis** — 不重写 Pi:通过 Extension API 在 Pi 内核之上,加确定性护栏、受治理的记忆、代码知识图谱与诚实的评估闭环。
>
> 🇬🇧 **Equaxis** — doesn't rewrite [Pi](https://pi.dev/). It rides on `@earendil-works/pi-coding-agent` via the extension API, adding deterministic guardrails, governed memory, a code knowledge graph, and an honest evaluation loop.

![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/python-%3E%3D3.10-3776AB?logo=python&logoColor=white)
![Pi](https://img.shields.io/badge/pi-0.83.0-111111)
![CI](https://img.shields.io/github/actions/workflow/status/6Riemann9/equaxis-agent/verify.yml?branch=main&label=CI)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

```text
┌──────────────────────────────────────────────────────────────┐
│                        Pi Kernel 0.83                        │
│               models · sessions · TUI · tools                │
└──────────────────────────────┬───────────────────────────────┘
                               │  extension events
┌──────────────────────────────▼───────────────────────────────┐
│                      Equaxis Harness                         │
│            policy · audit · approvals · trace · validation   │
└───┬───────┬─────────┬──────────┬─────────┬────────┬──────────┘
    ▼       ▼         ▼          ▼         ▼        ▼
 Memory  CodeGraph  Subagents    Eval     Skills  GoalState  Pi-Web
 Chroma   symbols     DAG      holdout   SKILL.md   quota   dashboards
  + KG    / calls   no-replay    gates   + refine  + wake    + traces
```

## 能力矩阵

| 领域 | 亮点 |
|---|---|
| 🛡️ **治理** | 确定性风险分级、敏感路径保护、人工审批、L1 审计轨迹、双审门禁 |
| 🧠 **记忆** | 记忆宫殿抽屉、Dream 整合、带**溯源 + 防篡改校验**的知识图谱事实、多跳图检索、Wiki 文档索引 |
| 🗺️ **CodeGraph** | TS 编译器构建符号/导入/调用索引——调用者、影响面、死代码、编辑覆盖 |
| 🤖 **子代理** | DAG 调度、按模型并发分桶、机器可检查证据、**no-replay 重试**策略 |
| 🎯 **评估** | holdout 双集接受门、能力×版本交叉矩阵、**决策溯源链** |
| 📚 **技能** | SKILL.md 生命周期、负空间路由、GitHub 远程安装、可回滚 refine 账本 |
| 🎯 **长任务** | 持久目标状态、token 配额、门控、租约、交接、定时自动唤醒 |
| 📡 **可观测** | JSONL trace、provider 前缀缓存稳定性、pi-web 实时仪表盘 |

## 快速开始

```powershell
git clone https://github.com/6Riemann9/equaxis-agent.git
cd equaxis-agent
npm run setup          # 工具链检查 + 安装 + doctor
$env:OPENAI_API_KEY = "<your-key>"
npm run equaxis -- --approve   # 仅首次
```

`npm run verify:full` = TypeScript 检查 + Node 测试 + 记忆 + 评估套件。

## 指挥台

| 命令 / 工具 | 作用 |
|---|---|
| `/equaxis` · `/equaxis-mode enforce\|audit\|off` | 治理状态、切换策略模式 |
| `/memory` · `recall` · `memory_graph_search` | 记忆状态、语义召回、图谱检索 |
| `/equaxis-code-graph` · `code_graph_query` | 代码索引状态、调用者/影响面/死代码查询 |
| `/equaxis-goal status\|wake\|schedule` | 持久目标、配额探针、Windows 自动唤醒 |
| `/equaxis-wiki search\|graph\|ingest` | 文档索引、wikilink 图谱、重建 |
| `/equaxis-refine list\|record\|rollback` | 自改进账本,可撤销 |
| `/skills` · `skill_install` | 本地 + GitHub 远程技能 |
| `/equaxis-checkpoint restore <id>` | 回滚工具写入,免后悔药 |

## 安全

- 模型提议、确定性策略裁决——高风险调用被拦截或转人工,绝不交给模型自我判断。
- 凭据永不进记忆;trace 只留本地;write/edit 正文不进 trace 流。
- 审计记录只标记问题、不阻断执行——观察面与执行面分离。

Equaxis 是围绕 Pi 的工程 harness,**不是** OS 级沙箱。

## 文档

[架构](docs/ARCHITECTURE.md) · [策略](docs/POLICY.md) · [记忆](docs/MEMORY.md) · [评估](docs/EVALUATION_ARCHITECTURE.md) · [扩展互通](docs/EXTENSION_PACKAGING.md) · [English](README.md)

## 许可证

MIT
