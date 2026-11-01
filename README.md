# Telegram 管家 Bot（Cloudflare Workers）

一个部署在 Cloudflare Workers 上的单人 Telegram 助手：管家负责对话、记忆、任务派发与通知，每个任务由独立的 Durable Object 执行，结果（含产物链接）统一由管家回传。

- 控制链路：`ButlerDO`（全局单实例，Pi agent + SQLite 业务表）
- 执行链路：`TaskDO`（每任务一个实例，工具调用、审批、崩溃恢复）
- 定时任务：通过 Agents SDK `Agent.schedule` 注册 cron（不使用 Cron Trigger），cron 按 **UTC** 解释
- 产物：写入 R2，通过 `${PUBLIC_BASE_URL}/a/<key>` 访问

## 前置条件

- Node.js 22.6+（推荐 Node 26；`npm run set-webhook` 使用 Node 原生 TypeScript 类型擦除）
- npm
- Cloudflare 账号，并已执行 `npx wrangler login`
- Telegram Bot Token（在 [@BotFather](https://t.me/BotFather) 创建 bot）
- Anthropic API Key
- Tavily API Key（联网搜索）
- 可选：MCP 服务器（在 `src/config.ts` 中配置）

## 1. 安装依赖

```bash
npm install
```

## 2. 创建 R2 存储桶

```bash
npx wrangler r2 bucket create my-artifacts
```

桶名需与 `wrangler.jsonc` 中 `r2_buckets[].bucket_name` 一致（默认 `my-artifacts`）。

## 3. 配置 secrets

生产环境通过 `wrangler secret put` 逐个写入（值不会进入仓库）：

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TAVILY_API_KEY
```

`TELEGRAM_WEBHOOK_SECRET` 是自定义的随机字符串，用于校验 Telegram 回调头 `X-Telegram-Bot-Api-Secret-Token`，可用下面命令生成：

```bash
openssl rand -hex 32
```

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars` 并填入同样的值（`.dev.vars` 已被 git 忽略）：

```bash
cp .dev.vars.example .dev.vars
```

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret | 模型调用（直接使用 provider key，不经 AI Gateway） |
| `TELEGRAM_BOT_TOKEN` | secret | BotFather 提供的 token |
| `TELEGRAM_WEBHOOK_SECRET` | secret | webhook 校验密钥（自定义随机串） |
| `TAVILY_API_KEY` | secret | Tavily 搜索 |
| `PUBLIC_BASE_URL` | var | 产物链接前缀，填部署后的公开地址 |

## 4. 填写个人配置

编辑 `src/config.ts`：

- `owner.telegramUserIds`：填入允许使用该 bot 的 Telegram 用户 ID（数字）。不在白名单内的消息会被忽略。
- `models`：按角色（`butler` / `task`）配置模型，默认 `claude-sonnet-5-5`。
- `mcpServers`：MCP 服务器列表；对需要人工确认的工具在 `requireApproval` 中列出工具名，触发时会先发 ✅/❌ 审批按钮。

编辑 `wrangler.jsonc` 的 `vars.PUBLIC_BASE_URL`，填入部署后的公开地址，例如 `https://bot.<your-subdomain>.workers.dev` 或自定义域名。产物链接依赖该值；如果还不确定地址，可以先部署一次拿到 URL，回填后再部署一次。

Telegram 用户 ID 可通过 [@userinfobot](https://t.me/userinfobot) 获取。

## 5. 部署

```bash
npm run deploy
```

部署完成后，用 Worker 的公开地址设置 Telegram webhook：

```bash
npm run set-webhook -- https://bot.<your-subdomain>.workers.dev
```

脚本会调用 Telegram `setWebhook`：

- `url = <publicUrl>/telegram/webhook`
- `secret_token = TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates = ["message", "callback_query"]`

token 与 secret 从环境变量读取，缺失时回退到 `.dev.vars`；脚本不会打印它们。

检查 webhook 状态可访问：

```bash
curl "https://api.telegram.org/bot<token>/getWebhookInfo"
```

## 本地开发

```bash
npm run dev                 # wrangler dev，默认 http://localhost:8787
cloudflared tunnel --url http://localhost:8787
```

Telegram 需要公网 HTTPS 地址，所以本地调试需用隧道地址执行 `npm run set-webhook -- https://<tunnel-host>`，并把 `.dev.vars` 中的 `PUBLIC_BASE_URL` 也填成隧道地址（否则产物链接不可用）。调试结束后记得切回生产地址。

## 测试

```bash
npm test             # vitest run（使用 wrangler.test.jsonc 与 tests/worker.ts）
npm run typecheck    # tsc --noEmit
```

测试专用的 `TestHarnessDO` 只在测试配置（`wrangler.test.jsonc` → `tests/worker.ts`）中注册，生产入口 `src/index.ts` 与 `wrangler.jsonc` 不包含它。

## 冒烟测试清单（首次部署后手动执行）

1. 发送闲聊消息，得到直接回复。
2. 发送「帮我调研 X」→ 收到「已开始任务 t1」以及带取消按钮的进度消息，进度消息随搜索过程更新。
3. 新任务进行中发送「t1 只看英文资料」→ 后续进度体现新方向。
4. 新任务进行中点击「取消」→ 进度消息变为已取消。
5. 配置一个带 `requireApproval` 的 MCP 工具并触发 → 收到 ✅/❌ 审批按钮；批准后工具执行，拒绝后 agent 改道；重复点击提示「已处理」。
6. 任务完成后收到管家汇报，以及可打开的产物链接（`${PUBLIC_BASE_URL}/a/...`）。
7. 发送「列出任务」→ 显示各任务状态。
8. 发送「每天早上 9 点给我汇总 X」→ 次日（或先在配置中改成临近时间测试）自动产生任务。注意 cron 按 UTC 解释：北京时间 9 点对应 `0 1 * * *`。
9. 发送图片 → 回复「目前只支持文字消息」。

## 项目结构

```
src/
  index.ts              # Worker 入口 + Gateway 路由（/telegram/webhook、/a/<key>）
  gateway.ts            # 请求分发、owner 校验、动作回调
  channels/             # ChannelAdapter（Telegram 实现）
  butler/               # Butler DO：对话、记忆、任务索引、定时任务、通知节流
  task/                 # Task DO：执行、事件 outbox、审批、控制指令
  tools/                # web_search、web_fetch、R2 产物、MCP 包装
  llm/                  # 按角色解析模型
  config.ts             # 白名单、模型、MCP 与审批配置
scripts/set-webhook.ts  # 设置 Telegram webhook
tests/                  # 测试与测试专用 Worker 入口
```

## 安全与注意事项

- 只响应 `owner.telegramUserIds` 中的用户；其他人发来的消息返回 200 并忽略。
- 所有 secrets 只通过 `wrangler secret put` 或 `.dev.vars` 提供，切勿提交到仓库。`.dev.vars` 已加入 `.gitignore`。
- 修改 `wrangler.jsonc` 后重新执行 `npx wrangler types` 更新 `worker-configuration.d.ts`。
- 修改 Durable Object 类或迁移后需重新部署；已部署的 migration 不可重写。
