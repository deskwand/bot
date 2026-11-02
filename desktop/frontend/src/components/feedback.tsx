import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app-context";
import { describeCode, toClientError } from "@/services/errors";
import type { StatusItemDTO, StepDTO } from "@/services/types";

export function ErrorAlert({
  error,
  onRetry,
  retryLabel = "重试",
  onReload,
  reloadLabel = "重新加载",
}: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  onReload?: () => void;
  reloadLabel?: string;
}) {
  const { navigate, navigateImport } = useApp();
  if (!error) return null;
  const parsed = toClientError(error);
  const goUpdates = parsed.code === "UPGRADE_REQUIRED";
  const importAgain = parsed.code === "VERSION_UNKNOWN_REIMPORT";
  const waitForPending =
    parsed.code === "OPERATION_IN_PROGRESS" || parsed.code === "INSTALL_CONFLICT";
  return (
    <Alert variant="destructive" role="alert" data-testid="error-alert" className="my-4">
      <AlertCircle />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[11px]">
          {parsed.code}
        </Badge>
        <span>操作未完成</span>
      </AlertTitle>
      <AlertDescription>
        <span className="block">{parsed.message}</span>
        {parsed.message !== describeCode(parsed.code) ? (
          <span className="mt-1 block text-xs opacity-80">{describeCode(parsed.code)}</span>
        ) : null}
        {onRetry || onReload || goUpdates || importAgain || waitForPending ? (
          <span className="mt-3 flex flex-wrap gap-2">
            {goUpdates ? (
              <Button type="button" size="sm" onClick={() => navigate("updates")}>
                前往更新页
              </Button>
            ) : null}
            {importAgain ? (
              <Button type="button" size="sm" onClick={navigateImport}>
                重新导入
              </Button>
            ) : null}
            {waitForPending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              >
                先用顶部「继续」处理未完成操作
              </Button>
            ) : null}
            {onReload ? (
              <Button type="button" size="sm" variant="outline" onClick={onReload}>
                {reloadLabel}
              </Button>
            ) : null}
            {onRetry ? (
              <Button type="button" size="sm" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : null}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

const STATE_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
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

export function StateBadge({ state }: { state: string }) {
  const entry = STATE_LABELS[state] ?? { label: state, variant: "outline" as const };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

export function StepIcon({ state }: { state: string }) {
  if (state === "completed" || state === "published") {
    return <Check className="size-4 text-emerald-600" aria-hidden />;
  }
  if (state === "failed" || state === "error") {
    return <XCircle className="size-4 text-destructive" aria-hidden />;
  }
  if (state === "unknown" || state === "needs_input") {
    return <MinusCircle className="size-4 text-amber-600" aria-hidden />;
  }
  if (state === "applying" || state === "verifying" || state === "planned") {
    return <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />;
  }
  return <Circle className="size-4 text-muted-foreground" aria-hidden />;
}

export function StepList({ steps, compact = false }: { steps: StepDTO[]; compact?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ol className={compact ? "my-2 space-y-1" : "my-3 space-y-2"} data-testid="step-list">
      {steps.map((step, index) => (
        <li key={`${step.id}-${index}`} className={compact ? "flex items-start gap-2 text-xs" : "flex items-start gap-2 text-sm"}>
          <span className="mt-0.5">
            <StepIcon state={step.state} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block">{step.message}</span>
            {compact ? null : (
              <span className="block text-xs text-muted-foreground">
                {stateLabel(step.state)}
                {step.evidence ? ` · ${step.evidence}` : ""}
              </span>
            )}
          </span>
          {compact ? null : <ChevronRight className="mt-1 size-3 text-muted-foreground" aria-hidden />}
        </li>
      ))}
    </ol>
  );
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

export function formatObserved(value?: string): string {
  if (!value) return "未记录观察时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function detailLabel(detail?: string): string {
  const value = (detail ?? "").trim();
  if (!value) return "没有事件说明";
  const labels: Record<string, string> = {
    configured: "已配置；尚无当前版本的云端日志",
    user_confirmed: "用户已确认收发（非云端日志）",
    confirmed: "用户已确认收发（非云端日志）",
    probe_ok: "本机探测成功（不代表云端收发正常）",
    probe_error: "本机探测失败",
    poll_ok: "收到轮询响应",
    send_ok: "消息发送成功",
    webhook_ok: "Webhook 校验通过",
    heartbeat: "轮询心跳（不代表成功响应）",
    poll_expired: "轮询会话已过期",
    poll_error: "轮询请求失败",
    webhook_rejected: "Webhook 请求被拒绝",
    no_evidence: "未找到可用证据（日志可能未保存或被采样）",
    not_configured: "未配置",
    telegram_configured: "已配置（不等于收发正常）",
    wechat_configured: "已配置（不等于收发正常）",
  };
  return labels[value] ?? value;
}

export function StatusRow({ item }: { item: StatusItemDTO }) {
  const runtimeKind = item.kind === "telegram" || item.kind === "wechat";
  const cloudVerified =
    runtimeKind && item.state === "verified" && item.source === "cloudflare-logs";
  const userConfirmed = runtimeKind && item.state === "verified" && item.source === "user";
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 last:border-0" data-testid={`status-${item.kind}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{statusKindLabel(item.kind)}</span>
          <StateBadge state={item.state} />
          {cloudVerified ? <Badge variant="secondary">收发已验证</Badge> : null}
          {userConfirmed ? <Badge variant="secondary">用户确认收发</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detailLabel(item.detail)}</p>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <div>来源：{sourceLabel(item.source)}</div>
        <div>{formatObserved(item.observedAt)}</div>
      </div>
    </div>
  );
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
