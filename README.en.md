# DeskWand Bot

[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/deskwand-bot)

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
- `LifeDO` — the global life ledger: model spend, credits, vitals and tier
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

## Life and metabolism

She keeps her own books and never queries a provider's balance. Every model call is priced from the model's rates and written to a ledger; top-ups and calibrations the owner reports are written too. Nothing changes until the owner first says *"I put $X on your account"*: until then the models, wake intervals and prompts are exactly as before. Spend recorded before the first credit stays in the ledger, still feeds daily spend and the first-spend time, but is never charged against the balance.

Balance = credits − spend recorded at or after the first credit. Daily spend is the last seven days divided by the number of days (at least one); runway = balance ÷ daily spend. Everything is in USD, and prices are per million tokens. Workers AI calls still record their token counts but at $0, so they never reduce the balance — Cloudflare owns that free allowance.

### The four tiers

Tiers depend only on the balance and the runway. The thresholds are constants in the code, not configuration:

| Tier | Condition | Behaviour |
|---|---|---|
| ample | runway ≥ 14 days | everything carries on as usual |
| lean | 3 ≤ runway < 14 days | bot wakes stretch to twice their interval; tasks and bots use the frugal model |
| critical | runway < 3 days and balance > 0 | bots stop waking on their own (they recheck the tier hourly); the butler uses the frugal model too |
| dormant | balance ≤ 0 | everything runs on the default free Workers AI model; bots stop waking on their own (same hourly recheck) |

Dormant is checked first, then the other three by runway. A failed read of the ledger counts as ample, and any ledger failure is logged — it never fails a model call or stops the butler replying. Manual wakes, pauses and deletions ignore the tier.

Holding a bot does not change its `status`: it rechecks the tier every hour and runs again on the first check after the tier recovers.

A tier change is announced once and never repeated within the same tier: after spend only a worse tier speaks; after a credit or calibration any change does.

### Talking to her

- *"How much longer can you live?"* (`life_vitals`) — balance, daily spend, runway, tier, the model each role is actually using, and where the money went (sources are grouped: all task runs collapse to `task`, each bot stays separate).
- *"I put $20 on your account"* (`life_credit`) — records the top-up. The first credit starts the metabolism.
- *"Calibrate the balance to $12"* (`life_calibrate`) — writes an adjustment row so the books match the balance you report.

The tools exist only in the owner's butler conversation; tasks, bots and bot chats never get them.

### The frugal model

`DESKWAND_CONFIG.models.frugal` is the model tasks and bots use in the lean tier, and the model every role uses in critical. Without it, those tiers only stretch or pause bot wakes.

```jsonc
{
  "models": {
    "butler": { "provider": "opencode-go", "id": "deepseek-v4.1-flash" },
    "task": { "provider": "opencode-go", "id": "deepseek-v4.1-flash" },
    "frugal": { "provider": "workers-ai", "id": "@cf/google/gemma-4-26b-a4b-it" }
  }
}
```

A custom provider's model must carry its own price; a model without `cost` is recorded at zero and flagged as unpriced:

```jsonc
{
  "models": {
    "customProviders": [
      {
        "id": "my-proxy",
        "api": "openai-completions",
        "baseUrl": "https://proxy.example.com/v1",
        "models": [
          {
            "id": "gpt-5.6",
            "cost": { "input": 0.6, "output": 2.4, "cacheRead": 0.15, "cacheWrite": 0.6 }
          }
        ]
      }
    ]
  }
}
```

### Backups

Exports and restores include the ledger (spend, credits, running totals and the hourly rollup) and the last notified tier. Restoring a backup from before the ledger empties it: the deployment is ample and the metabolism has not started. A worker that has not been updated yet is exported without a ledger, and a restore leaves that worker's (nonexistent) ledger alone.

A backup made by the new worker carries a `life` object. An older desktop client does not understand it and rejects the whole backup; update the client first, then restore.

### Known limitations

- The ledger is USD only. For a provider that bills in CNY, convert the top-up yourself before reporting it.
- In the dormant tier, if moving a role to Workers AI would shrink its context window more than fourfold, the role keeps its paid model and keeps spending; the balance can go negative. `life_vitals` shows the model each role is actually using.
- `life_credit` and `life_calibrate` run without an approval step. They exist only in the owner's butler conversation, but text the butler reads could still talk her into writing a row; correct it with a calibration.
- Deferred calls and image generation are not metered, so the real spend may be higher than the books show; `life_vitals` says so when it sees an unpriced model.

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
