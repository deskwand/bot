// Go errors cross the MyGo bridge as CallError messages in the form
// "CODE: human readable message" (or just "CODE"). The UI always renders the
// fixed code next to one actionable Chinese line and never echoes a secret.
export interface ClientError {
  code: string;
  message: string;
}

const CODED = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/;

export const FALLBACK_CODE_MESSAGE = "请查看下方详情，修正后重试。";

export function toClientError(error: unknown): ClientError {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "操作失败，请重试";
  const match = CODED.exec(raw.trim());
  if (match) {
    const code = match[1] ?? "UNKNOWN";
    const message = (match[2] ?? "").trim();
    return { code, message: message || describeCode(code) };
  }
  return { code: "UNKNOWN", message: raw.trim() || "操作失败，请重试" };
}

/**
 * One actionable Chinese line per stable Go error/reason code. Keep this list
 * aligned with desktop/internal/**; tests/e2e/client.spec.ts greps the Go
 * sources and fails when a fixed code is missing.
 */
export function describeCode(code: string): string {
  if (code.startsWith("WECHAT_ILINK_")) {
    return "微信 iLink 请求失败。请检查网络后重新扫码；如果持续失败，请稍后再试。";
  }
  switch (code) {
    // Authorization and credential store.
    case "AUTH_REQUIRED":
    case "AUTH_NOT_CONNECTED":
      return "请先连接 Cloudflare 账户，然后重试。";
    case "AUTH_OAUTH_DENIED":
      return "你取消了 Cloudflare 授权。需要连接时请重新登录。";
    case "AUTH_OAUTH_TIMEOUT":
      return "浏览器授权在 5 分钟内没有完成。请重新登录，并在浏览器里完成授权。";
    case "AUTH_OAUTH_PORT_BUSY":
      return "端口 8756–8758 都被占用了。请关闭占用这些端口的程序后重试。";
    case "AUTH_OAUTH_STATE_MISMATCH":
      return "授权回调校验失败，已中止本次登录。请重新登录。";
    case "AUTH_OAUTH_EXCHANGE_FAILED":
      return "无法完成 Cloudflare 授权。请检查网络或默认浏览器后重试。";
    case "AUTH_NO_ACCOUNT":
      return "该 Cloudflare 用户没有可用的账号，或未授予读取账号的权限。";
    case "AUTH_REAUTH_REQUIRED":
      return "Cloudflare 授权已过期，请重新登录。";
    case "AUTH_VERIFY_FAILED":
      return "暂时无法连接 Cloudflare 刷新授权。请检查网络后重试。";
    case "CLOUDFLARE_LOGIN_IN_PROGRESS":
      return "已有一次 Cloudflare 登录正在进行，请先完成或取消它。";
    case "CLOUDFLARE_LOGIN_NOT_FOUND":
      return "该登录操作不存在或已经结束。";
    case "CREDENTIAL_STORE_UNAVAILABLE":
      return "系统凭据库不可用。请解锁系统钥匙串并确认客户端有访问权限；客户端不会改用明文保存。";
    case "CREDENTIAL_STORE_FAILURE":
      return "系统凭据库写入失败。请检查钥匙串权限后重试；客户端不会降级为明文保存。";
    case "SERVICE_UNAVAILABLE":
      return "应用服务尚未完成初始化。请重启客户端后重试。";

    // Target selection and login lifecycle.
    case "TARGET_NOT_SELECTED":
      return "请先选择一个 Worker 部署。";
    case "TARGET_ACCOUNT_MISMATCH":
    case "TARGET_MISMATCH":
      return "当前选择的部署不属于已连接的 Cloudflare 账户。请重新选择部署。";
    case "LOGIN_NOT_FOUND":
      return "扫码登录已结束或不存在。请重新发起扫码。";
    case "LOGIN_IN_PROGRESS":
      return "已有微信扫码登录正在进行。请先完成或取消当前登录。";
    case "INVALID_ENTRY_CHANNEL":
      return "消息入口必须是 Telegram 或微信，请重新选择。";

    // Releases and upgrades.
    case "RELEASE_NOT_BUNDLED":
      return "此客户端未内置 Worker 发布包，无法安装或升级。请安装完整发行版。";
    case "RELEASE_UNTRUSTED":
      return "内置发布包签名不受信任。请安装官方签名的客户端。";
    case "RELEASE_UNAVAILABLE":
      return "发布包不可用。请重新安装客户端后重试。";
    case "UPGRADE_REQUIRED":
      return "云端版本与客户端不一致。请先在“更新”页升级云端服务。";
    case "UPGRADE_REQUIRED_FIRST":
      return "该已有部署的 Durable Object 迁移版本较旧，当前客户端不能直接接管。请让维护者先用命令行部署与当前客户端匹配的版本，然后重新导入。";
    case "DOWNGRADE_REJECTED":
      return "云端版本比客户端新，不能降级。请先升级客户端。";
    case "UPGRADE_REQUIRES_INTERMEDIATE":
      return "该版本不能直接升级，需要先升级到中间版本。请按“更新”页提示逐步升级。";
    case "VERSION_UNKNOWN":
      return "无法识别当前或目标版本。请刷新后重试，或安装与云端匹配的客户端。";
    case "VERSION_UNKNOWN_REIMPORT":
      return "云端版本未知（可能用命令行部署过）。请在“连接已有服务”中重新导入";
    case "MIGRATION_HISTORY_MISMATCH":
      return "部署的迁移历史与发布包不匹配。为避免数据风险，客户端不会覆盖它；请先核对 Cloudflare 部署。";
    case "IRREVERSIBLE_MIGRATION":
      return "该升级包含不可逆数据迁移。请先确认恢复方案，再在“更新”页执行。";
    case "RESOURCE_IDENTITY_CHANGED":
      return "部署关联的存储资源标识已变化。为避免替换数据，客户端已停止操作；请核对 Cloudflare 资源。";
    case "RESOURCE_IDENTITY_UNVERIFIABLE":
      return "无法确认现有存储资源身份。为避免覆盖数据，客户端已停止操作；请检查部署绑定。";
    case "UP_TO_DATE":
      return "云端服务已是客户端内置的最新版本。";
    case "CLIENT_UPDATE_NOT_CONFIGURED":
      return "此客户端构建未配置更新源，无法检查或安装客户端更新。";
    case "CLIENT_UPDATE_SIGNATURE_INVALID":
      return "客户端更新包签名无效，已拒绝安装。请只使用官方更新源。";
    case "CLIENT_UPDATE_DOWNGRADE_REJECTED":
      return "更新源提供的版本低于当前客户端，已拒绝降级。";
    case "CLIENT_UPDATE_NOT_CHECKED":
      return "请先检查客户端更新，再点击安装。";
    case "CLIENT_UPDATE_FAILED":
      return "客户端更新失败。现有客户端仍可继续使用，请稍后重试。";

    // Installation and resources.
    case "NAME_TAKEN":
      return "Worker 名称已被占用。请换一个名称，或改用“连接已有服务”。";
    case "BUCKET_TAKEN":
      return "R2 存储桶名称已被占用。请换一个名称后重试。";
    case "SUBDOMAIN_UNAVAILABLE":
      return "workers.dev 子域不可用。请先在 Cloudflare 启用 Workers 子域后重试。";
    case "INSTALL_CONFLICT":
      return "已有安装操作正在进行或资源归属冲突。请先用顶部「继续」处理未完成操作。";
    case "OPERATION_IN_PROGRESS":
      return "同一部署已有操作正在进行。请先用顶部「继续」处理未完成操作。";
    case "OWNER_REQUIRED":
      return "该旧版部署需要确认 owner 列表（可以为空）。请填写后重试。";
    case "MODELS_REQUIRED":
      return "该旧版部署需要重新填写管家模型和任务模型。";
    case "CONFIG_MISSING":
      return "云端部署缺少 DESKWAND_CONFIG。请先在导入或配置流程中补全配置。";
    case "MODEL_KEY_MISSING":
      return "配置引用的模型 key 尚未配置。请在模型页填写缺失的 key 后再发布。";
    case "SERVICE_NOT_FOUND":
      return "找不到目标 Worker。请刷新部署列表，或确认服务没有被删除。";
    case "UPLOAD_REJECTED":
      return "Cloudflare 拒绝了上传。请检查权限、兼容日期和发布包大小后重试。";
    case "VERIFY_FAILED":
      return "发布后核实失败。请查看步骤结果并使用“继续”核对远端状态。";
    case "INVALID_REQUEST":
      return "请求参数无效。请检查名称、账户 ID 和入口选择后重试。";
    case "INVALID_VAR":
      return "配置中的普通变量无效。请检查变量名和值后重试。";
    case "PLAINTEXT_SECRET_DETECTED":
      return "配置中发现明文凭据。请按预览把每个值迁移为 secret 后再继续。";

    // Publishing and configuration.
    case "CONFIG_CONFLICT":
      return "云端配置已被其他操作修改。请重新加载后再提交，不能用旧草稿覆盖新值。";
    case "LATEST_NOT_BASE":
      return "云端已上传了新版本。请刷新后重新提交，客户端不会猜测或重放旧配置。";
    case "MULTI_VERSION_DEPLOYMENT":
      return "该部署当前有多个版本接收流量。为避免危险覆盖，请先在 Cloudflare 控制台确认版本。";
    case "UNSUPPORTED_BINDING":
      return "部署包含客户端无法安全保留的绑定。客户端不会静默覆盖未知资源；请先检查 Cloudflare 配置。";
    case "UNSUPPORTED_SCHEMA":
      return "部署配置版本不受当前客户端支持。请升级客户端或先完成兼容升级。";
    case "NO_ACTIVE_VERSION":
      return "当前部署没有接收流量的版本。请刷新部署状态后重试。";
    case "INVALID_SECRET_EDIT":
      return "secret 操作无效。必须选择保留、替换或清除，并只在替换时填写值。";
    case "NOT_SENT":
      return "请求在写入云端前被拒绝。请修正参数后重试，不会产生部分写入。";

    default:
      return FALLBACK_CODE_MESSAGE;
  }
}

export function isCode(error: unknown, ...codes: string[]): boolean {
  return codes.includes(toClientError(error).code);
}
