# open-compute 部署可行性 spike

日期：2026-11-06。本机 macOS 27.0.1 (arm64)，`ocd` 0.4.0（workerd 2026-09-30 分支，`binary_maximum_date` = 2026-10-07），`cf` 1.0.0-beta.12，`@cloudflare/vite-plugin` 2.0.0-beta。

结论：**平台层能跑，业务层没跑**。部署、Durable Object（SQLite）、Cron、R2、secrets 全部验证通过；Workers AI 推理在自托管上不存在；业务层没验证是因为不能接生产 Telegram token，也没配模型 key。

测试在 `git worktree` 的临时副本里做（HEAD 的 `feat/artifact-delivery`），仓库零改动，worktree 用后删除。测试期部署的 worker 名 `bot`、实例数据，测完已清空。

## 方法

1. `cf migrate ./wrangler.jsonc --bundler vite --force` 生成 `cloudflare.config.ts`（7 条 TODO）。
2. 手工补：DO 生命周期改成 `exports.durableObject({ storage: "sqlite" })`、`workersDev: false`、`compatibilityDate` 降到 2026-10-07、删掉 `bindings.ai({})`（后来单独复测过它其实能留）。
3. `cf workers types` → `cf build --mode production`（vite + rolldown）。
4. `ocd cf --project <dir> deploy --prebuilt --mode production`。
5. 用实例的 `/client/v4` 管理 API 和 `workers/observability/telemetry/query` 验证运行时。

## 结果

| 验证项 | 结果 | 依据 |
| --- | --- | --- |
| 构建 | 通过 | bundle 4.66 MB / gzip 923 KB，上传 9604 KiB / gzip 2312 KiB（平台上限 `workers.max_bundle_bytes` = 34 MiB） |
| 部署 | 通过 | 需要 `workersDev: false`，见下 |
| Durable Object（5 个，SQLite） | 通过 | `data/do/workerd/open-compute-do-host-v1/*.sqlite` 里出现业务表：`tasks`、`task_events`、`bots`、`memories`、`schedules`、`pi_documents`、`pi_tasks`、`approval_messages`、`admin_maintenance` |
| agents SDK 建表 | 通过 | 同库内有 `cf_agents_*`（state / runs / task_runs / jobs / fibers / workflows） |
| DO Alarms | 机制在，未测真实唤醒 | 库内有 `__open_compute_do_alarm` |
| Cron `* * * * *` | 通过 | 部署输出 `Deployed bot triggers`；日志持续出现 `origin=scheduled` |
| R2 写 + 读 | 通过 | 经 `/a/probe.txt` 返回 200，`content-type`/`content-security-policy`/`x-content-type-options` 与代码一致 |
| secrets 注入 | 通过 | `ADMIN_TOKEN` 错 token → 401 `ADMIN_UNAUTHORIZED`，对 token → 走到 `/admin/backup/info` 的 409 `MAINTENANCE_REQUIRED` |
| `nodejs_compat` | 通过 | worker 正常加载并处理请求 |
| `env.AI` binding | 能准入、能注入 | 部署绑定列表出现 `env.AI (AI)` |
| Workers AI 推理 | **不可用** | 产品面只有 `toMarkdown` 与 AI Search，`packages/runtime/src/ai/facade.ts` 的 `Ai` 类没有 `fetch` |

## 部署时必须改的

1. **`workersDev` 默认 true → 501 `[9100007] capability not supported`**。必须显式 `workersDev: false`。原因是 cf 会去开 `<name>.<subdomain>.workers.dev`，脚本级 `/subdomain` 端点虽是 `supported`，但实测同样返 9100007。
2. **`compatibilityDate` 不能超过 runtime**。`ocd capabilities --json` → `runtime.compatibility.binary_maximum_date`，本版本是 `2026-10-07`，且 `future_dates_allowed: false`。仓库现值 `2026-11-01` 会被拒。
3. **本机 origin 是 `{worker}.{instance_id}.localhost:8787`**，不是 `127.0.0.1:8787`。根路径与错误 Host 都返回空的 404，容易误判成"没部署成功"。映射见 `crates/storage/src/worker_repository.rs` 的 `format!("{worker_name}.{instance_id}.localhost")`。

## 部署口径上的差异

1. **配置格式不通用**。`wrangler.jsonc` 与 `cloudflare.config.ts` 是两套，`cf migrate` 只能单向迁，且要求 git worktree 干净（否则 `--force`）。它不迁 `keep_vars`，`upload_source_maps` 要改由 vite `build.sourcemap` 承担，DO migrations 必须换成 `exports` 生命周期声明。
2. **R2 bucket 不自动建**。wrangler 会在部署时自动创建，这里不会：缺桶时部署报 `[9100004] the requested resource was not found`，要先 `cf r2 buckets create --name <bucket>`。
3. **Cron 语义**：停机期间错过的触发只补最近一次，不重放全部；失败按配置有限次重试。本仓库的 cron 承担渠道保活与 bot heal，停机恢复后只补一次是可以接受的。
4. **模型通道**：自托管上必须配 key 型 provider（`MODEL_KEY_<ID>`）。不改代码：`workersAiBindingReady()` 依赖 `env.AI.fetch`，facade 没有该方法，所以自动返回 false，走 `modelReadiness` 已有的"Workers AI 不可用"提示。

## 环境前提（不是平台限制）

磁盘用到 95% 会触发 DO 停写：新对象创建一律 `DO_STORAGE_LIMIT`（`crates/service/src/binding_backend/handlers.rs` 的 `disk_stop_writes_percent`，默认 95）。这台 Mac 当时 98%（5.8 GB 可用），cron 每分钟都失败。临时把 `[durable_objects] disk_stop_writes_percent` 调到 99 才验证通过，测完已改回 95。

`ocd` 不会为此自动降级或提示原因，只会在 `system/status` 里把 `data_dir` 标成 `DISK_HARD_LIMIT` / `DISK_SOFT_LIMIT`。要在磁盘紧张的主机上自托管，先腾空间。

## 没验证的

- Telegram 真实收发：会抢生产实例的长轮询 update，按约定没接。
- BotDO alarm 的真实唤醒与 TaskDO 崩溃恢复：需要跑真实会话。
- Workflows、Queues、WebSocket hibernation：本仓库不用，没测。

## 复现

```sh
curl -fsSL https://open-compute.dev/install.sh -o /tmp/oc.sh   # 直连 GitHub 大文件会被限速，
sh /tmp/oc.sh                                                  # 必要时换镜像并核对 SHA256SUMS
ocd setup --yes && ocd status

npm install --save-dev cf@1.0.0-beta.12 "@cloudflare/vite-plugin@2.0.0-beta.sha-52b0dc0e9" vite
npx cf migrate ./wrangler.jsonc --bundler vite --force
# 按上文三处必改项修 cloudflare.config.ts，补 vite.config.ts
npx cf build --mode production
ocd cf --project "$PWD" deploy --prebuilt --mode production
```
