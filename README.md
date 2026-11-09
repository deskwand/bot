# DeskWand Bot

一个住在你自己 Cloudflare Worker 里的 bot。有自己的使命和记忆，自己安排什么时候醒；没事不吵你，真有事才发一条。

AGPL-3.0 · [English](README.en.md) · [官网](https://deskwand.com/bot?src=gh-readme)

## 三分钟跑起来

不想碰命令行的话，[装桌面客户端](https://deskwand.com/bot?src=gh-download)就行，不需要 Node、Git 或 Wrangler：

1. 用 Cloudflare 账号登录（浏览器里授权一次，不用自己填 account id 或 token）
2. 选模型和入口。默认 Workers AI 的 Gemma 4 26B，不用填 key；入口选 Telegram 或微信
3. 点部署。客户端会建资源、上传代码、激活版本

然后用你选的那个入口跟它说话，比如「每天早上看一遍科技新闻，有大事就发我」。

命令行部署、secrets、`DESKWAND_CONFIG` 怎么写，看下面的章节。

## 它跟一般 agent 不一样的地方

- **跑在你自己的账号里。** Worker、Durable Objects、R2 都是你的，控制台里看得见，也能自己删。消息和任务不经过我们的服务器。
- **是长期存在的东西，不是一次对话。** 有自己的使命、守则、记忆，自己决定下次什么时候醒（5 分钟到 30 天之间）。每次醒来还记得上次做到哪。
- **默认不吵。** 不发「已开始」、不发进度、不发心跳。只有真有值得说的变化才发一条。
- **花钱有边界。** 免费额度用完就停到 UTC 0 点，不会自动扣费。

## 架构

- 渠道层：`ChannelDO`（Telegram 长轮询与微信 iLink 轮询，单实例）
- 控制链路：`ButlerDO`（全局单实例，Pi agent + SQLite 业务表）
- 执行链路：`TaskDO`（每任务一个实例，工具调用、审批、崩溃恢复）
- 自主机器人：`BotDO`（每个机器人一个实例，独立记忆，自己决定下次唤醒，执行仍交给 TaskDO）
- 外部服务：`McpAuthDO`（全局单实例，远程 MCP 的 OAuth 注册、token 保管与续期，以及桌面端"测试连接"）
- 定时任务：通过 Agents SDK `Agent.schedule` 注册 cron（渠道轮询保活另用每 5 分钟一次的 Cron Trigger），cron 按 **UTC** 解释
- 产物：写入 R2，任务完成时由渠道以文件/图片本体直接送达（不进公开 URL）。单文件上限 15MB，超过在 `save_artifact` 阶段即被拒绝

每个任务的每一步先落盘再展示，进程被打断就从最后一次提交继续；同一个请求重发返回原结果，不会执行两次。

## 消息格式

出站文本按 **Markdown** 书写（模型直接写 Markdown，不改），渲染由各渠道适配器自己负责：

- Telegram：`src/channels/telegram-render.ts` 把 Markdown 转成 Bot API 的 `{ text, entities }`（不设 `parse_mode`）；渲染异常时按原文分块，带实体请求遇到 400 时去掉实体重试一次（消息未修改除外）。网络、限流、重试失败继续交给上层处理。一次编辑无法覆盖的长消息会退回完整原文纯文本，因此偶尔会看到字面的 `**` 标记——优先保证内容不丢。
- 微信（iLink）：协议只有纯文本 item，但微信客户端会就地渲染一部分 Markdown（粗体、代码块、行内代码、表格、H1-H4、水平线）；`src/channels/wechat/markdown.ts` 在代码范围以外只剥掉客户端不渲染的三类（中文斜体、H5/H6、图片），代码和转义标记保持原文。客户端能力依据社区结论，仍需真实客户端冒烟确认。
- 将来接入飞书 / 企业微信：在 adapter 内新增各自的渲染层，`src/protocol.ts`、`src/butler/*`、`src/channels/channel-do.ts` 都不需要改动。

图片：用户发来的图片会交给模型看（入站支持，bot 不会主动发图）。两渠道行为一致：

- Telegram：照片（可带说明文字）或"以文件发送"的 `image/*`，经 `getFile` 下载。
- 微信（iLink）：`item_list` 的图片项从 CDN 下载后用 AES-128-ECB 解密。
- 共通：只接受 JPEG / PNG / GIF / WebP，按魔数判断；进入模型前压到 2000px、base64 ≤ 500KB，一条消息最多一张。
- 当前模型不支持图片时会回固定提示，不会把图片悄悄换成占位文字；取不到图片内容时也会明说，而不是回"只支持文字消息"。

语音：用户发来的语音会转成文字当正文，转写过程不展示给用户。

- 微信（iLink）：协议自带服务端识别好的文本（`voice_item.text`），直接读；不下载音频、不做 SILK 解码。识别为空时回固定提示。
- Telegram：语音为 OGG/Opus，`getFile` 下载后交给 Workers AI 的 `@cf/openai/whisper-large-v3-turbo` 转写（约 46 neurons/音频分钟，免费额度约 3.5 小时/天）。
- 共通：下载或转写失败时回"收到了语音，但没能转成文字"，不会丢掉整条消息；语音可以带 caption，两段文字都保留。

## 邮箱

配好邮箱账号后，任务可以读主人的邮件：按条件搜标题/发件人/正文、读一封的正文、列出附件。

- 只读：不标已读、不删除、不移动。正文一律用 `BODY.PEEK` 读取，邮箱里的未读状态不变。
- 只在任务里可用：管家要读邮件时派一个任务，跟 `web_search`、MCP 工具同一层。
- 每次调用现场连 IMAP（993 隐式 TLS 或 143 STARTTLS），不建索引、不缓存正文。
- 单封上限 15MB，回给模型的正文截断到 8000 字。
- 没配或配残（缺密钥、端口越界）时工具完全不出现，模型看不到这套能力。

账号写在 `DESKWAND_CONFIG` 的 `email.accounts`，密码写 secret `EMAIL_SECRET_<ID>`（ID 大写、`-` 换 `_`）。字段级校验在 `src/mail/accounts.ts`，坏账号只丢自己，不影响 Worker 启动。

```jsonc
"email": {
  "accounts": [{
    "id": "main",
    "user": "me@example.com",
    "imap": { "host": "imap.example.com", "port": 993, "security": "tls" }
  }]
}
```

## 自主机器人

对管家说「建一个机器人，盯着 X，有变化告诉我」即可创建。机器人长期存在，有自己的使命与独立记忆，自己决定下次什么时候醒；每次醒来仍由管家派出一个任务执行。管家也能列出、查看、暂停、恢复、改名、删除机器人，或让它立即唤醒一次、追加一句指令。

机器人有守则（机器人提议的改动要主人批准）、方法和记忆文档，每次唤醒自动加载；它也能看到管家记得的主人信息。可以对管家说“给 X 加一条守则”，管家会直接写入。

机器人任务**安静运行**：不发「已开始」、不发进度或心跳，也不做完成汇报。主人只会看到三类消息：

- 机器人主动发的 `【<名字>】…` 消息（没有值得说的变化就不发；旧的 `🤖 <名字>：…` 消息仍可回复）；
- 需要审批的按钮（文案带机器人名字）——机器人任务里的写操作先经自动审查，只有涉及金钱、删除、权限、对外发送等高风险操作才弹审批；
- 暂停、每日上限等异常提醒。

唤醒时间受固定限制，不写进配置：最短 5 分钟、最长 30 天；每个 UTC 自然日最多唤醒 48 次（手动唤醒也算），超出后当天剩余唤醒顺延到次日 00:00 UTC，并通知一次。机器人没有安排下次唤醒时，按创建时给的默认间隔。

连续 3 次失败会自动暂停并通知，恢复后清零失败计数。备份导出与恢复包含机器人（使命、守则、方法、记忆、运行记录与下次唤醒时间）。

也可以直接跟机器人对话：消息以 `@名字` 或 `@id` 开头（例如「@盯盘 你最近发现了什么」），或者直接回复一条 `【<名字>】…` 消息（旧的 `🤖 <名字>：…` 消息仍可回复；引用优先，正文照常写）。机器人会当场用 `【<名字>】…` 回复，回答依据它的使命、守则、方法、记忆和最近的运行记录。对话里可以让它立刻运行一次（结束后汇报）、修改守则 / 方法 / 记忆、调整下次唤醒时间或默认间隔、暂停或恢复；改守则的回复末尾一定有一行「已更新守则：…」。暂停只停自动唤醒，仍可对话。

对话只管对话本身：改名、删除仍对管家说；发给机器人的附件也由管家处理（机器人运行读不到文件）。对话记录不在备份里；恢复备份后，对话可能从头开始，要长期保留的内容请让机器人写进记忆或守则。

## 前置条件

- Node.js 22.6+（推荐 Node 26；本地脚本使用 Node 原生 TypeScript 类型擦除）
- npm
- Cloudflare 账号，并已执行 `npx wrangler login`
- Telegram Bot Token（在 [@BotFather](https://t.me/BotFather) 创建 bot）
- 可选：模型厂商 API Key（默认用 Cloudflare Workers AI 免费额度，无需 key）
- 联网搜索使用 Exa 免费 MCP，无需 API Key
- 可选：外部服务（远程 MCP），在桌面端"服务"页添加

## 默认模型：Cloudflare Workers AI

新装默认用 Cloudflare Workers AI 的 `@cf/google/gemma-4-26b-a4b-it`（Gemma 4 26B），经 Worker 的 `AI` binding 调用，**不需要填任何 key**。它支持图片和工具调用，输入 $0.1/百万 token、输出 $0.3/百万 token。

- Cloudflare 每个账号每天有 10,000 neurons 的免费额度，所有 Workers AI 模型共用；默认模型大约够几十轮管家对话。
- 额度在 UTC 0 点（北京时间 8 点）重置。超出后免费账号的 Workers AI 会暂停，付费账号按 $0.011 / 1000 neurons 计费。
- 额度用完时，管家会回复：「今天的 Cloudflare 免费模型额度已用完（UTC 0 点重置，即北京时间 8 点）。想继续用，可以在桌面端模型页换成自己的模型 key。」任务会以不可重试的失败结束；机器人遇到这种失败不计入连续失败次数，也不会因此被自动暂停。
- 换模型：桌面客户端的「模型」页可以选择其他厂商并填写对应的 `MODEL_KEY_*`；换回 Workers AI 不需要 key。已有部署的模型配置不会自动迁移，也不会弹出提示。
- `workers-ai` 现为内置厂商 id；若已有配置里自定义厂商用了这个 id，升级前需在桌面端改名，否则配置会被判为无效。
- Workers Free 计划不能用部分模型（`@cf/zai-org/glm-5.3-flash`、`deepseek-v4` 系列、`glm-5.2` / `glm-5.3`、`kimi-k2.6` / `kimi-k2.7`）。选中后会收到：「当前模型需要 Cloudflare Workers 付费计划，请在桌面端模型页换成免费计划可用的模型（例如默认的 Gemma 4 26B）。」免费计划可用的模型清单见 [`docs/workers-ai-spike.md`](docs/workers-ai-spike.md)。

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
```

模型 key 的 secret 名统一按厂商 id 推导：`MODEL_KEY_` + id 转大写、`-` 换成 `_`。例如 `opencode-go` → `MODEL_KEY_OPENCODE_GO`、`deepseek` → `MODEL_KEY_DEEPSEEK`、`anthropic` → `MODEL_KEY_ANTHROPIC`。自定义端点同样按 id 推导，例如 `my-proxy` → `MODEL_KEY_MY_PROXY`。

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars` 并填入同样的值（`.dev.vars` 已被 git 忽略）。其中 `DESKWAND_CONFIG` 必填，否则本地业务处理同样以 `CONFIG_MISSING` 拒绝：

```bash
cp .dev.vars.example .dev.vars
```

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `MODEL_KEY_<ID>` | secret | 模型调用；`<ID>` 是厂商 id 转大写、`-` 换 `_`（如 `MODEL_KEY_OPENCODE_GO`、`MODEL_KEY_DEEPSEEK`）；缺失时只影响该厂商的模型 |
| `TELEGRAM_BOT_TOKEN` | secret | BotFather 提供的 token |
| `WECHAT_CREDENTIALS` | secret | 可选；微信 iLink 登录凭据，由 `npm run wechat-login` 写入 |
| `PUBLIC_BASE_URL` | var | 部署后的公开地址（MCP OAuth 回调使用） |
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
    "butler": { "provider": "workers-ai", "id": "@cf/google/gemma-4-26b-a4b-it" },
    "task": { "provider": "workers-ai", "id": "@cf/google/gemma-4-26b-a4b-it" }
  },
  "mcpServers": []
}
```

`100000001` 只是示例占位，请换成真实的 Telegram 用户 ID。

- `owner.telegramUserIds`：允许使用该 bot 的 Telegram 用户 ID（正整数）。空数组是合法配置，表示不授权任何人；不存在仓库内置 owner，也不会回退到源码常量。
- `models`：按角色（`butler` / `task`）配置模型。`workers-ai` 是内置的免 key 厂商（默认）；其他内置厂商和 `models.customProviders` 里的自定义端点按 `MODEL_KEY_<ID>` 读取 key。
- `mcpServers`：远程 MCP 服务器列表，推荐在桌面端"服务"页从目录添加（GitHub、Notion、Linear、Sentry、高德地图等），不必手写。只支持远程 MCP（Streamable HTTP / SSE），不支持 `npx` 启动的本地 stdio 服务。
  - 审批：桌面端添加的服务默认"读免审、写智能"（`approvalPolicy: "writes"`，依据工具的 `readOnlyHint`）：只读工具直接执行，其他写操作先交给审查模型判断，常规操作直接放行，只有涉及金钱、删除、权限、对外发送等高风险操作才发 ✅/❌ 审批按钮，卡片附审查理由。标了 `destructiveHint` 的工具始终要审。可逐个工具改为智能、免审、要审或停用（`autoApprove` / `requireApproval` / `disabledTools`）。
  - 老部署：以前在工具页把写工具设成"要审"的服务仍保留在 `requireApproval` 里，升级后不会自动改回智能审查；需要到工具页把写工具改回"智能"并保存。
  - 密钥：header 值写 `env:NAME`，URL 中写 `{env:NAME}` 占位，`NAME` 为 `MCP_` 开头的 Worker secret；引用原样保留，不会把值展开进普通 var。
  - 登录授权（OAuth）：由 Worker 完成，回调地址为 `${PUBLIC_BASE_URL}/mcp/oauth/callback`，token 存在 `McpAuthDO` 并自动续期，不进入本地备份；恢复到新部署后需在"服务"页重新授权。
- `schemaVersion` 必须为 `1`；未知版本、非整数/越界用户 ID、未知 provider 或非法 JSON 都会以固定错误拒绝，不会猜测或回退。

`MODEL_KEY_<ID>`、`TELEGRAM_BOT_TOKEN` 都是可选 secret：缺失时只影响对应业务路径（例如缺少 Bot token 时无法接收或发送 Telegram 消息）。

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

编辑 `wrangler.jsonc` 的 `vars.PUBLIC_BASE_URL`，填入部署后的公开地址，例如 `https://bot.<your-subdomain>.workers.dev` 或自定义域名。MCP 授权回调依赖该值；如果还不确定地址，可以先部署一次拿到 URL，回填后再部署一次。

Telegram 用户 ID 可通过 [@userinfobot](https://t.me/userinfobot) 获取。

## 5. 部署

```bash
npm run deploy
```

Telegram 由 Worker 主动长轮询收消息，不需要设置 webhook；旧部署升级后会自动删除已注册的 webhook。

### 首次导入预置技能

任务 agent 的技能库是 R2 里的共享目录 `skills/`，与任务草稿 `work/<taskId>/` 分开。仓库自带一个预置技能 `skills/brainstorming/SKILL.md`，但 `npm run deploy` 只上传 Worker 代码，不会写入 R2 对象。空 bucket 在导入前没有任何技能。

在部署者电脑上执行一次（bucket 名以 `wrangler.jsonc` 的 `ARTIFACTS` 绑定为准，当前为 `my-artifacts`）：

```bash
npx wrangler r2 object put my-artifacts/skills/brainstorming/SKILL.md \
  --file skills/brainstorming/SKILL.md \
  --content-type "text/markdown; charset=utf-8" \
  --remote
```

该命令会覆盖同名对象，只在首次导入、或你主动选择恢复/更新时执行，日常部署不必重复。升级 Worker 不会恢复被删除的预置技能，也不会覆盖你改过的内容。源码包必须包含 `skills/brainstorming/SKILL.md`。

## 6. 技能

技能是一段工作方法说明，任务 agent 在新任务开始时自动拿到全部技能的名称、描述和入口路径；需要时再读取正文。管家不加载技能。

安装由任务 agent 用普通的 `write` 完成。例如发送：

> 请把下面这个技能安装为 `weekly-report`，保存在 `/skills/weekly-report/SKILL.md`

入口必须是 `/skills/<名字>/SKILL.md`，名字为 1–64 个小写字母、数字或连字符，首尾不能是连字符；正文开头要有 front matter：

```markdown
---
name: weekly-report
description: 每周汇总本周任务，输出一页 Markdown 报告。
---

# 每周报告
...
```

附加参考文件放在同一目录下（如 `/skills/weekly-report/references/`），相对路径以技能目录为基准。写入共享目录不经过审批闸门，只受提示词约束——被不可信网页诱导写入的技能会影响之后所有新任务，所以只在你自己要求时才让它装；单文件上限 1 MiB，没有 shell，也无法执行脚本，所以带脚本的技能只能保存、不能运行。

界面与生效时机：

- 新增、修改或删除技能对**下一个新任务**生效；正在运行的任务沿用启动时的目录，但正文是读取当时的 R2 内容。
- 删除没有聊天工具，用 Cloudflare R2 控制台删除 `skills/<名字>/SKILL.md`（删入口即停用），或：

```bash
npx wrangler r2 object delete my-artifacts/skills/weekly-report/SKILL.md --remote
```

- `/admin/r2/*` 是桌面端的备份接口（需要维护租约）：技能会进入备份，恢复备份也会带回已删除的技能。它不是日常删除入口。

## 自托管兜底

Cloudflare 是唯一的主路径。为防止供应商锁定，可以退到本机的 Miniflare（同一份构建产物、同一个 workerd 运行时）降级运行，数据通过现有的 `/admin/backup/*` 与 `/admin/r2/*` 协议搬运。资源需求、已知的版本坑、切换纪律与 RPO 见 `docs/self-host-fallback.md`。

两条不能破的纪律：**同一时刻只能有一个实例在线**（两个实例同时轮询 Telegram 会互相抢 update），**不做双跑**。

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

只接受扫码主人的消息，支持文字、图片、文件和语音（读微信侧的转写文本）。一条消息里的多个图片或附件会逐个交给管家，其中一张下载失败不影响其他几张。首条主人文字消息会正常处理和回复（保存该凭据版本的 context 后进入管家），不需要“准备消息”，也没有准备期。未选中微信时不会保留轮询链，但会保留 cursor 与 context 以便再次选中时继续。

微信不支持消息编辑与按钮：

- 任务进度改发"心跳"：开始一条，第一条进度后静默 60 秒，之后每 180 秒最多一条（内容带最近一步），终态再一条；Telegram 仍是 3 秒节流 + 原地编辑。
- 终态只有一条消息：`✅ <任务>：<结果>`；失败与取消同样是单条。
- 出站消息先写入 Channel DO 的 `outbound_queue` 再发送：发送失败的消息留在队列，下次收到主人消息（`context_token` 刷新）或下一次发送前补发，顺序保持不变。队列上限 20 条，超出丢最旧（丢时会写日志）；同一条消息连续失败 5 次后放弃，避免堵死后面的消息。
- 投递语义是 **at-least-once**：宁可重复，不丢。微信没有消息 id，无法做到恰好一次。
- 发送失败只记录脱敏事件 `send_error`（固定 errorCode），不再静默丢弃。
- 按钮降级为文字提示，并保留完整审批编号，例如 `回复"批准 t3 ap1"`、`回复"拒绝 t3 ap1"`、`回复"取消 t3"`。批准/拒绝必须带编号，不接受让模型猜测；无匹配的命令按普通文字处理。
- 登录过期（iLink `-14`）只把状态标记为 `expired` 并写脱敏日志，不再向 Telegram 发提醒。重新运行 `npm run wechat-login` 扫码取得新凭据即可恢复；相同的过期凭据不会因为重新部署而复活。

本地开发可在 `.dev.vars` 中设置 `WECHAT_CREDENTIALS`，格式见 `.dev.vars.example`。凭据包含敏感 token，请勿提交或复制到日志。

## 本地开发

```bash
npm run dev                 # wrangler dev，默认 http://localhost:8787
# 可选：需要让外部服务回调到本地（MCP 授权）时
cloudflared tunnel --url http://localhost:8787
```

Telegram 由 Worker 主动长轮询收消息，本地调试不需要公网地址。注意：同一个 bot token 同一时间只能有一个轮询方，本地调试请使用单独的测试 bot，否则会和线上部署抢消息。若需要让外部服务回调到本机（例如 MCP 授权），可把 `.dev.vars` 中的 `PUBLIC_BASE_URL` 填成隧道地址。

## 从源码常量迁移到 DESKWAND_CONFIG

本代码不再读取 `src/config.ts` 中的 owner、模型或 MCP 常量。对已经在线运行的 Worker，必须先写入等价的 `DESKWAND_CONFIG`，再部署本代码；否则业务会以固定 `CONFIG_MISSING` 错误停止，不会回退到仓库里的默认值或旧 owner。

迁移顺序：

1. 在 Cloudflare Dashboard 的 Worker 设置中新增普通变量（不是 secret）`DESKWAND_CONFIG`。值取自迁移前的源码常量：`owner.telegramUserIds`、`models.butler`、`models.task`、`mcpServers`，并补上 `"schemaVersion": 1`。只填实际值，不要用示例占位 ID。
2. 保存后在 Dashboard 重新打开该 Worker 的 Settings → Variables and Secrets 页面核对（变量类型选 Text 或 JSON 均可，解析器两种都接受）：`schemaVersion`、owner 列表、两个模型和 MCP 名称/URL 与旧值一致。核对时不要把 secret 或带凭据的 header 输出到终端。
3. 确认远端值可读且正确后，再部署新代码。首次部署后发送一条测试消息，确认业务未因配置缺失而拒绝。
4. 之后 CLI 与桌面客户端可以共存，但远端 `DESKWAND_CONFIG` 是唯一权威；在任一侧修改后都要重新发布才会生效。不要把同一份配置再写回 `src/config.ts`，也不要在两处各维护一份草稿。

`wrangler.jsonc` 故意不声明 `DESKWAND_CONFIG`，并保留 `keep_vars: true`，因此命令行部署会保留控制台或客户端写入的远端值。注意：显式写进模板的其他 vars 仍会覆盖远端同名值。`npm run deploy` 会自动运行 `predeploy` 检查远端是否已有 `DESKWAND_CONFIG`；缺少 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时会警告跳过。命令行部署不会写入客户端使用的 release tag，因此部署后云端版本会显示为未知，直到在桌面客户端重新导入或执行一次客户端升级。

## 升级与迁移说明

- 升级不重建已有的 Durable Object：业务表只追加列（`tasks.progress_message_ref_json`、`approval_messages.message_ref_json`、`tasks.bot_id`），旧行保持原样。自主机器人新增了 `BotDO` 类（migration `v3`），只新建、不改动已有类。外部服务（MCP）新增了 `McpAuthDO` 类（migration `v4`，全局单实例，保管 OAuth token），同样只新建。
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

仓库同时包含 macOS / Windows 桌面客户端 **DeskWand Bot**（Go + MyGo + React），让用户无需 Node.js、Git、Wrangler 或 Go 即可通过 Cloudflare API 部署和管理本项目：

- 用户安装、Cloudflare OAuth 登录、部署 / 接管、消息入口、保存并发布、状态含义、CLI 共存与重新授权：[`docs/desktop-client.md`](docs/desktop-client.md)
- 维护者密钥、macOS / Windows 打包、签名与公证、客户端更新源与本机发布流程（`npm run release:desktop -- --platform both`）：[`docs/desktop-client.md`](docs/desktop-client.md) 的维护者章节
- 平台验收的 PASS / FAIL / NOT RUN 结论属于维护者内部记录，不随仓库公开
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
2. 发送「帮我调研 X」→ 收到「已开始任务 t1」；60 秒内不再有进度消息，之后每 3 分钟最多一条心跳；结束时只收到一条 `✅ t1 …：<结果>`。
3. 新任务进行中发送「t1 只看英文资料」→ 后续进度体现新方向。
4. 新任务进行中点击「取消」→ 进度消息变为已取消。
5. 配置一个带 `requireApproval` 的 MCP 工具并触发 → 收到 ✅/❌ 审批按钮；批准后工具执行，拒绝后 agent 改道；重复点击提示「已处理」。
6. 任务完成后收到管家汇报，以及以附件形式送达的产物文件（图片直接在聊天里可见，不再有链接）。
7. 发送「列出任务」→ 显示各任务状态。
8. 发送「每天早上 9 点给我汇总 X」→ 次日（或先在配置中改成临近时间测试）自动产生任务。注意 cron 按 UTC 解释：北京时间 9 点对应 `0 1 * * *`。
9. 发送图片 → 回复「目前只支持文字消息」。
10. 渠道切换：把 `ACTIVE_CHANNEL` 改为另一渠道并发布，确认新配置版本里当前渠道能对话，另一边发消息不会执行任务；任务进度、审批与完成通知都出现在当前渠道。
11. 未选中微信时确认没有持续轮询；选中微信且尚无 context 时，给主人发第一条文字消息能正常回复，随后待审批会重展。
12. 用文字「批准 t3 ap1」/「拒绝 t3 ap1」/「取消 t3」在微信执行审批与取消，重复发送仍是幂等结果。
13. 导入预置技能后新建任务，问它有哪些技能 → 能看到 brainstorming；让它读取该技能 → 返回正文。
14. 删除 `skills/brainstorming/SKILL.md` 后新建任务 → 不再出现该技能；正在运行的任务不受影响。

## 项目结构

```
src/
  index.ts              # Worker 入口 + Gateway 路由（/admin/*、MCP 回调）
  gateway.ts            # 产物路由
  channels/             # ChannelDO、Telegram 与微信 iLink 适配器
  butler/               # Butler DO：对话、记忆、任务索引、定时任务、通知节流
  task/                 # Task DO：执行、事件 outbox、审批、控制指令
  tools/                # web_search、web_fetch、R2 产物、MCP 包装
  llm/                  # 按角色解析模型
  config.ts             # 配置类型与 isOwner/needsApproval 纯函数
  runtime-config.ts     # 从 DESKWAND_CONFIG 校验并读取运行时配置
contracts/              # Go/TS 共用的部署配置 schema 与 fixtures
scripts/wechat-login.ts # 微信扫码登录并写入 Cloudflare secret
tests/                  # 测试与测试专用 Worker 入口
```

## 安全与注意事项

- 只响应 `owner.telegramUserIds` 中的用户；其他人发来的消息返回 200 并忽略。
- 所有 secrets 只通过 `wrangler secret put` 或 `.dev.vars` 提供，切勿提交到仓库。`.dev.vars` 已加入 `.gitignore`。
- 修改 `wrangler.jsonc` 后重新执行 `npx wrangler types` 更新 `worker-configuration.d.ts`；`CF_VERSION_METADATA` binding 是消息归属的一部分，发布配置不要删除。
- 日志不包含 token、凭据、context 或消息正文；排查渠道问题时只核对版本与 `ACTIVE_CHANNEL`。
- 修改 Durable Object 类或迁移后需重新部署；已部署的 migration 不可重写。
