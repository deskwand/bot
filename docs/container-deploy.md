# 用 Docker 部署

这份文档面向没有 Cloudflare 账号、或者想在自己机器上长期运行的情况：同一个 Worker bundle 跑在容器里的裸 workerd 上，不依赖任何 Cloudflare 账号或凭据，数据只存在本地卷里。

Cloudflare 部署仍然是默认形态；容器是并列的另一种部署方式，业务行为一致，差异见文末。

首次安装的逐步命令在 README 的「用 Docker 自己跑」一节（[中文](../README.md#用-docker-自己跑) / [English](../README.en.md#run-it-yourself-with-docker)）；这份文档是它背后的手册。

## 用桌面客户端部署

前提：主机已装 Docker 与 compose 插件，当前用户可以直接执行 `docker`。在桌面客户端欢迎页点「运行在自己的服务器」，按向导填写主机与配置即可。之后在客户端里改配置或密钥会重启容器，约半分钟不可用。

在自己这台 Mac 上也一样：欢迎页选「这台 Mac」，用 Docker 兼容运行时（OrbStack、Docker Desktop 等）或 Apple `container` 都行，不用手写 `compose.yaml` 和 `.env`。

用 Apple `container` 时，文件落在本机目录：默认 `~/Library/Application Support/DeskWand/local`，里面是 `.env`、`run.sh` 和 `logs/launchd.log`；开机启动项是 `~/Library/LaunchAgents/com.deskwand.bot.plist`，容器叫 `deskwand-bot`，数据卷叫 `deskwand-data`。两种运行时的保活方式、`.env` 的权限和断开的后果见 [docs/desktop-client.md](desktop-client.md)。

## 快速开始

1. 把仓库根目录的 `compose.yaml` 和 `.env.container.example` 放到同一个目录（例如 `~/deskwand`），把后者改名为 `.env`。
2. 打开 `.env`，至少填好 `DESKWAND_CONFIG`、`ADMIN_TOKEN` 和一个 `MODEL_KEY_*`，再按入口填 `TELEGRAM_BOT_TOKEN` 或 `WECHAT_CREDENTIALS`。
3. 启动并查看状态：

   ```bash
   docker compose up -d
   docker compose ps
   ```

镜像 `ghcr.io/deskwand/bot` 在打 `v*` tag 时由 CI 构建并推送，tag 是版本号（如 `0.1.52`）和 `latest`，多架构 amd64/arm64，匿名可拉，不用登录 GHCR。还没有发布版本、或想用自己改过的代码时，在仓库根目录自己构建，tag 与 `compose.yaml` 里的保持一致：

```bash
docker build -f container/Dockerfile -t ghcr.io/deskwand/bot:latest .
```

`docker compose ps` 的 `STATUS` 变成 `healthy` 就可以用了（首次启动预计 20–40 秒，这是估计值，未在 Linux 上实测）。日志用 `docker compose logs -f bot`。

## `.env` 各项

必填：

| 变量 | 说明 |
| --- | --- |
| `DESKWAND_CONFIG` | 可管理配置，单行 JSON。整行必须用单引号包住：compose 会去掉单引号，且不做 `$` 插值。`owner` 填你自己的 ID。 |
| `ADMIN_TOKEN` | `/admin/*` 的 Bearer token，用随机长字符串，不要用示例值。 |
| `MODEL_KEY_<ID>` | 至少一个模型 key。`<ID>` 是厂商 id 转大写、`-` 换成 `_`。容器里没有 Workers AI。 |

渠道：

| 变量 | 说明 |
| --- | --- |
| `ACTIVE_CHANNEL` | `telegram` 或 `wechat`。 |
| `TELEGRAM_BOT_TOKEN` | Telegram 入口必填。 |
| `WECHAT_CREDENTIALS` | 微信入口必填，单行 JSON。目前要用仓库里的 `npm run wechat-login` 取得，这一步需要 Node；也可以复制已有的 wrangler secret。 |

可选项：`PUBLIC_BASE_URL`（默认 `http://localhost:8787`）、`SEARCH_KEY_*`、`EMAIL_SECRET_*`、`EXCHANGE_SECRET_*`、`WALLET_PRIVATE_KEY` / `WALLET_OWNER_ADDRESS`。完整条目和说明见 `.env.container.example` 里的注释。

## 沙箱（可选）

沙箱是第二个容器，给任务一台能跑命令的 Linux。不配也能用；配了才有 `sandbox_run`、`sandbox_put`、`sandbox_get` 三条工具。

- 两个容器由同一份 `compose.yaml` 拉起，`sandbox` 容器只拿到 `SANDBOX_TOKEN` 一个变量，不共享 bot 的 `.env`。端口不发布到宿主机，数据在自己的卷 `deskwand-sandbox` 里。
- 容器内是 root，整个根文件系统可写（不然 `apt-get` 装不了东西）。隔离边界就是这个容器：不挂宿主目录、不挂 docker socket、不 `privileged`。
- `/sandbox` 跨任务、跨重启保留；`/tmp`、`apt-get` 装的东西随容器重建消失。
- 磁盘占用只是观测：`SANDBOX_DISK_MB`（默认 10240）到点会在工具里提示，但不是配额，shell 照样写得进去。真正的上限是宿主机磁盘。
- 沙箱里的任何东西都可能被模型发到网上。它本来就拿不到 bot 的密钥，别往里放你自己的。
- 备份**不含**沙箱卷。要清空沙箱：`docker compose down --volumes` 后重新 `up -d`——注意这会把 bot 的数据卷一起删掉，先备份。
- 只在 Docker Compose（本机或 SSH 主机）部署里可用；桌面客户端用 Apple `container` 运行时这一版没有沙箱。
- 没填 `SANDBOX_TOKEN` 时沙箱容器会自己退出（退出码 0），compose 用的是 `restart: on-failure`，所以不会无限重启；bot 那边也拿不到 `SANDBOX_URL`，等于没有沙箱。

## 资源要求

1 核 1 GB 起步，建议 2 GB 内存（估计值，未在 Linux 上实测；镜像大小也未实测）。磁盘占用主要是 `/data` 里的 SQLite 和产物，按实际使用量增长。

## 升级

改 `compose.yaml` 里的镜像 tag（或保持 `latest`），然后：

```bash
docker compose pull
docker compose up -d
```

数据卷原样沿用。不支持降级：新版本写过的数据，旧镜像不保证能读。

## 备份

桌面客户端的「记忆存档」页对容器同样可用：导出、恢复、自动备份都走同一条路，不需要停机打包数据卷。

换一个住处（搬到另一台机器、从 Cloudflare 搬来、搬回）用同一页上的「搬家」：先收拾行李，再在新住处安家，最后安顿。旧住处只会被静音——容器停着，数据卷和 `.env` 都留着——随时能搬回。

`tar` 仍然能手工用，但它产出的东西只有容器读得回来，跨运行方式搬不了：

```bash
docker compose stop
docker run --rm \
  -v "$(basename "$PWD")_deskwand-data:/data" \
  -v "$PWD:/backup" \
  debian:bookworm-slim \
  tar czf /backup/deskwand-data.tar.gz -C /data .
docker compose start
```

卷名是 `<compose 所在目录名>_deskwand-data`；如果目录名被 compose 规范化过，先 `docker volume ls` 确认。恢复时先 `stop`，把归档解回同一个卷，再 `start`。

## 网络

默认只把 8787 映射到宿主机的 `127.0.0.1`，不对局域网或公网暴露。以下情况才需要设置 `PUBLIC_BASE_URL`，并在前面加反向代理和 TLS：

- 使用需要 OAuth 回调的远程 MCP；
- 从别的机器访问 admin 接口。

出站只能访问公网地址，与 Cloudflare 上一致：局域网或宿主机上的服务（例如本机跑的模型、内网的 MCP 服务）连不到。

出站代理：这一版容器内不支持。如果访问 Telegram 或模型 API 需要代理，请在宿主机或网络层做透明代理（TUN 模式、旁路网关等）；workerd 是否读取 `HTTP_PROXY` 没有验证，这里不做承诺。微信渠道和国内模型不受影响。

## 与 Cloudflare 部署的差异

| 项 | 容器部署 |
| --- | --- |
| Workers AI | 没有；必须至少填一个 `MODEL_KEY_*` |
| Telegram 语音 | 不转写（依赖 Workers AI），回「收到了语音，但没能转成文字」 |
| cron | 停机期间错过的 cron 不重放；Durable Object 的 alarm 由 workerd 在恢复后补触发 |
| 实例数 | 单实例，无高可用 |
| 产物 | 存在卷里的 SQLite 中，经 admin 接口读取 |
| 桌面客户端 | 可经 SSH 部署到远程 Linux 主机并管理配置与密钥；MCP、钱包、交易所、备份、升级暂不支持 |

## 不要两边同时跑

同一个 Telegram bot token 不能同时在 Cloudflare 部署和容器里运行：两边会互抢 update，表现为消息时有时无。切换时先停掉一边，再启动另一边。
