// Single source of truth for the labels the UI reuses across pages. Sentences
// that appear once stay where they are written; only reused labels live here.
// Every label is resolved when it is rendered so a language switch takes effect
// without a reload.
import { getT, tryT } from "@/i18n";
import type { StatusItemDTO } from "@/services/types";

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export const STATE_LABELS: Record<string, { variant: BadgeVariant }> = {
  configured: { variant: "secondary" },
  unverified: { variant: "outline" },
  verified: { variant: "default" },
  expired: { variant: "destructive" },
  unavailable: { variant: "outline" },
  unknown: { variant: "outline" },
  planned: { variant: "outline" },
  applying: { variant: "secondary" },
  verifying: { variant: "secondary" },
  published: { variant: "default" },
  needs_input: { variant: "outline" },
  partial: { variant: "destructive" },
  failed: { variant: "destructive" },
  cancelled: { variant: "outline" },
  completed: { variant: "secondary" },
  completed_with_warnings: { variant: "secondary" },
  unchanged: { variant: "outline" },
  publish_failed: { variant: "destructive" },
};

export function stateLabel(state: string): string {
  return tryT(`states.${state}`) ?? state;
}

export function sourceLabel(source?: string): string {
  if (!source) return getT()("states.sources.none");
  return tryT(`states.sources.${source}`) ?? source;
}

export function detailLabel(detail?: string): string {
  const value = (detail ?? "").trim();
  if (!value) return getT()("states.noEventDetail");
  // The bridge sends "some_code（human qualifier）". Keep the qualifier, drop
  // the implementation token: the qualifier carries the caveat.
  const qualified = /^[a-z0-9_]+（(.+)）$/.exec(value);
  if (qualified?.[1]) return qualified[1];
  return tryT(`states.details.${value}`) ?? value;
}

/** True when detailLabel above passes through the bridge-provided text. */
export function detailNeedsIgnore(detail?: string): boolean {
  const value = (detail ?? "").trim();
  if (!value) return false;
  if (/^[a-z0-9_]+（(.+)）$/.test(value)) return true;
  return tryT(`states.details.${value}`) === undefined;
}

export function statusKindLabel(kind: string): string {
  return tryT(`states.statusKinds.${kind}`) ?? kind;
}

/**
 * Exactly one of these is rendered, and `verified-cloud` is reserved for cloud
 * log evidence: a local probe can never light it up.
 */
export function verificationBadge(
  item: StatusItemDTO,
): { label: string; key: "verified-cloud" | "verified-user" | "unverified" } | null {
  if (item.kind !== "telegram" && item.kind !== "wechat") return null;
  const t = getT();
  if (item.state === "verified" && item.source === "cloudflare-logs") {
    return { label: t("states.verificationCloud"), key: "verified-cloud" };
  }
  if (item.state === "verified" && item.source === "user") {
    return { label: t("states.verificationUser"), key: "verified-user" };
  }
  // Defence in depth: a verified state whose source is not accepted evidence
  // must not stand alone, whatever the bridge sends.
  if (item.state === "verified" || item.state === "configured" || item.state === "unverified") {
    return { label: t("states.verificationUnverified"), key: "unverified" };
  }
  return null;
}

/**
 * Cloudflare 免费额度的说明。部署页和模型页都要说同一件事，措辞必须一致，
 * 所以它是跨页复用句，按本文件的约定放这里。
 */
export function cloudflareNeuronsNotice(): string {
  return getT()("common.cloudflareNeuronsNotice");
}
