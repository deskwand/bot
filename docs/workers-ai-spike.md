# Workers AI binding spike

日期：2026-11-04。账号为 Workers Free 计划，测试时临时部署了 `spike-workers-ai`，测完已删除。

## 方法

部署一个只带 `ai` binding 的 Worker，用 `env.AI.fetch()` 向候选路由 POST 一个 OpenAI chat.completions 请求：带一个 `get_time` 工具，提示词要求模型调用它。请求头带 `cf-aig-authorization: Bearer cloudflare-gateway-binding`。

本机跑不了这项测试：`wrangler dev --remote` 和带 remote AI binding 的 `wrangler dev` 都返回 Cloudflare `internal error`，连 `env.AI.run` 也一样。所以必须部署后测。

## 路由

| 路由 | 结果 |
|---|---|
| `https://workers-binding.ai/v1/chat/completions` | 405，提示 `@cloudflare/ai is deprecated` |
| `https://workers-binding.ai/ai/v1/chat/completions` | 405，同上 |
| `https://workers-binding.ai/ai-gateway/gateways/default/workers-ai/v1/chat/completions` | **可用**，流式和非流式都行 |
| `https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions`（模型名写成 `workers-ai/@cf/...`） | 可用 |

选定：`WORKERS_AI_BASE_URL = "https://workers-binding.ai/ai-gateway/gateways/default/workers-ai/v1"`。

`default` gateway 在这个账号上不需要手工创建就能用。没有在一个全新账号上复测过。

## 免费计划可用的模型

以下模型在 Workers Free 计划上返回 403，`internalCode` 为 5035，`not available on the Workers Free plan`：

- `@cf/zai-org/glm-5.3-flash`、`glm-5.2`、`glm-5.3`
- `@cf/deepseek-ai/deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`、`deepseek-v4.1-flash-1017`
- `@cf/moonshotai/kimi-k2.6`、`kimi-k2.7-code`

以下模型可用，并且流式、非流式都返回了 `finish_reason: "tool_calls"`，正确调用了 `get_time`：

- `@cf/google/gemma-4-26b-a4b-it`（**选为默认**：输入 $0.1/M、输出 $0.3/M，支持图片和推理，上下文 256K）
- `@cf/zai-org/glm-4.7-flash`、`@cf/qwen/qwen3.8-27b`、`@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/openai/gpt-oss-20b`、`@cf/openai/gpt-oss-120b`、`@cf/nvidia/nemotron-3-120b-a12b`
- `@cf/meta/llama-4-scout-17b-16e-instruct`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/mistralai/mistral-small-3.1-24b-instruct`、`@cf/ibm-granite/granite-4.0-h-micro`

推理模型会先在 SSE 里输出很长的思考内容，`tool_calls` 排在后面。判断工具调用时不能只看响应的开头。

## 错误格式

付费专属模型的实测响应（HTTP 403）：

```json
{"name":"AiError","internalCode":5035,"httpCode":403,"message":"AiError: Model @cf/zai-org/glm-5.3-flash is not available on the Workers Free plan: ...","description":"Model @cf/zai-org/glm-5.3-flash is not available on the Workers Free plan. Upgrade to access this model: https://dash.cloudflare.com/?to=/:account/workers/plans","requestId":"..."}
```

额度用尽没有实测，因为要先把当天的免费额度用完。按 Cloudflare 文档和上面的格式，预期响应形如 `{"name":"AiError","internalCode":4006,...,"message":"AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage."}`，HTTP 状态码为 429。识别时按 `internalCode` 匹配（4006 为额度用尽，5035 为需要付费计划），文本只作补充。

## 冒烟

（待 Task 7 补充。）
