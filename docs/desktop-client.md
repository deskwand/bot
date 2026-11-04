# DeskWand Bot 桌面客户端

DeskWand Bot 是一个 macOS / Windows 桌面客户端，用来在你自己的 Cloudflare 账号中部署、配置和维护一套云端服务。安装客户端后不需要 Node.js、Git、Wrangler 或 Go。

客户端只负责管理：**关闭客户端后，已经部署的 Worker、Durable Object、R2 数据和消息收发都会继续运行。** 客户端不会在后台自动升级云端，也不会替你执行 Cloudflare Dashboard 中的其它操作。

## 1. 安装

### macOS

1. 打开 `deskwand-bot-<版本>-<架构>.dmg`。
2. 把 **DeskWand Bot** 拖到“应用程序”。
3. 首次打开时，如果 macOS 提示无法验证开发者，说明该构建没有 Developer ID 签名或未经过 Apple 公证。

内部测试构建默认使用 ad-hoc 签名，只适合在构建它的机器或明确的测试环境中使用；它不能被当作可公开分发的正式发行版。正式发行需要 Developer ID 签名与公证，见“维护者”一节。

系统要求：macOS 12.0 或更高。

### Windows

1. 运行 `deskwand-bot-setup-<版本>-amd64.exe`。
2. 安装器按当前用户安装，不需要管理员权限。
3. 系统要求：Windows 10 或更高，并需要 **Microsoft Edge WebView2 Runtime**。Windows 11 通常已内置；Windows 10 若缺少该运行时，应用页面无法渲染。

MyGo 0.7.4 的 NSIS 安装器不会自动下载或安装 WebView2。若打开后是空白窗口，请先从 Microsoft 官方页面安装 **Evergreen WebView2 Runtime**，再重新打开客户端。该行为未在 Windows 真机上验收，详见 `docs/verification/desktop-acceptance.md`。

### 首次启动

客户端不包含任何账号、令牌或生产凭据。第一次启动会显示欢迎页，要求你连接自己的 Cloudflare 账号。

## 2. 连接 Cloudflare 账号

在欢迎页点「使用 Cloudflare 登录」，浏览器会打开 Cloudflare 授权页。登录你的 Cloudflare 账号并允许访问，回到客户端即可自动继续。

- 不需要填写账号 ID，也不需要手动创建 API token。
- 授权页会列出客户端需要的权限：Worker 脚本、Worker R2 存储、账号信息、运行日志（诊断用）。
- 凭据保存在系统凭据库中：macOS 为登录钥匙串，Windows 为凭据管理器。客户端不会把凭据写进普通配置文件或日志，前端也不会读取它们。
- 授权可以随时在 Cloudflare 的 **我的个人资料 → 访问管理 → 已连接的应用** 中撤销；撤销后客户端会提示重新登录。
- 需要更换账号时，点侧栏底部的 **退出登录**，在确认框里退出。这只会撤销本机的授权并清除本机凭据：云端服务继续运行，已选的部署和已发布的密钥都留在本机，重新登录后可以继续管理。

登录后客户端会换取短期访问令牌并自动续期。续期失败时概览页会提示「Cloudflare 授权已过期，请重新登录」；云端服务不受影响，重新登录即可，不需要删除或重装云端部署。

## 3. 部署新服务或连接已有服务

### 部署新服务

1. 选择 **部署新服务**。
2. 填写 Worker 名称、R2 桶名称、允许使用的 Telegram 用户 ID，以及管家模型和任务模型。
3. 选择初始消息入口（Telegram 或微信）。
4. 点击 **检查并部署**。

部署过程会创建或复用资源、上传签名过的 Worker 发布包、设置普通变量和 secrets，并激活部署。任何一步失败都会显示明确状态；结果未知时使用顶部的“继续操作”，客户端会先核实远端状态，不会盲目重复写入。

首次部署后，云端还没有完成真实消息验证。界面不会因为控制面发布成功就显示“收发已验证”。

### 连接已有服务

1. 选择 **连接已有服务**。
2. 从当前账号的 Worker 列表中选择目标。
3. 客户端读取现有设置、secrets 名称、版本和迁移历史，并给出导入预览。

导入分为两类：

- 已经带有 `DESKWAND_CONFIG` 的部署：保留未编辑字段、secrets 和资源；发现明文凭据时要求你重新输入为 secret，不会把值复制到普通变量。
- 旧版把 owner / 模型写在源码里的部署：源码配置无法读取，需要重新填写 owner 和角色模型；MCP 服务器从空列表开始。

客户端不会执行下载的 Worker 代码来猜测配置。遇到未知 bindings、多个同时接收流量的版本或无法安全保留的设置时，会停止编辑并说明原因。

## 4. 消息入口：同一时间只启用一个

设置页叫 **消息入口**。`ACTIVE_CHANNEL` 是唯一权威，只能是：

- `telegram`
- `wechat`

同一时间只启用一个入口。客户端不会自动切换，也不会跨渠道提醒。保存未选中的渠道凭据不会启用它；只有明确选择并发布入口后才会改变云端行为。

### Telegram

需要 BotFather 提供的 Bot Token。客户端会验证 `getMe`，发布 `TELEGRAM_BOT_TOKEN`，并在需要时生成、发布 `TELEGRAM_WEBHOOK_SECRET` 后设置 webhook。已有不可读的 webhook secret 默认保留；只有明确选择轮换时才重新生成。

### 微信

点击 **连接微信** 后显示 iLink 二维码。扫码、手机确认、过期和取消都在客户端中显示。登录成功后凭据作为 secret 发布；二维码过期需要重新发起，取消后迟到的确认不会覆盖新操作。

选择了一个尚未配置凭据的入口是允许的，但界面会警告该入口暂时不可用；客户端不会自动回退到另一个渠道。

## 5. 模型与模型 key

新装默认模型是 `workers-ai` / `@cf/google/gemma-4-26b-a4b-it`（Gemma 4 26B）。`workers-ai` 是内置的免 key 厂商：通过部署里的 `AI` binding 调用，不读取任何 `MODEL_KEY_*` secret。安装向导的模型步骤和模型页都默认选中它。

选中 Workers AI 时不显示密钥输入框，改为显示免费额度说明：「使用你 Cloudflare 账号每天 10,000 neurons 的免费额度，用完后 UTC 0 点重置；超出后免费账号会暂停，付费账号按量计费。」因为没有密钥行，也不会出现「测试连接」按钮。模型下拉里 Workers AI 的纯文本模型会标注「不支持图片」，默认的 Gemma 4 26B 支持图片。

已有部署的模型配置不迁移，也不会提示切换；要继续用原来的厂商就保留原配置，想用默认模型时在模型页手动切换。

除免 key 的 `workers-ai` 外，模型厂商的 key 都存成 secret，名字是 `MODEL_KEY_<ID>`：`<ID>` 是厂商 id 转大写，`-` 换成 `_`。例如：

- `opencode-go` → `MODEL_KEY_OPENCODE_GO`
- `deepseek` → `MODEL_KEY_DEEPSEEK`
- 自定义端点 `my-proxy` → `MODEL_KEY_MY_PROXY`

内置厂商（`workers-ai` 除外）和自定义 OpenAI / Anthropic 兼容端点都遵循同一规则。旧的 `ANTHROPIC_API_KEY`、`OPENCODE_API_KEY` 不再读取；升级后需要在新版本客户端的模型页重新填写对应的 `MODEL_KEY_*`。

升级旧部署前，更新页的确认框会列出升级后缺失、需要重新填写的 key（“升级后需要在模型页重新填写这些 key：…”）。提示不会拦住升级，但 key 没填好之前，管家和任务会直接回复“模型 … 没有配置 key（…），请在桌面端模型页填写”，不会进入模型调用。

“保存并发布”前会检查管家和任务引用的模型厂商是否都已有对应的 `MODEL_KEY_*` secret，或者本次发布是否会写入它。缺失时发布会以 `MODEL_KEY_MISSING` 被拒绝，并列出缺的 secret 名。这项检查会跳过免 key 厂商，所以两个角色都用 Workers AI 时不需要任何 key。首次安装不做这项检查：需要 key 的厂商在安装完成后到模型页填写，Workers AI 不需要。

## 6. “保存并发布”到底做什么

模型、owner、MCP 或 secret 的修改都通过 **保存并发布** 提交，不是即时热更新。发布流程大致是：

1. 校验配置 schema、模型引用和 secret 编辑；
2. 核对云端配置指纹，拒绝用旧草稿覆盖新值；
3. 上传新版本（仅配置 / secret 变更）或执行带迁移的脚本上传；
4. 激活 100% 流量部署；
5. 重新读取部署，核对版本和结果。

因此：

- 发布成功表示控制面和部署状态已核对，**不保证**业务立即恢复、微信立即开始轮询或五分钟内一定生效；
- 涉及 Durable Object 迁移时，客户端不会承诺零中断；
- 结果未知时先“继续操作”核实，不要重复点击；确认不再继续时可使用“放弃”，它只取消客户端待处理记录，不删除已创建的云端资源；
- 如果其它人同时在 Cloudflare Dashboard 修改配置，客户端可能提示 `CONFIG_CONFLICT`，需要重新加载后再提交；
- 外部只替换同名 secret 的值时，客户端可能无法从指纹察觉；发布确认页会说明这一限制。

## 7. 状态：未知、未验证、已验证

状态来自不同证据，不能混为一谈：

| 状态 | 含义 |
| --- | --- |
| 未知 / 无证据 | 没有当前版本的 Cloudflare 日志，或日志未保存、被采样、已过期。缺失证据不等于故障，也不等于成功。 |
| 未验证 | 已经配置，或只完成了本机测试；还没有当前云端版本的收发证据。 |
| 已验证 | 有当前版本、当前渠道、对应时间范围内的云端事件证据，例如收到轮询响应或成功发送消息。 |
| 用户确认 | 你手动确认“我收到了消息”。它标记为用户证据，不计作云端日志验证。 |

模型的本机探测只证明“这台机器用这个密钥能访问提供商”，不代表云端 Worker 已经使用该密钥成功处理消息。界面会显示来源和观察时间。

## 8. 数据备份与恢复

“数据备份”页把当前部署的云端业务数据导出为一个本地 `.zip`，也可以从这个文件整体恢复。备份文件由当前客户端直接读写，云端不会长期保存副本。

### 8.1 导出包含什么

- `ButlerDO` 的全部业务表：记忆、对话与 Pi 会话、定时任务、任务清单与事件、审批消息、元数据，以及 Agents SDK 的 Durable Object KV 状态（作为伪表一并导出）；
- 每个 `TaskDO` 的全部业务表与任务事件；
- `ChannelDO` 的 owner 地址、微信登录状态与微信会话上下文；
- R2 `ARTIFACTS` 中的任务产物。

不包含部署配置（`DESKWAND_CONFIG`）、任何 secret（模型 key、Telegram / 微信凭据等）、Cloudflare 账号授权、桌面客户端本地状态和恢复日志；备份里也没有云端维护租约。

**备份文件不加密**，包含记忆、对话和微信会话上下文等敏感内容。请像保管密码一样保管，不要上传到公共位置或发给不受信任的人。

导出文件默认名为 `deskwand-backup-<Worker 名称>-<YYYYMMDD-HHMMSS>.zip`。单个 R2 产物超过 100 MiB 时不会导出它的内容，只记录该对象的 key 并在界面列出，因此这样的备份不能用于恢复。

### 8.2 恢复的限制

- **只能恢复到同一云端版本。** 备份记录导出时的 Worker 发布版本，目标部署当前版本必须与它完全相同。版本未知（例如用 `wrangler deploy` 部署后尚未重新导入）也不能恢复。
- 备份来自 `1.2.0`、当前部署是 `1.3.0` 时，界面会提示先升级或降级到 `1.2.0`。旧版云端尚不支持备份接口时，会提示先在“更新”页升级。
- **恢复是整体覆盖，不是合并。** 恢复会用备份内容清空并替换 `ButlerDO`、各 `TaskDO`、`ChannelDO` 的业务数据和 Durable Object KV；备份中不存在的任务对象与 R2 产物会被删除。恢复后云端业务数据等于备份时刻，之后写入的内容不会保留。
- 备份含超过 100 MiB 的产物时，恢复会被拒绝（`BACKUP_OBJECT_TOO_LARGE`），因为 Worker 请求体无法写回该对象。
- 同一时间只允许一个导出或恢复操作。

### 8.3 恢复前快照

每次真正开始覆盖前，客户端会先对当前部署执行一次完整导出，作为恢复前快照。快照位于应用数据目录的 `backups/` 下：

- macOS：`~/Library/Application Support/DeskWand Bot/backups/pre-restore-<YYYYMMDD-HHMMSS>.zip`
- Windows：`%APPDATA%\DeskWand Bot\backups\pre-restore-<YYYYMMDD-HHMMSS>.zip`

快照失败（包括当前部署含超过 100 MiB 的产物）时恢复会中止，云端数据不会被修改。快照和普通备份一样未加密，也包含敏感内容。

恢复过程中失败时，概览页会显示“数据恢复未完成”，并提供“用该文件重试”和“恢复到恢复前快照”。如果记录状态是“进行中”（例如客户端在恢复中断电或重启），页面会与“失败”区分显示。在恢复完成前不要重新开始另一次恢复；未完成的记录保存在应用数据目录的 `restore/restore.json`。重试会重新执行覆盖步骤；每个 Durable Object 都先清空，因此重试是幂等的。

如果原备份和恢复前快照都已不存在，或者 `restore.json` 已损坏，可以在概览页选择“放弃恢复记录”并确认。这个操作**只删除本机的未完成恢复记录，不会恢复任何云端数据，也不会回滚已经写入的内容**；清除后仍需重新选择备份才能恢复。

### 8.4 导出和恢复期间消息会暂停

导出或恢复开始后，客户端会向云端申请一个维护租约，最长 10 分钟：

- 暂停期间 Telegram webhook 返回 503，Telegram 会在稍后重投；
- 微信轮询暂停；
- 每 5 分钟的 cron 与 Durable Object alarm 被推迟，任务和定时任务不会在数据不一致时执行。

操作正常结束时会主动释放租约。客户端崩溃、网络中断或进程被关闭时，租约最多 10 分钟后自然过期，消息收发和定时任务自动恢复，不需要手动重启云端。Telegram webhook 和 Durable Object alarm 在租约到期后立即恢复；微信轮询要等下一次 5 分钟 cron 重新启动，因此微信最坏约 15 分钟后恢复。租约到期后，进行中的恢复会以 `MAINTENANCE_REQUIRED` 失败，并保留“数据恢复未完成”记录。

### 8.5 正在运行的任务可能重复外部动作

恢复会中止进行中的任务，并把状态回退到备份时刻。如果任务在备份之后、恢复之前已经执行过外部动作（例如发送消息、提交请求或写入第三方系统），恢复后它可能从较早的状态继续执行，从而重复这些动作。确认恢复前请确认这些重复可以接受。

## 9. 与命令行 Wrangler 共存

客户端和 `wrangler deploy` 可以管理同一套 Worker，但要注意变量覆盖规则：

- 客户端把可编辑业务配置写在普通变量 `DESKWAND_CONFIG` 中；
- `wrangler.jsonc` **不声明 `DESKWAND_CONFIG`**；
- 生产 `wrangler.jsonc` 使用 `keep_vars: true`，并且不把客户端管理的变量写进模板；
- Wrangler 会保留未在模板中声明的远端 vars，但会覆盖模板中显式声明的字段。

因此：

1. 用 CLI 部署新代码前，确认远端已经存在 `DESKWAND_CONFIG`；
2. 不要把 `DESKWAND_CONFIG`、owner、模型或入口选择写进 `wrangler.jsonc`；
3. CLI 与客户端同时修改配置时，以远端实际值为准；客户端重新加载后会看到 CLI 写入的新值；
4. secrets 的保留和清除语义与普通 vars 不同，不要在 CLI 中假设客户端会替你恢复不可读的旧 secret；
5. 部署前可以用只读方式核对远端变量名称和公开值，但不要把 secret 值打印到终端或日志；
6. `npm run deploy` 会自动运行 `predeploy`（`scripts/check-remote-config.ts`）。设置了 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 时，它会读取远端 settings；如果 Worker 已存在但没有 `DESKWAND_CONFIG` binding，会拒绝部署。缺少环境变量或 Worker 尚未创建时会警告并跳过；确认要绕过时使用 `npm run predeploy -- --force`。

**命令行部署会清除 release tag：** `wrangler deploy` 不写客户端使用的 `workers/tag` 注解。部署后云端版本会显示为未知，客户端会返回 `VERSION_UNKNOWN_REIMPORT`，直到下一次在“连接已有服务”中重新导入或执行一次客户端升级。不要用 `--tag` 临时修补部署脚本；重新导入/升级才会恢复客户端可识别的版本。

## 10. 客户端更新

桌面客户端更新与云端 Worker 升级是两条独立链路：

- **云端服务**：在“更新”页比较客户端内置的 Worker 发布包与当前部署，由你确认后升级；
- **桌面客户端**：由独立的客户端更新密钥签名，使用单独的更新源。

客户端更新永远不会自动执行，也永远不会修改云端部署。默认构建没有配置更新源，界面显示 **“未配置更新源”**。配置了发布源的正式构建可以：

1. 点击 **检查客户端更新**；
2. 看到新版本后点击 **安装客户端更新**；
3. 重启客户端使新版本生效。

客户端更新与 Worker 发布包不能互相替代：Worker 发布包不能安装成桌面更新，桌面更新也不会携带或替换云端代码。

## 11. 外观（浅色 / 深色）

侧边栏底部有三个外观选项：

- **跟随系统**（默认）：系统切换深浅色时，客户端立即一起变；
- **浅色** / **深色**：固定一种外观，不再随系统变。

选择保存在本机（应用数据目录里的 `preferences.json`，不含任何凭据），下次启动直接生效；它只影响外观，不触碰 Cloudflare 账号、部署或云端配置。没有 `preferences.json`、文件损坏或值无效时，客户端回到「跟随系统」。

## 12. 维护者：发布密钥、构建、签名与更新源

以下步骤只属于维护者，不是普通用户安装步骤。

### 12.1 两套独立的 Ed25519 密钥

**Worker 发布密钥**（key id `deskwand-release-1`）：

```bash
npm run generate:release-key
```

- 私钥：`$HOME/.deskwand-bot/release-signing-key.pem`，权限 0600；
- 公钥：`desktop/internal/release/keys/deskwand-release-1.pub.pem`，可以提交；
- 也可用 `DESKWAND_RELEASE_SIGNING_KEY_FILE` 指向已有私钥。

**桌面客户端更新密钥**：

在 `desktop/frontend` 目录执行：

```bash
npx mygo keygen
```

- 私钥：`$HOME/.deskwand-bot/client-update.key`，权限 0600；可用 `DESKWAND_CLIENT_UPDATE_KEY_FILE` 指向其他路径；
- 公钥：命令输出（`mygo-update.pub`）的内容写入 `desktop/mygo.json` 的 `updates.publicKey`，可以提交；
- 私钥必须额外备份到密码管理器：丢失后，已安装的客户端无法再接收更新。

私钥绝不进入仓库、日志、构建产物或客户端包。两套密钥不能混用。

### 12.2 构建 Worker 发布包和桌面安装包

一次完成签名 Worker 发布包、嵌入和 macOS 打包：

```bash
DESKWAND_RELEASE_SIGNING_KEY_FILE=/secure/release-signing-key.pem \
  npm run build:desktop
```

产物在 `desktop/build/<os>-<arch>/`。

发布包 manifest 的 `upgrade.minFromVersion` 是能直接升级到本版本的最低版本，由 `build:desktop` 传入，默认 `0.1.0`（首个对外发布版本），可用 `DESKWAND_MIN_FROM_VERSION` 覆盖。它必须不高于本次发布的版本号，否则构建直接失败：那样的 manifest 会让旧部署永远报 `UPGRADE_REQUIRES_INTERMEDIATE`。只有当某个版本要求先经过中间版本时才提高它。

`desktop/mygo.json` 配置：
- macOS：`.app` + `.dmg`，`minimumSystemVersion` 12.0；
- Windows：NSIS 安装器，当前用户安装，不需要管理员权限。

macOS 默认 ad-hoc 签名，仅适合本机或内部测试。Windows 安装器需要 NSIS：Windows 上 MyGo 会下载或使用已安装的 NSIS；macOS/Linux 交叉构建需要本机 `makensis`，否则跳过安装器。

Windows 交叉构建可以编译出 `.exe`，但本仓库的 macOS 环境在执行 NSIS 时因本机 `makensis` 崩溃而未生成安装器；该路径未通过验收，不提供 `build:desktop:windows` 脚本冒充可用。正式 Windows 包应在 `windows-latest` 上构建。

**应用图标**：母版是 `desktop/icon/icon.svg`（轨道星球，设计见 `docs/superpowers/specs/2026-11-02-app-icon-design.md`）。`desktop/mygo.json` 的 `icon` 指向 `icon/icon.png`，MyGo 由它生成 macOS `.icns` 与 Windows `.ico`。修改图标：改 SVG → 运行 `bash desktop/scripts/render-icon.sh` → 同时提交 SVG 与 PNG。渲染需要本机 Google Chrome（可用 `CHROME=` 指定路径）；构建只读已提交的 PNG，不需要 Chrome。图标源文件不放在 `desktop/resources/`：MyGo 会把该目录的全部内容打进应用。`desktop/icon_test.go` 校验 PNG 尺寸、透明角和关键配色。

### 12.3 macOS 签名与公证

在 `desktop/mygo.json` 中配置（示例，未写入仓库）：

```json
{
  "macos": {
    "signingIdentity": "Developer ID Application: Example (TEAMID)",
    "notarize": { "keychainProfile": "notary" }
  }
}
```

一次性保存公证凭据：

```bash
xcrun notarytool store-credentials notary
```

`security find-identity -v -p codesigning` 可以列出可用身份。没有 Developer ID 和公证凭据时，构建仍会产出 ad-hoc 签名的内部测试包，但不能声明为公开可信发行版。

Windows 代码签名可在 `windows.certificate` / `windows.signCommand` 中配置；证书密码来自 `MYGO_WINDOWS_CERTIFICATE_PASSWORD`。未签名安装器会触发 SmartScreen 警告。

### 12.4 客户端更新源

`desktop/mygo.json` 的 `updates` 是唯一的更新配置来源：

- `updates.publicKey`：12.1 生成的客户端更新公钥；
- `updates.url`：`https://updates.example.com/bot`；
- `updates.s3`：桶 `my-update-assets`、前缀 `bot` 和 R2 endpoint（只含账号 ID，不是凭据）。

客户端后台每 6 小时检查一次，发现新版本后弹窗询问；确认后才下载、安装并重启。开发构建或安装目录不可写时不做后台检查，手动检查会说明原因。

**CHANGELOG 约定**：每次发布前在 `desktop/CHANGELOG.md` 加一节 `## <version>`（也可以写成 `## [<version>] - YYYY-MM-DD`）。`desktop/mygo.json`、`desktop/main.go` 的 `appVersion`、`desktop/frontend/package.json` 三处版本号必须与它一致，发布预检会拒绝缺失或不一致的版本。

**发布**：

```bash
npm run release:desktop -- --dry-run   # 只打印步骤与将上传的文件
npm run release:desktop                # 写入 R2；发布前需维护者明确同意
```

脚本只支持 macOS arm64，按顺序执行：

1. 检查 git 工作区干净、两套私钥存在、三处版本一致、CHANGELOG 含当前版本；
2. 读取线上 manifest：只有 404 视为首次发布，网络错误、其它状态码、坏 JSON 都拒绝；本地版本必须严格高于线上版本；
3. 生成并签名 Worker 发布包，嵌入桌面客户端；
4. 从 `~/.mc/config.json` 的 `r2` alias 读取凭据，只在发布子进程中导出为 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`，清除代理后执行 `mygo build -upload`；
5. 带缓存绕过参数读取公网 manifest，核对 `version`、归档大小与 SHA-256。

**R2 布局**（`my-update-assets/bot/`）：

```
deskwand-bot-<version>-darwin-arm64.tar.gz          自动更新归档
deskwand-bot-<from>-to-<version>-darwin-arm64.delta 增量包（有上一版本时）
deskwand-bot-<version>-arm64.dmg                    首次安装 / 手动下载
SHA256SUMS
update-darwin-arm64.json                            manifest，最后上传
```

旧版本文件全部保留：MyGo 生成 delta 需要前 3 个版本的归档，脚本从不删除 R2 上的对象。manifest 最后上传，中途失败不会让已安装的客户端看到缺文件的版本；发布后核验不一致时脚本报错并提示人工处理，不回滚、不删除。

**首次上线**：0.1.5 及更早的版本没有更新器，第一个带自动更新的版本需要用户手动下载 dmg 安装，之后才会自动更新。ad-hoc 签名下，自动更新不受 Gatekeeper 拦截，但首次手动安装 dmg 仍会提示「无法验证开发者」。

### 12.5 CI

`.github/workflows/desktop-build.yml` 在 `macos-latest` 和 `windows-latest` 上：

- 使用 `desktop/go.mod` 的 Go 版本和 Node 26；
- 运行根目录 typecheck/tests、Go vet/tests、前端 typecheck/build/Playwright；
- 从仓库 secret `DESKWAND_RELEASE_SIGNING_KEY` 读取 Worker 发布私钥并写入临时文件，步骤退出时通过 `trap ... EXIT` 删除；
- 只在 **push 或手动触发**且 secret 存在时签名、打包并上传安装产物；`pull_request` 只跑测试；
- 不创建 tag、不发布 release，权限只有 `contents: read`；
- 使用固定到 commit SHA 的 GitHub Actions。

secret 缺失时会输出明确 notice 并跳过打包，不会用开发密钥伪造正式产物。

### 12.6 验收记录

当前仓库实际执行过的验证、环境限制和 NOT RUN 项见：

- `docs/verification/2026-11-01-client-capabilities.md`
- `docs/verification/desktop-acceptance.md`

控制面单元测试、本机打包和 Playwright 通过，都不等于干净机器安装或真实微信 / Telegram 收发已经验收。
