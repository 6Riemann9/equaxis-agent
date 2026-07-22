# Equaxis 模型 Provider

## 当前配置

Equaxis 通过 Pi Provider Extension 注册 `openai-inprior/gpt-5.5`：

```text
Pi openai-responses client
        │ Authorization: Bearer <local credential>
        ▼
https://api.inprior.com/responses
        │
        ▼
gpt-5.5 · xhigh · 1M context
```

模型配置是可提交的 `.pi/extensions/provider.ts`，凭据不在 Provider 源码中。

## 凭据

读取顺序：

1. 当前进程的 `OPENAI_API_KEY` 环境变量；
2. `.equaxis/credentials/openai.key` 本地文件。

`scripts/read-provider-key.mjs` 只把凭据写到标准输出供 Pi 的 Provider resolver 捕获，不写入 Harness Trace。`.equaxis/` 已在 `.gitignore` 中。

设置本地文件时，只保存 Key 本身，不要加入 JSON、引号或变量名。

## 参数映射

| 输入配置 | Pi/Equaxis 配置 |
|---|---|
| `model_provider = "OpenAI"` | Provider ID `openai-inprior` |
| `model = "gpt-5.5"` | `defaultModel: "gpt-5.5"` |
| `review_model = "gpt-5.5"` | Pi 没有独立 review 槽位，统一使用当前模型 |
| `model_reasoning_effort = "xhigh"` | `defaultThinkingLevel: "xhigh"` |
| `wire_api = "responses"` | `api: "openai-responses"` |
| `disable_response_storage = true` | OpenAI Responses 请求发送 `store: false` |
| `model_context_window = 1000000` | `contextWindow: 1_000_000` |
| `model_auto_compact_token_limit = 900000` | `reserveTokens: 100_000` |
| `network_access = "enabled"` | Pi 保持网络可用，危险命令仍受 Harness 控制 |
| `windows_wsl_setup_acknowledged` | Pi 原生 Windows 运行，不需要对应字段 |

## 离线注册验证

下面的命令只验证模型注册，不发起推理：

```powershell
npm run equaxis -- --approve --offline --list-models gpt-5.5
```

预期显示 `openai-inprior / gpt-5.5 / 1M / 100K / thinking yes`。
