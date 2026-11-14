# 自托管备份：Cloudflare 为主，Miniflare 兜底

- 日期：2026-11-06
- 状态：运行时选型已被容器部署取代（裸 workerd，见 `docs/container-deploy.md`）；§8 的待做项 A 已由容器部署完成，B、C 仍未做
- 范围：部署形态。`src/` 不改。

## 1. 决策

| 项 | 结论 |
| --- | --- |
| 主路径 | Cloudflare Workers，不变 |
| 防供应商锁定的兜底 | Miniflare + workerd，跑同一份构建产物 |
| open-compute | **放弃**（评估记录见 §2） |
| 双活 / 双跑 | **不做** |

目标不是"零停机"，是"Cloudflare 这条服务不可用时，数据搬得走、服务起得来"。

## 2. 为什么放弃 open-compute

它能把这份 Worker 完整跑起来，业务代码零改动。拒绝的原因是开销与收益不匹配：

- 二进制 169 MB，外加首次 setup 就要约 370 MB 实例数据（内嵌 runtime、OCR 语言包、缓存）。
- 磁盘到 95% 触发 DO 停写，新对象一律 `DO_STORAGE_LIMIT`，且只在 `system/status` 里标 `DISK_*_LIMIT`，不给原因。
- 需要第二套配置体系：`cloudflare.config.ts` + `cf 1.0.0-beta.*` + vite 插件，与 `wrangler.jsonc` 不通用；DO migrations 必须改写成 `exports` 生命周期声明。
- 数据要跨平台迁移，得走它自己的实例格式。

换来的能力是运维面（仪表盘、多实例、备份、权限），这份文档描述的场景一个都不需要。

## 3. 为什么 Miniflare 成立

1. **同一运行时**。Miniflare 底下就是 workerd——生产用的那个。DO 请求串行、alarm 到期与重放、崩溃后的 SQLite 恢复，全在运行时里，不用自己实现。
2. **备份一直在被验证**。`vitest-pool-workers` 底座就是 Miniflare，`tests/` 下 86 个文件、25,596 行每天在它上面跑。换别的宿主，这批测试就失去意义。
3. **数据搬迁已经有实现**。`src/admin/backup-rpc.ts` 与 `src/admin/sql-dump.ts` 提供 `/admin/backup/{info,schema,page}`、`/admin/r2/<key>`、`/admin/restore/{begin,page,commit,reset}`，且 `BackupRpc` 只依赖 `DurableObjectState`，不碰业务代码也不碰 Agents SDK——**同一套协议在 Cloudflare 与本地都能跑**，导入导出是同一份代码。

覆盖范围：`ButlerDO`、`TaskDO`、`BotDO`、`ChannelDO`、`LifeDO`、`WalletDO` 的 SQLite 与 KV，以及 R2 对象。`McpAuthDO` 不参与备份，切到本地后 MCP 授权需要重新走一遍。

## 4. 实测数字

本机 macOS 27 arm64，miniflare 4.20260730.0 / workerd 1.20260730.1。

| 项 | 数值 |
| --- | --- |
| 干净 `npm install miniflare` | 160 MB（workerd 二进制 109 MB + miniflare 22 MB，共 26 个包） |
| 本仓库内 | workerd 135 MB + miniflare 26 MB + esbuild 10 MB，已在 devDependencies 中，自托管不新增依赖 |
| 常驻内存 | node 135.5 MB + workerd 52.4 MB ≈ **188 MB**（1 worker + 1 SQLite DO + R2，空闲） |
| DO 磁盘 | 每个实例 SQLite **4 KB 起**，另有 `metadata.sqlite` |

一台 1 核 1 GB 的机器可以跑，2 GB 很宽松。

已验证跑通的链路：`ctx.storage.sql` 建表读写、R2 `put`/`get`、落盘持久化、`GET /cdn-cgi/local/scheduled` 返回 200（即 `scheduled()` 入口）。

## 5. 已知限制与坑

1. **官方定位是开发工具**，不为生产用法担保。当成"降级可用"的兜底，不要当成第二种生产形态。
2. **版本三件套必须锁死**：`compatibility_date` ≤ 所用 workerd 支持的上限。实测干净装到的 miniflare 4.20260730.0 只支持到 `2026-08-06`，用仓库里的 `2026-11-01` 会直接启动失败。三者不能各升各的。
3. **persist 路径不能含 symlink**。macOS 上 `/tmp` 指向 `/private/tmp`，workerd 启动即崩：`can't use ".." to break out of starting directory`。路径要用真实路径。
4. **Miniflare 4 没有 `dispatchScheduled()`**，cron 靠外部 ticker 请求 `/cdn-cgi/local/scheduled`。5.x 才有该方法，但 5.x 目前是 beta/alpha。
5. **没有 Workers AI 推理**，模型必须走 `MODEL_KEY_*`（`workersAiBindingReady()` 会自动降级，不需要改代码）。
6. **cron 停机不重放**，恢复后最多补最近一次。
7. **单进程、无 HA**，靠 systemd / launchd 做重启。

## 6. 纪律

1. **同一时刻只能一边在线**。两个实例同时轮询 Telegram，update 会被随机抢走，表现为消息时有时无，极难排查。切换必须显式。
2. **不做双跑**。兜底模式是降级可用：能收消息、能答、能跑任务、能出产物；没有 Workers AI，cron 不重放。

## 7. RPO

默认：**每小时自动导出一次**，RPO = 导出间隔（最坏丢一小时）。

| 想防的情况 | 数据策略 |
| --- | --- |
| Cloudflare 宕机，几小时内要能用 | 定时导出 + 一键导入（推荐） |
| 账号不可用，几天内要能走 | 按需导出 |
| 接近零丢失 | 不做（需要双写，与 §6 冲突） |

## 8. 待做

| 项 | 内容 | 量级 |
| --- | --- | --- |
| A | ~~本地启动器：Miniflare + 持久化路径 + cron ticker + 锁定的版本三件套~~ 已由容器部署完成，见 `docs/container-deploy.md` | ~150 行 |
| B | CI 演练：起本地实例，用同一备份协议灌 fixture，断言能读到会话 / 任务 / 产物 | ~80 行，仍未做：CI 里没有 Docker，先按下文清单人工跑 |
| C | ~~切换手册~~ 由「搬家」流程与下文清单承担，见 `docs/superpowers/specs/2026-11-14-residence-move-design.md` | 完成 |

B 是关键：让"备份可用"变成每次提交都在验证的事实，而不是半年后才发现已经坏了的东西。

## 9. 搬家演练清单

1. 在源住处「记忆存档 → 搬家」（收拾行李），记下备份文件大小。
2. 在 SSH 主机上安家，`docker compose ps` 为 `healthy`。
3. 回到「记忆存档 → 安顿」，等进度走完。
4. 在新住处确认：能收一条消息、任务列表还在、`get_artifact` 能读回旧产物、生命体征里的余额与日均开销没归零。
5. 杀掉客户端再打开：住处卡显示「上一处」，`move.json` 里是 `done`。
6. 搬回旧屋：旧住处立刻回消息（`ACTIVE_CHANNEL` 已恢复，容器已 `start`）。
7. 再搬一次，在第 3 步中途 Ctrl-C：重开后能继续安顿；删掉行李文件则报 `MOVE_ARCHIVE_MISSING`，而不是拿空备份覆盖新住处。
