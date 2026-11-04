// Single source of truth for the labels the UI reuses across pages. Sentences
// that appear once stay where they are written; only reused labels live here.
import type { StatusItemDTO } from "@/services/types";

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export const STATE_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  configured: { label: "已配置", variant: "secondary" },
  unverified: { label: "未验证", variant: "outline" },
  verified: { label: "已验证", variant: "default" },
  expired: { label: "已过期", variant: "destructive" },
  unavailable: { label: "不可用", variant: "outline" },
  unknown: { label: "未知", variant: "outline" },
  planned: { label: "计划中", variant: "outline" },
  applying: { label: "执行中", variant: "secondary" },
  verifying: { label: "核实中", variant: "secondary" },
  published: { label: "已发布", variant: "default" },
  needs_input: { label: "需要输入", variant: "outline" },
  partial: { label: "部分完成", variant: "destructive" },
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
  completed: { label: "完成", variant: "secondary" },
  completed_with_warnings: { label: "完成（有警告）", variant: "secondary" },
  unchanged: { label: "无变化", variant: "outline" },
  publish_failed: { label: "发布失败", variant: "destructive" },
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state]?.label ?? state;
}

const SOURCE_LABELS: Record<string, string> = {
  "cloudflare-logs": "Cloudflare 日志",
  local: "本机测试",
  user: "用户确认",
  config: "Cloudflare 配置",
};

export function sourceLabel(source?: string): string {
  if (!source) return "无来源";
  return SOURCE_LABELS[source] ?? source;
}

const DETAIL_LABELS: Record<string, string> = {
  configured: "已配置，无云端日志",
  user_confirmed: "用户确认",
  confirmed: "用户确认",
  probe_ok: "本机探测成功",
  probe_error: "本机探测失败",
  poll_ok: "轮询成功",
  send_ok: "发送成功",
  webhook_ok: "Webhook 校验通过",
  heartbeat: "轮询心跳",
  poll_expired: "轮询已过期",
  poll_error: "轮询失败",
  webhook_rejected: "更新解析失败",
  no_evidence: "无可用证据",
  not_configured: "未配置",
  telegram_configured: "已配置",
  wechat_configured: "已配置",
};

export function detailLabel(detail?: string): string {
  const value = (detail ?? "").trim();
  if (!value) return "无事件说明";
  // The bridge sends "some_code（human qualifier）". Keep the qualifier, drop
  // the implementation token: the qualifier carries the caveat.
  const qualified = /^[a-z0-9_]+（(.+)）$/.exec(value);
  if (qualified?.[1]) return qualified[1];
  return DETAIL_LABELS[value] ?? value;
}

export function statusKindLabel(kind: string): string {
  switch (kind) {
    case "model":
      return "模型";
    case "telegram":
      return "Telegram";
    case "wechat":
      return "微信";
    default:
      return kind;
  }
}

/**
 * Exactly one of these is rendered, and `verified-cloud` is reserved for cloud
 * log evidence: a local probe can never light it up.
 */
export function verificationBadge(
  item: StatusItemDTO,
): { label: string; key: "verified-cloud" | "verified-user" | "unverified" } | null {
  if (item.kind !== "telegram" && item.kind !== "wechat") return null;
  if (item.state === "verified" && item.source === "cloudflare-logs") {
    return { label: "收发已验证", key: "verified-cloud" };
  }
  if (item.state === "verified" && item.source === "user") {
    return { label: "用户确认收发", key: "verified-user" };
  }
  // Defence in depth: a verified state whose source is not accepted evidence
  // must not stand alone, whatever the bridge sends.
  if (item.state === "verified" || item.state === "configured" || item.state === "unverified") {
    return { label: "待验证收发", key: "unverified" };
  }
  return null;
}

/**
 * Cloudflare 免费额度的说明。部署页和模型页都要说同一件事，措辞必须一致，
 * 所以它是跨页复用句，按本文件的约定放这里。
 */
export const CLOUDFLARE_NEURONS_NOTICE =
  "Cloudflare 模型每天 10,000 neurons 免费额度，UTC 0 点重置；用尽后免费账号暂停，付费账号计费。";
