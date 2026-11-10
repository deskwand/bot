# DeskWand Bot

A bot that lives in your own Cloudflare Worker. It keeps its own mission and memory, decides on its own when to wake up, and stays quiet unless there is something worth telling you.

AGPL-3.0 · [中文](README.md) · [Website](https://deskwand.com/bot?src=gh-readme)

## Up and running in three minutes

If you would rather not touch a terminal, [install the desktop client](https://deskwand.com/bot?src=gh-download) — no Node, no Git, no Wrangler:

1. Sign in with your Cloudflare account (one browser authorization; you never type an account ID or create an API token yourself)
2. Pick a model and a channel. The default is Workers AI with Gemma 4 26B and needs no key. The channel is Telegram or WeChat
3. Deploy. The client creates the resources, uploads the code and activates the version

Then talk to it in the channel you picked. Something like *"read the tech news every morning and tell me if something big happens with models or chips"*.

Command-line deployment, secrets and the `DESKWAND_CONFIG` format are documented further down.

## Why it is not just another agent

- **It runs in your account.** The Worker, the Durable Objects and the R2 bucket are yours. You can see them in the Cloudflare dashboard and delete them yourself. Messages and tasks never pass through our servers.
- **It is a resident, not a conversation.** It has its own mission, rules and memory, and chooses when to wake next — anywhere between five minutes and thirty days. When it wakes, it still remembers where it got to.
- **It is quiet by default.** No "started" message, no progress, no heartbeat. It speaks only when something actually changed.
- **Its spending has a ceiling.** When the free allowance runs out it pauses until 00:00 UTC instead of billing you.

## Architecture

- `ChannelDO` — the channel layer (Telegram long polling, or WeChat iLink polling; a single instance)
- `ButlerDO` — the control path (one global instance: the agent, conversation, memory, task dispatch, on SQLite)
- `TaskDO` — one instance per task: execution, tool calls, approvals, crash recovery
- `BotDO` — one instance per resident bot: its own memory and wake schedule; execution is still delegated to `TaskDO`
- `McpAuthDO` — remote MCP OAuth registration, token storage and renewal
- Scheduled work goes through the Agents SDK `Agent.schedule` onto cron triggers, interpreted in **UTC**
- Artifacts land in R2 and are delivered as files or images through the channel, never behind a public URL. 15MB per file

Every step of a task is committed to storage before it is shown, so an interrupted process resumes from the last commit rather than the start. Re-sending the same request returns the stored result instead of running it twice.

`web_search` supports Exa (default, no key) / Tavily / Brave / DeepSeek. Their keys are `SEARCH_KEY_TAVILY` / `SEARCH_KEY_BRAVE` / `MODEL_KEY_DEEPSEEK`; switch providers from the desktop Search page.

## Requirements

- A Cloudflare account with `npx wrangler login` already run
- Node.js 22.6+ and npm (Node 26 recommended) — only for the CLI path
- A Telegram bot token from [@BotFather](https://t.me/BotFather), or WeChat via the iLink QR login
- Optional: a model provider key. The default Workers AI model needs none

## Command-line quickstart

```bash
npm install
npx wrangler r2 bucket create my-artifacts
npx wrangler secret put TELEGRAM_BOT_TOKEN
# optional, only if you are not using Workers AI:
# npx wrangler secret put MODEL_KEY_DEEPSEEK
npm run deploy
```

Then set `DESKWAND_CONFIG` (a plain var, not a secret) with your owner IDs and models:

```json
{
  "schemaVersion": 1,
  "owner": { "telegramUserIds": [100000001] },
  "models": {
    "butler": { "provider": "workers-ai", "id": "@cf/google/gemma-4-26b-a4b-it" },
    "task":   { "provider": "workers-ai", "id": "@cf/google/gemma-4-26b-a4b-it" }
  },
  "mcpServers": []
}
```

`100000001` is a placeholder — use your real Telegram user ID.

Model keys follow one rule: `MODEL_KEY_` plus the provider id uppercased, `-` replaced by `_`. So `deepseek` becomes `MODEL_KEY_DEEPSEEK`, `my-proxy` becomes `MODEL_KEY_MY_PROXY`.

## The free tier, precisely

Cloudflare gives every account 10,000 Workers AI neurons a day, shared across all models. The default Gemma 4 26B is enough for a few dozen conversations. The counter resets at 00:00 UTC.

When it runs out, a free account's Workers AI pauses — nothing is charged automatically. On a paid plan it bills at $0.011 per 1,000 neurons.

## The two channels

Only one channel is active at a time; `ACTIVE_CHANNEL` is the single source of truth.

**Telegram** polls for updates itself, so no webhook is needed. Progress messages are edited in place, approvals arrive as buttons.

**WeChat** connects through iLink by scanning a QR code, and is text-only on the wire. Approvals become text commands — reply `批准 t3 ap1` to approve, `拒绝 t3 ap1` to reject, `取消 t3` to cancel. Approval and rejection must name the approval explicitly; the model is never allowed to guess which one you meant.

## Safety

- Only the user IDs in `owner.telegramUserIds` are served. Everyone else gets a 200 and silence.
- Write actions are reviewed before they reach you: routine ones go through, and only high-risk ones — money, deletion, permissions, sending something outward — ask for approval, with the reviewer's reason attached.
- Secrets only ever arrive through `wrangler secret put` or `.dev.vars`, which is git-ignored.
- Logs never contain tokens, credentials, or message bodies.

## Limitations

- The client ships for macOS (Apple Silicon) and Windows. First launch is blocked by macOS Gatekeeper, because the app is not Apple-notarized yet — open System Settings → Privacy & Security → "Open Anyway".
- WeChat goes through iLink, which is not an official bot API.
- Local `npx` stdio MCP servers are not supported; only remote MCP (Streamable HTTP / SSE).
- Backups export to a zip that is **not encrypted**. Treat it like any sensitive file.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

AGPL-3.0. The desktop client and the Worker code are covered. The hosted DeskWand service and its billing are not part of this repository.

---

The [Chinese README](README.md) carries the full maintainer detail: message rendering per channel, the autonomous-bot contract, migration notes, the self-host fallback, and the desktop client's contract with this repository.
