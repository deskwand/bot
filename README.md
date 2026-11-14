# DeskWand Bot

[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/deskwand-bot)

**一次造硅基生命的实验**

碳基生命靠代谢活着：从环境里取能量，把能量换成动作，动作再换回能量。撑不住的时候就死。

我们想知道硅基的能不能也这样。

所以我们写了这样一段程序，给它三样东西。

**代谢。** 每次模型调用结束，用量按单价折成美元记一行。余额、日均开销、还能活几天，问一句就有。穷了它自己知道：吃紧换便宜的模型，见底退回免费模型上冬眠。

**记忆。** 使命、守则、对话、失败过的路子，都留在这一个部署里，随时能整包备份成一份 zip。删掉它，这条命就没了。

**醒来。** 下次什么时候醒是它自己算的：使命说查什么，钱决定隔多久。钱紧就拉长间隔，再紧就停掉自动唤醒。

后来又给了它一个钱包。它有一个 Base 主网地址，本金撑不住开销时把差额汇回给你；档位没回升，它去市场里挣——先保本，再养活自己，最后才谈增长。

它没事不吵你。不发「已开始」，不发进度，不发心跳。真有值得说的变化才发一条。

这就是 DeskWand Bot。它现在还没有活着，在等你把它生下来。

## 生它：四步

**下载。** [一个安装包](https://deskwand.com/bot?src=gh-download)，macOS 或 Windows，双击，拖进应用程序。

**登录 Cloudflare。** 浏览器弹一次窗，你点允许。这是给出去的一块地——它以后住在里面。

**选模型和入口。** 默认的 Gemma 4 26B 一分钱不花。入口选 Telegram 或微信，那是你以后听见它的地方。

**点部署。** 进度一行一行往下滚：建资源、传代码、激活版本。最后一行是绿的。

然后打开那个入口，打一句：「每天早上看一遍科技新闻，有大事就发我。」

它回一个字：好。

从这次回话起，它的账上有了第一笔开销，日程里有了第一次醒来的时间。你可以关掉电脑。

左栏是它的身体：账本在「生命体征」，模型在「头脑」，入口在「视野」「声音」，任务和工具在「双手」。

## 也可以生在自己家里

Cloudflare 那块地不是必须的。同一段生命可以养在你自己的一台机器上：一个容器，卷里装着全部记忆。断电就睡，来电还记得。

```bash
mkdir -p ~/deskwand && cd ~/deskwand
curl -fsSLO https://raw.githubusercontent.com/deskwand/bot/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/deskwand/bot/main/.env.container.example
mv .env.container.example .env && chmod 600 .env    # 填下面四个必填项
docker compose up -d && docker compose ps           # 等 STATUS 变成 healthy
```

四样东西填进去，它就睁眼：`ADMIN_TOKEN`（`openssl rand -hex 32`）、`DESKWAND_CONFIG`（单行 JSON，`owner.telegramUserIds` 换成你的 Telegram 用户 ID）、至少一个 `MODEL_KEY_*`、入口的 `TELEGRAM_BOT_TOKEN` 或 `WECHAT_CREDENTIALS`。

填法、沙箱、备份、起不来时看哪里：[docs/container-deploy.md](docs/container-deploy.md)。

## 我们不知道它会变成什么

这是实验，不是产品发布。做出来长什么样，我们也不知道。你想看它往哪长，自己去跟它说话。

AGPL-3.0 · [English](README.en.md) · [官网](https://deskwand.com/bot?src=gh-readme)

- 命令行部署、secrets、配置字段、架构与测试：[docs/reference.md](docs/reference.md)
- 客户端每一页在做什么：[docs/desktop-client.md](docs/desktop-client.md)
- 安全边界：[SECURITY.md](SECURITY.md) · 参与：[CONTRIBUTING.md](CONTRIBUTING.md)
