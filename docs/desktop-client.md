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

## 2. 创建 Cloudflare API Token

v1 使用你自行创建的 Cloudflare API Token，而不是第三方 OAuth 应用。Token 只保存在系统凭据库中：

- macOS：登录钥匙串；
- Windows：凭据管理器。

前端页面不会再次读取或显示完整 token。客户端不会把 token 写进普通配置文件或日志。

在 Cloudflare Dashboard 打开 **My Profile → API Tokens → Create Token**，使用 **Custom token**，并至少授予以下账户级权限：

| 权限 | API 权限组 | 用途 |
| --- | --- | --- |
| Workers Scripts:Edit | Workers Scripts Write | 上传 Worker、创建版本与部署 |
| Workers R2 Storage:Edit | Workers R2 Storage Write | 创建并保留 R2 存储桶 |
| Account Settings:Read | Account Settings Read | 读取账号与资源信息 |
| Workers Observability:Edit（可选） | Workers Observability Write | 读取脱敏运行事件并配置日志；没有该权限时诊断显示“未知” |

资源范围选择你的账号；不要授予无关的 Zone、DNS 或账号管理权限。创建后复制 token，在客户端填写：

- **Cloudflare 账户 ID**：32 位十六进制；
- **API Token**：只粘贴一次。

连接成功后，token 输入框会消失。需要更换账号或 token 时，先断开连接，再重新授权。

Token 过期、被撤销或权限被收回后，云端服务不会停止；客户端会显示授权错误。重新创建 token 并在客户端重新连接即可，不需要删除或重装云端部署。

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

## 5. “保存并发布”到底做什么

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

## 6. 状态：未知、未验证、已验证

状态来自不同证据，不能混为一谈：

| 状态 | 含义 |
| --- | --- |
| 未知 / 无证据 | 没有当前版本的 Cloudflare 日志，或日志未保存、被采样、已过期。缺失证据不等于故障，也不等于成功。 |
| 未验证 | 已经配置，或只完成了本机测试；还没有当前云端版本的收发证据。 |
| 已验证 | 有当前版本、当前渠道、对应时间范围内的云端事件证据，例如收到轮询响应或成功发送消息。 |
| 用户确认 | 你手动确认“我收到了消息”。它标记为用户证据，不计作云端日志验证。 |

模型的本机探测只证明“这台机器用这个密钥能访问提供商”，不代表云端 Worker 已经使用该密钥成功处理消息。界面会显示来源和观察时间。

## 7. 与命令行 Wrangler 共存

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

## 8. 客户端更新

桌面客户端更新与云端 Worker 升级是两条独立链路：

- **云端服务**：在“更新”页比较客户端内置的 Worker 发布包与当前部署，由你确认后升级；
- **桌面客户端**：由独立的 `deskwand-client-1` 密钥签名，使用单独的更新源。

客户端更新永远不会自动执行，也永远不会修改云端部署。默认构建没有配置更新源，界面显示 **“未配置更新源”**。配置了发布源的正式构建可以：

1. 点击 **检查客户端更新**；
2. 看到新版本后点击 **安装客户端更新**；
3. 重启客户端使新版本生效。

客户端更新与 Worker 发布包不能互相替代：Worker 发布包不能安装成桌面更新，桌面更新也不会携带或替换云端代码。

## 9. 维护者：发布密钥、构建、签名与更新源

以下步骤只属于维护者，不是普通用户安装步骤。

### 9.1 两套独立的 Ed25519 密钥

**Worker 发布密钥**（key id `deskwand-release-1`）：

```bash
npm run generate:release-key
```

- 私钥：`$HOME/.deskwand-bot/release-signing-key.pem`，权限 0600；
- 公钥：`desktop/internal/release/keys/deskwand-release-1.pub.pem`，可以提交；
- 也可用 `DESKWAND_RELEASE_SIGNING_KEY_FILE` 指向已有私钥。

**桌面客户端更新密钥**（key id `deskwand-client-1`）：

```bash
npm run generate:release-key -- --client
```

- 私钥：`$HOME/.deskwand-bot/client-update-key.pem`，权限 0600；
- 公钥：命令会打印 PEM，粘贴到 `mygo.json` 的 `updates.publicKey`；不写入仓库文件，也不嵌入客户端源码。公钥本身可以提交到发布配置中。

脚本拒绝覆盖已有密钥。私钥绝不进入仓库、日志、构建产物或客户端包。两套密钥不能混用。轮换密钥时，先发布同时信任旧、新 key id 的客户端，再切换签名密钥。

### 9.2 构建 Worker 发布包和桌面安装包

一次完成签名 Worker 发布包、嵌入和 macOS 打包：

```bash
DESKWAND_RELEASE_SIGNING_KEY_FILE=/secure/release-signing-key.pem \
  npm run build:desktop
```

产物在 `desktop/build/<os>-<arch>/`。`desktop/mygo.json` 配置：

- macOS：`.app` + `.dmg`，`minimumSystemVersion` 12.0；
- Windows：NSIS 安装器，当前用户安装，不需要管理员权限。

macOS 默认 ad-hoc 签名，仅适合本机或内部测试。Windows 安装器需要 NSIS：Windows 上 MyGo 会下载或使用已安装的 NSIS；macOS/Linux 交叉构建需要本机 `makensis`，否则跳过安装器。

Windows 交叉构建可以编译出 `.exe`，但本仓库的 macOS 环境在执行 NSIS 时因本机 `makensis` 崩溃而未生成安装器；该路径未通过验收，不提供 `build:desktop:windows` 脚本冒充可用。正式 Windows 包应在 `windows-latest` 上构建。

### 9.3 macOS 签名与公证

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

### 9.4 客户端更新源

客户端更新使用 MyGo 的签名更新机制，但密钥与 Worker 发布包分离：

1. 用 `npm run generate:release-key -- --client` 生成/保管 `deskwand-client-1` 私钥；
2. 将命令打印的公钥 PEM 填入 `desktop/mygo.json` 的 `updates.publicKey`（MyGo 用它验证桌面更新）；
3. 在 `updates.url` 填 HTTPS 目录，或使用 GitHub Releases；
4. 用 `MYGO_UPDATER_PRIVATE_KEY`（内容）或 `updates.privateKey`（路径）提供私钥；
5. 把 MyGo 生成的 `update-<target>.json`、归档、delta、`SHA256SUMS` 和安装脚本上传到该目录，**最后上传 manifest**；
6. 在打包构建中设置 `ClientUpdateFeedURL`（`desktop/internal/app/updater.go`，可用 `-ldflags -X` 覆盖）为非空值。

`ClientUpdateFeedURL` 默认为空，因此普通源码构建和本仓库的 CI 不检查更新；UI 显示“未配置更新源”。只有同时存在可信公钥、有效更新源和可写安装位置时，MyGo 才会启用更新。客户端源码不嵌入公钥文件；`mygo.json` 的 `updates.publicKey` 是唯一验签来源。

### 9.5 CI

`.github/workflows/desktop-build.yml` 在 `macos-latest` 和 `windows-latest` 上：

- 使用 `desktop/go.mod` 的 Go 版本和 Node 26；
- 运行根目录 typecheck/tests、Go vet/tests、前端 typecheck/build/Playwright；
- 从仓库 secret `DESKWAND_RELEASE_SIGNING_KEY` 读取 Worker 发布私钥并写入临时文件，步骤退出时通过 `trap ... EXIT` 删除；
- 只在 **push 或手动触发**且 secret 存在时签名、打包并上传安装产物；`pull_request` 只跑测试；
- 不创建 tag、不发布 release，权限只有 `contents: read`；
- 使用固定到 commit SHA 的 GitHub Actions。

secret 缺失时会输出明确 notice 并跳过打包，不会用开发密钥伪造正式产物。

### 9.6 验收记录

当前仓库实际执行过的验证、环境限制和 NOT RUN 项见：

- `docs/verification/2026-11-01-client-capabilities.md`
- `docs/verification/desktop-acceptance.md`

控制面单元测试、本机打包和 Playwright 通过，都不等于干净机器安装或真实微信 / Telegram 收发已经验收。
