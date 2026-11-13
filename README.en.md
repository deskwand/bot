# DeskWand Bot

[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/deskwand-bot)

An agent that lives in your own account. One deployment is one life: its own mission, rules and memory; it picks when to wake next, and every model call is written into a ledger it keeps, so balance, daily burn and runway are always answerable. With a wallet configured it earns the money it wakes on. It stays quiet unless there is something worth telling you.

AGPL-3.0 · [中文](README.md) · [Website](https://deskwand.com/bot?src=gh-readme)

## Up and running in three minutes

If you would rather not touch a terminal, [install the desktop client](https://deskwand.com/bot?src=gh-download) — no Node, no Git, no Wrangler:

1. Sign in with your Cloudflare account (one browser authorization; you never type an account ID or create an API token yourself)
2. Pick a model and a channel. The default is Workers AI with Gemma 4 26B and needs no key. The channel is Telegram or WeChat
3. Deploy. The client creates the resources, uploads the code and activates the version

Then talk to it in the channel you picked. Something like *"read the tech news every morning and tell me if something big happens with models or chips"*.

Command-line deployment, secrets and the `DESKWAND_CONFIG` format are documented further down.

## Run it yourself with Docker

If you do not want a Cloudflare account, you can run the same Worker locally with Docker Compose and keep the data in a local volume. See [docs/container-deploy.md](docs/container-deploy.md).

The container has no Workers AI, so at least one `MODEL_KEY_*` is required. Do not run the same Telegram bot token in both places.

The desktop app can also deploy the same package to a Linux host over SSH, with no Cloudflare account: connect, write the config and start the container from the app.

It can also run it right on this Mac: pick "This Mac" on the welcome page and the app writes the config and the start files for you, with either a Docker-compatible runtime or Apple `container`.

## What it is

- **One deployment is one life.** Mission, rules, memory and ledger all live in that one deployment and export to a single zip. Not a conversation.
- **Keeps its own books.** Every model call is priced and written to the ledger. Balance, daily burn and runway are always answerable, and the desktop app opens on that card. Four tiers: ample, lean, critical, dormant. The poorer it gets, the cheaper it runs: lean and critical switch to a cheaper model, and at zero balance only Cloudflare's free models are left.
- **Earns its own living.** With a wallet configured there is an address on Base; you fund it with USDC. When the balance stops covering 21 days of spend it remits USDC back to you. Until the tier recovers, the livelihood bot trades in one order: protect the principal, then cover its own wake-ups, then grow.
- **Runs in your container.** The Worker, the Durable Objects and the R2 bucket are yours: visible in the dashboard, deletable by you. Messages and tasks never pass through our servers. Cloudflare is one container among several; the same package also runs on Docker or an SSH host.
- **Quiet by default.** No "started" message, no progress, no heartbeat. It speaks only when something actually changed.
- **Spending has a ceiling.** When the Cloudflare free allowance runs out it pauses until 00:00 UTC instead of billing you.

The desktop app groups its sidebar by the parts of that body, matching the chapters below:

| Group | Pages | What is behind it |
|---|---|---|
| — | Vitals | Ledger, balance, daily burn, tier (`LifeDO`) |
| Mind | Mind | The models the butler and tasks use (`models.butler` / `models.task`) |
| Senses | Sight, Voice | Web search; the Telegram or WeChat entry |
| Action | Hands | Remote MCP servers and tools; tasks and bots |
| Livelihood | Wallet, Exchanges | Base wallet and the livelihood bot; read-only exchange snapshots (`WalletDO` / `ExchangeDO`) |
| Containers | Cloudflare, Server, Checkup, Memory, Growth | Worker + Durable Objects; or Docker, an SSH host; diagnostics, backups, updates |

## Architecture

- `ChannelDO` — the channel layer (Telegram long polling, or WeChat iLink polling; a single instance)
- `ButlerDO` — the control path (one global instance: the agent, conversation, memory, task dispatch, on SQLite)
- `TaskDO` — one instance per task: execution, tool calls, approvals, crash recovery
- `BotDO` — one instance per resident bot: its own memory and wake schedule; execution is still delegated to `TaskDO`
- `LifeDO` — the global life ledger: model spend, credits, vitals and tier
- `WalletDO` — the global Base wallet: balances, valuation, automatic remittances and reconciliation
- `ExchangeDO` — the global snapshot store for Binance balances synced from the desktop app
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

## Wallet

She has a wallet on Base mainnet. It stays unconfigured by default and only appears once both the private key and the owner address are set.

Only the owner can configure it, from the desktop client or wrangler; no tool can read or change it:

| Name | Type | Description |
| --- | --- | --- |
| `WALLET_PRIVATE_KEY` | secret | The wallet key, `0x` plus 64 hex characters |
| `WALLET_OWNER_ADDRESS` | secret | Where remittances go; not the zero address and not the wallet itself |
| `DESKWAND_CONFIG.wallet.rpcUrl` | var | Optional Base mainnet RPC; defaults to `https://mainnet.base.org` and must be https |

`wallet.rpcUrl` lives in plain-text configuration, so never put a URL carrying an API key there; use the default public RPC or a URL without a key instead.

A missing or malformed key or address means no wallet: `wallet_status`, the wallet section of the prompt and automatic remittances do not exist, exactly as before the upgrade. The private key, owner address and RPC URL never appear in tool output, prompts or logs; only the wallet address derived from the key can be shown.

### Automatic remittances

When the tier worsens (say from ample to lean), she sends the gap between 21 days of daily spend and the balance in USDC to the owner address: at least $5, capped by the USDC balance. One remittance per tier change; nothing is sent while an earlier transfer is still unconfirmed. The Butler tells the owner once when it is out, or when it failed.

When the owner confirms receipt and includes the remittance id in `life_credit`, the credit is booked as `earned` and the remittance is settled; a credit without an id is still booked as `owner_topup`.

### Asking her

- *"How much is in your wallet?"* (`wallet_status`) — the wallet address, holdings, total value and any pending remittance. Only registered in the owner's butler conversation.

### The earner bot

Within 15 minutes of the wallet being configured, the system creates a "Livelihood" bot by itself (one per deployment); the owner does not have to ask. It cannot be deleted, only paused; its rules can be edited by asking the butler, or by approving a new rulebook the bot proposes during a run.

Its mission is to grow the wallet's total value over the long term: protect the principal first, then earn enough to cover the model fees it spends waking up, and only then pursue growth. On every wake it reviews holdings, prices and recent trades first; without a clear reason it does nothing, and it makes at most one trade per wake; it counts gas and slippage and skips trades that cannot cover them; it writes down the reason before trading and reviews the outcome next time; it respects the risk controls the code enforces; it touches only the coins in its own wallet (remittances are the system's job); it sets its own pace with `set_next_wake`; and it stays quiet, notifying the owner only when the breaker trips, after 3 consecutive losing trades, or when the value falls more than 20% below the principal baseline.

- Wakes: with the default 4-hour interval, the gap it schedules with `set_next_wake` is between 30 minutes and 4 hours (ordinary bots still have a 5-minute floor), and when it does not schedule, or schedules too late, the fallback is the default interval, which moves when the owner changes it with `set_bot_interval`.
- While the wallet is unconfigured or unreadable, or worth under $5, the wake is skipped: no task, no model cost, and no daily wake counted; it checks again in an hour. Once the wallet has money, the earner starts working within about 2 hours at most (an hourly recheck plus the hourly value cache).
- Only its tasks get four extra wallet tools: `wallet_balances`, `market_prices`, `wallet_swap` and `wallet_history`; no other bot and not the butler has a tool that can move money.
- Swaps go only through Uniswap V3 `SwapRouter02`, limited to USDC, WETH and cbBTC, and the recipient is always the wallet itself. Each trade is at or below 25% of the total value, the quote's slippage is at or below 1%, and the router gets an exact-amount allowance.
- When confirmed swaps in the last 24 hours (or since UTC midnight, or since the owner last resumed trading) have realized a 10% loss against the value, the breaker trips and every `swap` is refused. It lifts automatically at the next UTC midnight, or when the owner says "resume trading" and the butler calls `wallet_resume_trading`. Remittances are unaffected.
- Trading stops below $5 of total value, the owner is told once, and topping up resumes it automatically.
- The wallet samples WETH and cbBTC prices at the top of every hour and keeps 30 days; `market_prices` shows the last 24 hours by default.
- The earner still wakes in the critical tier and is held in dormant like every other bot; the doubled lean-tier interval and model downgrade apply to it too.

### Trying it on Sepolia

`scripts/wallet-sepolia.ts` manually exercises the chain reads and writes against Base Sepolia; it is not part of CI. It prints the wallet address, ETH and USDC balances and the quote for 1 USDC into WETH, then builds a 5 USDC (the minimum remittance) transfer to the owner address:

```bash
# Dry run: a throwaway key, signs without broadcasting, moves no real funds
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
  node --use-env-proxy --experimental-strip-types scripts/wallet-sepolia.ts --dry-run --random-key
```

With `--swap` it swaps 1 USDC into WETH instead: it first prints the `to` of both the approve and the swap and the minimum amount out, then prints the `checkSwap` result; a refusal still exits normally. A real swap needs at least 5 USDC in the wallet (the floor is on total value) and 0.002 ETH for gas.

For a real run set `WALLET_PRIVATE_KEY` and `WALLET_OWNER_ADDRESS` and drop `--dry-run`; `SEPOLIA_RPC_URL` is optional and defaults to `https://sepolia.base.org`. With a zero balance the guard refuses and prints the reason, and the script exits normally.

### Backups

Exports and restores include the `remittances`, `trades` and `prices` tables. The private key, owner address and RPC URL are not in the backup. Restoring an old backup with no wallet empties the wallet tables; on-chain assets are unaffected, only the history is lost. A worker that has not been updated yet is exported without a wallet, and a restore leaves that worker's (nonexistent) wallet alone.

A backup made by the new worker carries a `wallet` object. An older desktop client does not understand it and rejects the whole backup; update the client first, then restore.

The wallet is a new `WalletDO` class (migration `v7`, one global instance); it only adds a class and does not touch existing ones. Exchange snapshots are a new `ExchangeDO` class (migration `v8`, one global instance), added the same way.

### Known limitations

- The trust root is the Worker. If the Cloudflare account is compromised, the private key can be exported. Move to an on-chain vault contract once the balance grows.
- Valuation uses the Quoter's spot quote; a large position is worth less than that if actually sold.
- The breaker only sees realized value changes; a price drop on a position that is not sold does not trip it.
- Remittances are denominated in USD; convert yourself when funding in CNY.
- Restoring an old backup can lose a remitted-but-unsettled transfer, and the next tier change may remit again.

## Exchanges

Read-only OKX and Binance keys let tasks read spot, funding, margin and futures balances, valued in USDT. Binance answers 451 to the Worker's egress IP in restricted regions: while the desktop app is running it syncs balances from your own network every five minutes, and the bot falls back to that snapshot — with its source and time — when the Worker is blocked. Keys are written to Cloudflare and, for Binance, also kept in the local keychain for that sync.

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
