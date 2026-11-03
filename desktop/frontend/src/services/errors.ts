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

export interface CodeCopy {
  short: string;
  /** False when no copy exists for this code and the line is the generic fallback. */
  known: boolean;
}

/**
 * One actionable Chinese line per stable Go error/reason code. Keep this list
 * aligned with desktop/internal/**; tests/e2e/client.spec.ts greps the Go
 * sources and fails when a fixed code is missing.
 */
const SHORT_COPY: Record<string, string> = {
  AUTH_REQUIRED: "请先连接 Cloudflare。",
  AUTH_NOT_CONNECTED: "请先连接 Cloudflare。",
  AUTH_OAUTH_DENIED: "授权已取消。",
  AUTH_OAUTH_TIMEOUT: "授权超时，请重新登录。",
  AUTH_OAUTH_PORT_BUSY: "端口 8756–8758 被占用。",
  AUTH_OAUTH_STATE_MISMATCH: "授权校验失败，请重新登录。",
  AUTH_OAUTH_EXCHANGE_FAILED: "授权失败，请重试。",
  AUTH_NO_ACCOUNT: "没有可用账号，或缺少账号权限。",
  AUTH_REAUTH_REQUIRED: "授权已过期，请重新登录。",
  AUTH_VERIFY_FAILED: "刷新授权失败，请检查网络。",
  CLOUDFLARE_LOGIN_IN_PROGRESS: "已有登录在进行，请先完成或取消。",
  CLOUDFLARE_LOGIN_NOT_FOUND: "登录已结束。",
  CREDENTIAL_STORE_UNAVAILABLE: "钥匙串不可用，未改用明文保存。",
  CREDENTIAL_STORE_FAILURE: "钥匙串写入失败，未降级为明文。",
  SERVICE_UNAVAILABLE: "服务未初始化，请重启客户端。",
  TARGET_NOT_SELECTED: "请先选择一个部署。",
  TARGET_ACCOUNT_MISMATCH: "部署不属于当前账号，请重新选择。",
  TARGET_MISMATCH: "部署不属于当前账号，请重新选择。",
  LOGIN_NOT_FOUND: "扫码已结束，请重新发起。",
  LOGIN_IN_PROGRESS: "已有扫码在进行。",
  INVALID_ENTRY_CHANNEL: "入口只能是 Telegram 或微信。",
  RELEASE_NOT_BUNDLED: "客户端未内置发布包，请装完整发行版。",
  RELEASE_UNTRUSTED: "发布包签名不受信任。",
  RELEASE_UNAVAILABLE: "发布包不可用，请重装客户端。",
  UPGRADE_REQUIRED: "请先在更新页升级云端。",
  UPGRADE_REQUIRED_FIRST: "迁移版本过旧，需命令行升级。",
  DOWNGRADE_REJECTED: "云端版本更新，请先升级客户端。",
  UPGRADE_REQUIRES_INTERMEDIATE: "需要先升到中间版本。",
  VERSION_UNKNOWN: "无法识别版本，请刷新重试。",
  VERSION_UNKNOWN_REIMPORT: "版本未知，请重新导入。",
  MIGRATION_HISTORY_MISMATCH: "迁移历史不匹配，已停止，不覆盖云端。",
  IRREVERSIBLE_MIGRATION: "该升级含不可逆迁移，先备恢复方案。",
  RESOURCE_IDENTITY_CHANGED: "存储标识已变，已停止，不替换数据。",
  RESOURCE_IDENTITY_UNVERIFIABLE: "存储身份无法确认，已停止。",
  UP_TO_DATE: "云端已是最新版本。",
  CLIENT_UPDATE_NOT_CONFIGURED: "此构建没有更新源。",
  CLIENT_UPDATE_SIGNATURE_INVALID: "更新包签名无效，已拒绝。",
  CLIENT_UPDATE_DOWNGRADE_REJECTED: "更新源版本更低，已拒绝降级。",
  CLIENT_UPDATE_NOT_CHECKED: "请先检查更新。",
  CLIENT_UPDATE_FAILED: "更新失败，当前版本可用。",
  NAME_TAKEN: "名称已被占用，请换一个。",
  BUCKET_TAKEN: "R2 桶名已被占用。",
  SUBDOMAIN_UNAVAILABLE: "请先启用 Workers 子域。",
  INSTALL_CONFLICT: "已有操作在进行，请先处理顶部那条。",
  OPERATION_IN_PROGRESS: "同一部署已有操作在进行。",
  OWNER_REQUIRED: "需要确认 owner 列表（可留空）。",
  MODELS_REQUIRED: "需要选择管家和任务模型。",
  CONFIG_MISSING: "云端缺少 DESKWAND_CONFIG。",
  MODEL_KEY_MISSING: "缺少模型密钥，请在模型页填写。",
  SERVICE_NOT_FOUND: "找不到该 Worker。",
  UPLOAD_REJECTED: "Cloudflare 拒绝了上传。",
  VERIFY_FAILED: "核实失败，请继续核对。",
  INVALID_REQUEST: "请求参数无效。",
  INVALID_VAR: "配置变量无效。",
  PLAINTEXT_SECRET_DETECTED: "有明文凭据，需迁移为密钥。",
  CONFIG_CONFLICT: "云端配置已变化，请重新加载。",
  LATEST_NOT_BASE: "云端已有新版本，不会重放旧配置。",
  MULTI_VERSION_DEPLOYMENT: "多版本在接收流量，已停止覆盖。",
  UNSUPPORTED_BINDING: "含无法保留的绑定，不会静默覆盖。",
  UNSUPPORTED_SCHEMA: "配置版本不支持，请升级客户端。",
  NO_ACTIVE_VERSION: "没有接收流量的版本。",
  INVALID_SECRET_EDIT: "密钥操作无效，需选保留或替换。",
  NOT_SENT: "请求未写入云端，无部分写入。",
  ADMIN_UNAVAILABLE: "云端服务尚不支持数据备份，请先在更新页升级。",
  MCP_ADMIN_UNAVAILABLE: "云端管理接口不可用。",
  MCP_FAILED: "云端管理请求失败。",
  ADMIN_UNAUTHORIZED: "备份凭据被拒绝，请重新登录。",
  MAINTENANCE_REQUIRED: "维护租约失效，请重试。",
  MAINTENANCE_BUSY: "另一个备份操作正在进行。",
  BACKUP_INVALID: "备份文件无效。",
  BACKUP_VERSION_MISMATCH: "备份版本与云端不一致。",
  BACKUP_OBJECT_TOO_LARGE: "备份中有超过 100 MiB 的对象。",
  RESTORE_SNAPSHOT_FAILED: "快照失败，云端未改动。",
  RESTORE_PENDING: "还有未完成的恢复。",
  RESTORE_JOURNAL_CORRUPT: "本机恢复记录已损坏。",
};

/** Every WECHAT_ILINK_* code shares this line, so a new one always has copy. */
const FALLBACK_WECHAT = "微信请求失败，请稍后重试。";

export function codeCopy(code: string): CodeCopy {
  if (code.startsWith("WECHAT_ILINK_")) return { short: FALLBACK_WECHAT, known: true };
  const short = SHORT_COPY[code];
  return short ? { short, known: true } : { short: FALLBACK_CODE_MESSAGE, known: false };
}

/** Kept for callers that only need the line: logs, e2e and the backup page. */
export function describeCode(code: string): string {
  return codeCopy(code).short;
}

export function isCode(error: unknown, ...codes: string[]): boolean {
  return codes.includes(toClientError(error).code);
}
