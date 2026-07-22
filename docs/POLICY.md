# Harness 策略说明

策略配置在 `.pi/reliability.json`，分类逻辑在 `src/policy.mjs`。策略层不调用模型，因此同一输入会得到相同结论，便于测试和回归。

## 风险等级

| 等级 | 示例 | enforce 行为 |
|---|---|---|
| low | read、grep、find、ls、普通查询命令 | 直接执行并审计 |
| medium | 工作区文件修改、安装依赖、Git commit/push、容器命令 | 直接执行并审计 |
| high | 递归删除、`git reset --hard`、提权、磁盘操作、工作区外写入 | 有 UI 时单次审批；无 UI 时拒绝 |
| blocked | 受保护路径、疑似明文密钥 | 直接拒绝 |

“medium 直接执行”是当前演示策略的产品选择，不是固定真理。生产环境可按仓库、环境和身份把依赖安装或 Git push 提升为审批级别。

Memory 的 `memory_remember` 与 `memory_add_fact` 被归类为 medium，查询类工具是 low。所有 Memory 工具在风险分类前先做明文凭据检测；知识图谱中 `api_key`、`password`、`secret`、`token` 等敏感 predicate 也会触发硬阻断。

`web_crawl` 被归类为 medium，因为它会访问外部网络。抓取扩展自身还会拒绝非 HTTP/HTTPS、URL 内嵌凭据、localhost、内网、链路本地、保留地址和常见本地域名，并在每次重定向前重新检查目标地址。

## 默认保护项

- `.env`
- `.git/`
- `node_modules/`
- `*.pem`
- `*.key`

默认单轮最多 30 次工具调用、最多 3 次获准的高风险调用。

## HITL 语义

审批对“这一条已经完整展示参数的工具调用”有效，不是对某类命令永久放行。Harness 会记录：

- 请求审批的工具、理由和风险；
- 用户批准或拒绝；
- 执行后的成功/失败与延迟。

JSON 和 print 模式没有对话框能力，因此高风险请求默认拒绝。这比等待一个永远不会返回的确认更安全。

## audit 与 off

`audit` 只用于策略观测：普通受保护路径、high 或上限命中时记录 violation 但继续执行；疑似明文凭据仍会硬阻断，避免观测模式本身制造泄漏。`off` 则完全跳过 prompt 注入、工具分类与工具 Trace。

生产环境不应把 `audit` 当成保护模式；它适合用真实流量评估误报率，再切换到 `enforce`。

## 已知边界

- 当前 shell 策略基于规则匹配，不是完整 shell AST；编码、别名或间接脚本可能绕过字符串规则。
- 工作区边界会解析已有 symlink 和新文件最近存在父目录的 realpath，但这仍不等同于操作系统级文件沙箱。
- Pi 的 `!`/`!!` 是用户主动发起的 shell，不是 LLM `tool_call`，本 Harness 的 Agent 工具门禁不拦截它。
- 轻量 Eval 是运行指标，不等同于任务质量评测；生产版还应加入标注数据集、任务成功率和回归基线。

后续生产化演进方向包括：shell AST 与隔离执行、完整真实路径解析、身份化策略、OpenTelemetry 和离线 Eval 数据集。
