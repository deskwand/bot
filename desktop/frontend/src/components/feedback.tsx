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
import {
  STATE_LABELS,
  detailLabel,
  sourceLabel,
  stateLabel,
  statusKindLabel,
  verificationBadge,
} from "@/lib/copy";
import { codeCopy, toClientError } from "@/services/errors";
import type { StatusItemDTO, StepDTO } from "@/services/types";

export { STATE_LABELS, detailLabel, sourceLabel, stateLabel, statusKindLabel } from "@/lib/copy";

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
  const { short, known } = codeCopy(parsed.code);
  const bridgeText = parsed.message && parsed.message !== short ? parsed.message : "";
  // A code with no copy of its own has only the bridge sentence, so that is the
  // line. A known code shows its own line and keeps the bridge text folded.
  const line = known ? short : bridgeText || short;
  const folded = known ? bridgeText : "";
  const goUpdates = parsed.code === "UPGRADE_REQUIRED";
  const importAgain = parsed.code === "VERSION_UNKNOWN_REIMPORT";
  const waitForPending =
    parsed.code === "OPERATION_IN_PROGRESS" || parsed.code === "INSTALL_CONFLICT";
  return (
    <Alert variant="destructive" role="alert" data-testid="error-alert" className="my-4">
      <AlertCircle />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[11px]" data-testid="error-code">
          {parsed.code}
        </Badge>
      </AlertTitle>
      <AlertDescription>
        <span className="block" data-testid="error-short">
          {line}
        </span>
        {folded ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs opacity-80">详情</summary>
            <span className="mt-1 block text-xs opacity-80" data-testid="error-detail">
              {folded}
            </span>
          </details>
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
                先用顶部的「继续」处理
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

export function formatObserved(value?: string): string {
  if (!value) return "未记录观察时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function StatusRow({ item }: { item: StatusItemDTO }) {
  const verify = verificationBadge(item);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 last:border-0" data-testid={`status-${item.kind}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{statusKindLabel(item.kind)}</span>
          <Badge
            variant={STATE_LABELS[item.state]?.variant ?? "outline"}
            data-testid={`state-${item.kind}`}
          >
            {stateLabel(item.state)}
          </Badge>
          {verify ? (
            <Badge variant="secondary" data-testid={`verification-${item.kind}-${verify.key}`}>
              {verify.label}
            </Badge>
          ) : null}
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
