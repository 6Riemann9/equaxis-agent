# Equaxis 模型 Provider

Equaxis 复用 Pi 的 Provider 系统，模型来源有三类：

1. **Pi 内置 Provider**（自带模型目录与价格）：`deepseek`、`openai`、`anthropic`、`google` 等。只要凭据可用，模型列表自动出现。
2. **Extension 注册 Provider**：`.pi/extensions/provider.ts` 通过 `pi.registerProvider()` 注册（如 `openai-inprior`）。
3. **`models.json` 自定义 Provider**：在 `.pi/models.json` 的 `providers` 里声明（代理、网关等）。

## DeepSeek（内置）

把 Key 写入 `.pi/auth.json`（或设置环境变量 `DEEPSEEK_API_KEY`）即可：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

`.pi/auth.json` 已在 `.gitignore` 中，不要提交。

可用模型（Pi 0.83.0 自带目录）：

| Provider | Model | Context | Max Out | Thinking |
|---|---|---|---|---|
| `deepseek` | `deepseek-v4-flash` | 1M | 384K | yes |
| `deepseek` | `deepseek-v4-pro` | 1M | 384K | yes |

验证注册（不发起推理）：

```powershell
npm run equaxis -- --approve --offline --list-models deepseek
```

## 启用与切换模型

`.pi/settings.json` 控制默认与可用范围：

- `defaultProvider` / `defaultModel`：CLI 默认模型（`scripts/equaxis.mjs` 读取这两个字段，不再硬编码）。
- `defaultThinkingLevel`：默认思考档位（`off` / `low` / `medium` / `high` / `xhigh` / `max`）。
- `enabledModels`：模型名单白名单。**不在名单里的模型不会出现在模型列表/切换中**。新增 Provider 时必须把它的模型加进来。

切换到 DeepSeek 示例：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "high",
  "enabledModels": [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro"
  ]
}
```

单次运行也可用 CLI 参数覆盖：`npm run equaxis -- --provider deepseek --model deepseek-v4-flash --thinking high`。

## 自定义 Provider（`models.json`）

```json
{
  "providers": {
    "my-gateway": {
      "api": "openai-completions",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "sk-...",
      "models": [{ "id": "model-a" }, { "id": "model-b" }]
    }
  }
}
```

注意：不要把 Key 直接写进会被提交的文件。优先用 `auth.json` 或环境变量；`models.json` 只放无凭据的声明。

## openai-inprior（Extension 注册）

`docs/PROVIDER.md` 历史内容保留如下：

模型配置是可提交的 `.pi/extensions/provider.ts`，凭据不在 Provider 源码中。

### 凭据

读取顺序：

1. 当前进程的 `OPENAI_API_KEY` 环境变量；
2. `.equaxis/credentials/openai.key` 本地文件。

`scripts/read-provider-key.mjs` 只把凭据写到标准输出供 Pi 的 Provider resolver 捕获，不写入 Harness Trace。`.equaxis/` 已在 `.gitignore` 中。

设置本地文件时，只保存 Key 本身，不要加入 JSON、引号或变量名。

### 参数映射

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

### 离线注册验证

```powershell
npm run equaxis -- --approve --offline --list-models gpt-5.5
```

预期显示 `openai-inprior / gpt-5.5 / 1M / 100K / thinking yes`。
