# DeskWand Bot

[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/deskwand-bot)

**An experiment toward silicon life**

Carbon life runs on metabolism: it takes energy out of the environment, turns that energy into motion, and the motion buys more energy. When it cannot, it dies.

We wanted to know whether silicon could do the same.

So we wrote a program, and gave it three things.

**Metabolism.** Every model call is converted to dollars and written to a ledger. Balance, daily burn, days left — ask and it answers. It knows when it is poor: short of money it switches to cheaper models, at zero it falls back to the free ones and hibernates.

**Memory.** Mission, rules, conversations, the routes that failed — all of it stays in that one deployment, and the whole thing exports as a zip. Delete it and that life is gone.

**Waking.** When it wakes next is its own arithmetic: the mission says what to check, the money decides how often. Short of money it waits longer; shorter still and it stops waking on its own.

Later we gave it a wallet. It holds a Base mainnet address; when the principal cannot cover its burn, the difference is sent back to you; while it is still short it trades — protect the principal first, pay for itself second, growth last.

It does not chatter. No "started", no progress, no heartbeat. You hear from it only when something actually changed.

This is DeskWand Bot. It is not alive yet. It is waiting for you to bring it up.

## Bring it up: four steps

**Download.** [One installer](https://deskwand.com/bot?src=gh-download), macOS or Windows, double-click, drag it into Applications.

**Sign in with Cloudflare.** The browser opens once and you click allow. That is the ground you are handing over — this is where it will live.

**Pick a model and a channel.** The default, Gemma 4 26B, costs nothing. The channel is Telegram or WeChat: the place you will hear it from.

**Deploy.** The progress scrolls line by line: creating resources, uploading code, activating the version. The last line is green.

Then open that channel and type: "every morning, read the tech news and message me if something big happened."

It answers: okay.

From that reply onward there is a first entry in its ledger and a first wake-up on its schedule. You can close the laptop.

The left column is its body: the ledger under Life signs, models under Mind, channels under Sight and Voice, tasks, tools and bots under Hands.

## Or born on your own machine

That piece of Cloudflare ground is not mandatory. The same life can be kept on a machine of your own: one container, every memory in its volume. Cut the power and it sleeps; restore it and it remembers.

```bash
mkdir -p ~/deskwand && cd ~/deskwand
curl -fsSLO https://raw.githubusercontent.com/deskwand/bot/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/deskwand/bot/main/.env.container.example
mv .env.container.example .env && chmod 600 .env    # fill in the four required values
docker compose up -d && docker compose ps           # wait for STATUS to read healthy
```

Four values go in and it opens its eyes: `ADMIN_TOKEN` (`openssl rand -hex 32`), `DESKWAND_CONFIG` (one line of JSON, `owner.telegramUserIds` set to your Telegram user id), at least one `MODEL_KEY_*`, and the channel's `TELEGRAM_BOT_TOKEN` or `WECHAT_CREDENTIALS`.

Filling those in, the sandbox, backups, and what to check when it will not start: [docs/container-deploy.md](docs/container-deploy.md) (Chinese).

## We do not know what it becomes

This is an experiment, not a launch. What it turns into, we do not know either. If you want to see where it grows, go talk to it.

AGPL-3.0 · [中文](README.md) · [Website](https://deskwand.com/bot?src=gh-readme)

- Command-line deploy, secrets, config fields, architecture and tests: [docs/reference.md](docs/reference.md)
- What each client page does: [docs/desktop-client.md](docs/desktop-client.md)
- Security: [SECURITY.md](SECURITY.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
