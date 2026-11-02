# 多渠道管家 Bot（Cloudflare Workers）

一个部署在 Cloudflare Workers 上的单人助手：管家负责对话、记忆、任务派发与通知，每个任务由独立的 Durable Object 执行，结果（含产物链接）统一由管家经当前选中渠道回传。同一时刻只启用一个业务渠道，由 Worker 环境变量 `ACTIVE_CHANNEL` 选择（`telegram` 或 `wechat`）。

- 渠道层：`ChannelDO`（Telegram webhook 与微信 iLink 轮询，单实例）
- 控制链路：`ButlerDO`（全局单实例，Pi agent + SQLite 业务表）
- 执行链路：`TaskDO`（每任务一个实例，工具调用、审批、崩溃恢复）
- 定时任务：通过 Agents SDK `Agent.schedule` 注册 cron（微信轮询保活另用每 5 分钟一次的 Cron Trigger），cron 按 **UTC** 解释
- 产物：写入 R2，通过 `${PUBLIC_BASE_URL}/a/<key>` 访问

## 消息格式

出站文本按 **Markdown** 书写（模型直接写 Markdown，不改），渲染由各渠道适配器自己负责：

- Telegram：`src/channels/telegram-render.ts` 把 Markdown 转成 Bot API 的 `{ text, entities }`（不设 `parse_mode`）；渲染异常时按原文分块，带实体请求遇到 400 时去掉实体重试一次（消息未修改除外）。网络、限流、重试失败继续交给上层处理。一次编辑无法覆盖的长消息会退回完整原文纯文本，因此偶尔会看到字面的 `**` 标记——优先保证内容不丢。
- 微信（iLink）：协议只有纯文本 item，但微信客户端会就地渲染一部分 Markdown（粗体、代码块、行内代码、表格、H1-H4、水平线）；`src/channels/wechat/markdown.ts` 在代码范围以外只剥掉客户端不渲染的三类（中文斜体、H5/H6、图片），代码和转义标记保持原文。客户端能力依据社区结论，仍需真实客户端冒烟确认。
- 将来接入飞书 / 企业微信：在 adapter 内新增各自的渲染层，`src/protocol.ts`、`src/butler/*`、`src/channels/channel-do.ts` 都不需要改动。

## 前置条件

- Node.js 22.6+（推荐 Node 26；`npm run set-webhook` 使用 Node 原生 TypeScript 类型擦除）
- npm
- Cloudflare 账号，并已执行 `npx wrangler login`
- Telegram Bot Token（在 [@BotFather](https://t.me/BotFather) 创建 bot）
- OpenCode Go API Key（模型调用）
- 联网搜索使用 Exa 免费 MCP，无需 API Key
- 可选：MCP 服务器（在 `DESKWAND_CONFIG` 中配置）

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
npx wrangler secret put MODEL_KEY_OPENCODE_GO
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

模型 key 的 secret 名统一按厂商 id 推导：`MODEL_KEY_` + id 转大写、`-` 换成 `_`。例如 `opencode-go` → `MODEL_KEY_OPENCODE_GO`、`deepseek` → `MODEL_KEY_DEEPSEEK`、`anthropic` → `MODEL_KEY_ANTHROPIC`。自定义端点同样按 id 推导，例如 `my-proxy` → `MODEL_KEY_MY_PROXY`。

`TELEGRAM_WEBHOOK_SECRET` 是自定义的随机字符串，用于校验 Telegram 回调头 `X-Telegram-Bot-Api-Secret-Token`，可用下面命令生成：

```bash
openssl rand -hex 32
```

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars` 并填入同样的值（`.dev.vars` 已被 git 忽略）。其中 `DESKWAND_CONFIG` 必填，否则本地业务处理同样以 `CONFIG_MISSING` 拒绝：

```bash
cp .dev.vars.example .dev.vars
```

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `MODEL_KEY_<ID>` | secret | 模型调用；`<ID>` 是厂商 id 转大写、`-` 换 `_`（如 `MODEL_KEY_OPENCODE_GO`、`MODEL_KEY_DEEPSEEK`）；缺失时只影响该厂商的模型 |
| `TELEGRAM_BOT_TOKEN` | secret | BotFather 提供的 token |
| `TELEGRAM_WEBHOOK_SECRET` | secret | webhook 校验密钥（自定义随机串）；缺失时所有 Telegram webhook 都会被拒绝 |
| `WECHAT_CREDENTIALS` | secret | 可选；微信 iLink 登录凭据，由 `npm run wechat-login` 写入 |
| `PUBLIC_BASE_URL` | var | 产物链接前缀，填部署后的公开地址 |
| `DESKWAND_CONFIG` | var | 非敏感业务配置（owner、模型、MCP），结构见 `contracts/deployment-config.schema.json` |
| `ACTIVE_CHANNEL` | var | 业务渠道选择：`telegram` 或 `wechat`。生产模板不声明，由发布配置提供 |

生产环境的 `wrangler.jsonc` 用 `keep_vars: true` 保留控制台或发布客户端设置的远端变量，并声明 `version_metadata` binding：

```jsonc
"vars": {
  "PUBLIC_BASE_URL": "https://your-worker.workers.dev"
},
"keep_vars": true,
"version_metadata": { "binding": "CF_VERSION_METADATA" }
```

`wrangler deploy` 会保留未在模板中声明的远端 vars（例如 `ACTIVE_CHANNEL`）；显式写在模板里的字段仍会覆盖远端值。测试部署或 `wrangler deploy --dry-run` 不能证明远端值被保留，线上需用只读方式核对实际 vars（只输出 `ACTIVE_CHANNEL` 等名称，不输出 secret）。

## 4. 填写个人配置

业务配置不再写在源码里，而是由普通 var `DESKWAND_CONFIG` 提供，结构以 `contracts/deployment-config.schema.json` 为准：

```json
{
  "schemaVersion": 1,
  "owner": { "telegramUserIds": [100000001] },
  "models": {
    "butler": { "provider": "opencode-go", "id": "deepseek-v4.1-flash" },
    "task": { "provider": "opencode-go", "id": "deepseek-v4.1-flash" }
  },
  "mcpServers": []
}
```

`100000001` 只是示例占位，请换成真实的 Telegram 用户 ID。

- `owner.telegramUserIds`：允许使用该 bot 的 Telegram 用户 ID（正整数）。空数组是合法配置，表示不授权任何人；不存在仓库内置 owner，也不会回退到源码常量。
- `models`：按角色（`butler` / `task`）配置模型，provider 只接受现有适配器支持的 `anthropic` 与 `opencode-go`。
- `mcpServers`：MCP 服务器列表；对需要人工确认的工具在 `requireApproval` 中列出工具名，触发时会先发 ✅/❌ 审批按钮。header 值可以写 `env:NAME` 引用 Worker secret，引用会原样保留，不会把值展开进普通 var。
- `schemaVersion` 必须为 `1`；未知版本、非整数/越界用户 ID、未知 provider 或非法 JSON 都会以固定错误拒绝，不会猜测或回退。

`MODEL_KEY_<ID>`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET` 都是可选 secret：缺失时只影响对应业务路径（例如缺少 webhook secret 时所有 Telegram webhook 都会被拒绝）。

自定义 OpenAI/Anthropic 兼容端点在 `models.customProviders` 里声明，并用同一个 id 推导 secret 名：

```json
{
  "models": {
    "butler": { "provider": "my-proxy", "id": "gpt-5.6" },
    "task": { "provider": "my-proxy", "id": "gpt-5.6" },
    "customProviders": [
      {
        "id": "my-proxy",
        "name": "我的中转",
        "api": "openai-completions",
        "baseUrl": "https://proxy.example.com/v1",
        "models": [{ "id": "gpt-5.6" }]
      }
    ]
  }
}
```

对应的 key 用 `npx wrangler secret put MODEL_KEY_MY_PROXY` 写入。

渠道选择不在 `DESKWAND_CONFIG` 里：`ACTIVE_CHANNEL` 是唯一权威，缺省为 `telegram`（兼容旧部署）；显式写成其他值时业务收发全部关闭并记录固定配置错误，不会悄悄回退到 Telegram。

编辑 `wrangler.jsonc` 的 `vars.PUBLIC_BASE_URL`，填入部署后的公开地址，例如 `https://bot.<your-subdomain>.workers.dev` 或自定义域名。产物链接依赖该值；如果还不确定地址，可以先部署一次拿到 URL，回填后再部署一次。

Telegram 用户 ID 可通过 [@userinfobot](https://t.me/userinfobot) 获取。

## 5. 部署

```bash
npm run deploy
```

部署完成后，用 Worker 的公开地址设置 Telegram webhook（webhook 始终设置；只有选中 Telegram 时才会向管家分发）：

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

## 渠道选择与切换

`ACTIVE_CHANNEL` 决定唯一业务渠道：

- 全部对话回复、任务进度、审批、完成/失败/取消和定时任务通知都发往选中渠道；消息来源只作记录。
- 另一渠道的入站消息和旧按钮不会执行任何任务；旧按钮会收到“该渠道未启用”的回调提示（Telegram）或被忽略（微信）。
- 不自动切换渠道，也不通过备用渠道发送提醒。发送失败只记录脱敏日志，任务状态和结果仍会保存，可在恢复后的选中渠道查询。
- 修改选择需要发布新的 Worker 配置版本（例如控制台改 vars 后保存并部署，或由管理客户端发布）。变更随配置发布生效；发布交替期间，旧版本已经在处理的请求可能继续完成，不承诺全局瞬时切换。

### 微信启用步骤

部署后运行（推荐 Node 26，脚本使用 `--use-env-proxy`）：

```bash
npm run wechat-login
```

用主人的微信扫描终端二维码，并在手机上确认。脚本每 2 秒查询一次状态；二维码过期后自动换码，最多显示 3 张。登录凭据通过 stdin 写入 Cloudflare 的 `WECHAT_CREDENTIALS` secret，不保存到文件，也不打印 token。iLink 请求使用环境代理；上传 secret 时会移除 HTTP/HTTPS 代理变量。该脚本只更新凭据，不会自动把 `ACTIVE_CHANNEL` 改成 `wechat`。

选中微信的顺序是：先运行上面的登录脚本写入凭据，再把发布配置中的 `ACTIVE_CHANNEL` 设为 `wechat` 并发布。选中后 Cron 每 5 分钟尝试启动轮询，Channel DO 首次启动或收到现有调用时也会尝试，因此没有外部触发时需要等下一轮 Cron，不承诺立即开始。

只接受扫码主人的消息，目前支持文字对话；图片或文件会得到“目前只支持文字消息”的回复。首条主人文字消息会正常处理和回复（保存该凭据版本的 context 后进入管家），不需要“准备消息”，也没有准备期。未选中微信时不会保留轮询链，但会保留 cursor 与 context 以便再次选中时继续。

微信不支持消息编辑与按钮：

- 进度和审批改为发送新消息，保留节流。
- 按钮降级为文字提示，并保留完整审批编号，例如 `回复"批准 t3 ap1"`、`回复"拒绝 t3 ap1"`、`回复"取消 t3"`。批准/拒绝必须带编号，不接受让模型猜测；无匹配的命令按普通文字处理。
- 登录过期（iLink `-14`）只把状态标记为 `expired` 并写脱敏日志，不再向 Telegram 发提醒。重新运行 `npm run wechat-login` 扫码取得新凭据即可恢复；相同的过期凭据不会因为重新部署而复活。

本地开发可在 `.dev.vars` 中设置 `WECHAT_CREDENTIALS`，格式见 `.dev.vars.example`。凭据包含敏感 token，请勿提交或复制到日志。

## 本地开发

```bash
npm run dev                 # wrangler dev，默认 http://localhost:8787
cloudflared tunnel --url http://localhost:8787
```

Telegram 需要公网 HTTPS 地址，所以本地调试需用隧道地址执行 `npm run set-webhook -- https://<tunnel-host>`，并把 `.dev.vars` 中的 `PUBLIC_BASE_URL` 也填成隧道地址（否则产物链接不可用）。调试结束后记得切回生产地址。

## 从源码常量迁移到 DESKWAND_CONFIG

本代码不再读取 `src/config.ts` 中的 owner、模型或 MCP 常量。对已经在线运行的 Worker，必须先写入等价的 `DESKWAND_CONFIG`，再部署本代码；否则业务会以固定 `CONFIG_MISSING` 错误停止，不会回退到仓库里的默认值或旧 owner。

迁移顺序：

1. 在 Cloudflare Dashboard 的 Worker 设置中新增普通变量（不是 secret）`DESKWAND_CONFIG`。值取自迁移前的源码常量：`owner.telegramUserIds`、`models.butler`、`models.task`、`mcpServers`，并补上 `"schemaVersion": 1`。只填实际值，不要用示例占位 ID。
2. 保存后在 Dashboard 重新打开该 Worker 的 Settings → Variables and Secrets 页面核对（变量类型选 Text 或 JSON 均可，解析器两种都接受）：`schemaVersion`、owner 列表、两个模型和 MCP 名称/URL 与旧值一致。核对时不要把 secret 或带凭据的 header 输出到终端。
3. 确认远端值可读且正确后，再部署新代码。首次部署后发送一条测试消息，确认业务未因配置缺失而拒绝。
4. 之后 CLI 与桌面客户端可以共存，但远端 `DESKWAND_CONFIG` 是唯一权威；在任一侧修改后都要重新发布才会生效。不要把同一份配置再写回 `src/config.ts`，也不要在两处各维护一份草稿。

`wrangler.jsonc` 故意不声明 `DESKWAND_CONFIG`，并保留 `keep_vars: true`，因此命令行部署会保留控制台或客户端写入的远端值。注意：显式写进模板的其他 vars 仍会覆盖远端同名值。`npm run deploy` 会自动运行 `predeploy` 检查远端是否已有 `DESKWAND_CONFIG`；缺少 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时会警告跳过。命令行部署不会写入客户端使用的 release tag，因此部署后云端版本会显示为未知，直到在桌面客户端重新导入或执行一次客户端升级。

## 升级与迁移说明

- 本次升级不重建 Durable Object，不新增 DO class migration；业务表只追加列（`tasks.progress_message_ref_json`、`approval_messages.message_ref_json`），旧行保持原样。
- 消息引用（`ChannelMessageRef`）记录渠道、会话、部署归属和消息 ID。引用只在同一部署、同一选择、同一会话时才能编辑；旧版本只留下裸消息 ID 的记录无法推断归属，会安全降级为新发一条消息。
- 普通代码发布会改变 route key：切换后或有旧消息引用时，下一条进度改发新消息，这是预期代价。A→B→A 切换即使中间版本没有唤醒 Channel DO，也不会复用旧引用。
- 旧版本在途的长轮询或模型请求可能在新配置发布后完成；新版本处理的请求使用新选择。不承诺跨版本同时在途请求的原子切换。
- 漏发的结果不会自动补发；用任务查询（例如「列出任务」）在恢复后的选中渠道取回。
- 待审批在新渠道重展的前提是审批仍真实 pending、本实例仍在等待且未中止、未超时；仅数据库里残留 pending 但没有等待者的记录不会复活，也不会为了重展重新执行工具。重展是 best-effort，发送成功但引用尚未写入时崩溃可能重发一次。

## 客户端窄契约

管理客户端（另一个项目）通过 Cloudflare 发布配置，本仓库不提供管理 API 或 CLI：

- `ACTIVE_CHANNEL`：只接受 `telegram`、`wechat`；缺省 `telegram`；其他值关闭业务收发并报固定错误，不回退。
- `DESKWAND_CONFIG`：普通 var，结构见 `contracts/deployment-config.schema.json`；必须包含 `schemaVersion: 1`，owner/models/MCP 均以此为准，不读源码常量。
- `WECHAT_CREDENTIALS`：仍是 Worker secret，保持现有 JSON 格式；本仓库不读取加密的动态凭据库，也不提供准备/就绪流程。
- 发布配置必须保留 `version_metadata: { "binding": "CF_VERSION_METADATA" }`，否则 Channel DO 拒绝业务处理并记录固定配置错误；生产使用 `keep_vars: true` 保留客户端设置的其他 vars。
- 变更必须发布新版本才生效；没有状态查询路由，也没有能力协商端点。健康检查 200 不代表微信轮询就绪；诊断用现有 Cloudflare 日志（只读查看版本与 `ACTIVE_CHANNEL`，不输出 secret）。
- 发布时保留其他 vars、secrets、bindings 和 DO 数据；`npm run wechat-login` 不修改 `ACTIVE_CHANNEL`。

## 桌面客户端

仓库同时包含 macOS / Windows 桌面客户端（Go + MyGo + React），让用户无需 Node.js、Git、Wrangler 或 Go 即可通过 Cloudflare API 部署和管理本项目：

- 用户安装、Cloudflare OAuth 登录、部署 / 接管、消息入口、保存并发布、状态含义、CLI 共存与重新授权：[`docs/desktop-client.md`](docs/desktop-client.md)
- 维护者密钥、macOS / Windows 打包、签名与公证、客户端更新源：[`docs/desktop-client.md`](docs/desktop-client.md) 的维护者章节
- 平台验收、PASS / FAIL / NOT RUN 证据：[`docs/verification/desktop-acceptance.md`](docs/verification/desktop-acceptance.md)
- 本机构建：`npm run build:desktop`（需要 Worker 发布签名私钥；产物在 `desktop/build/`）

桌面客户端更新与 Worker 发布包使用不同密钥（`deskwand-client-1` / `deskwand-release-1`）。客户端更新默认未配置更新源，且永远不会自动升级云端服务。

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
10. 渠道切换：把 `ACTIVE_CHANNEL` 改为另一渠道并发布，确认新配置版本里当前渠道能对话，另一边发消息不会执行任务；任务进度、审批与完成通知都出现在当前渠道。
11. 未选中微信时确认没有持续轮询；选中微信且尚无 context 时，给主人发第一条文字消息能正常回复，随后待审批会重展。
12. 用文字「批准 t3 ap1」/「拒绝 t3 ap1」/「取消 t3」在微信执行审批与取消，重复发送仍是幂等结果。

## 项目结构

```
src/
  index.ts              # Worker 入口 + Gateway 路由（/telegram/webhook、/a/<key>）
  gateway.ts            # webhook 转发、产物路由
  channels/             # ChannelDO、Telegram 与微信 iLink 适配器
  butler/               # Butler DO：对话、记忆、任务索引、定时任务、通知节流
  task/                 # Task DO：执行、事件 outbox、审批、控制指令
  tools/                # web_search、web_fetch、R2 产物、MCP 包装
  llm/                  # 按角色解析模型
  config.ts             # 配置类型与 isOwner/needsApproval 纯函数
  runtime-config.ts     # 从 DESKWAND_CONFIG 校验并读取运行时配置
contracts/              # Go/TS 共用的部署配置 schema 与 fixtures
scripts/set-webhook.ts  # 设置 Telegram webhook
scripts/wechat-login.ts # 微信扫码登录并写入 Cloudflare secret
tests/                  # 测试与测试专用 Worker 入口
```

## 安全与注意事项

- 只响应 `owner.telegramUserIds` 中的用户；其他人发来的消息返回 200 并忽略。
- 所有 secrets 只通过 `wrangler secret put` 或 `.dev.vars` 提供，切勿提交到仓库。`.dev.vars` 已加入 `.gitignore`。
- 修改 `wrangler.jsonc` 后重新执行 `npx wrangler types` 更新 `worker-configuration.d.ts`；`CF_VERSION_METADATA` binding 是消息归属的一部分，发布配置不要删除。
- 日志不包含 token、凭据、context 或消息正文；排查渠道问题时只核对版本与 `ACTIVE_CHANNEL`。
- 修改 Durable Object 类或迁移后需重新部署；已部署的 migration 不可重写。
