import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

function dataAge(savedAt: string | null): string | null {
  if (!savedAt) return null;
  const saved = new Date(savedAt).getTime();
  if (Number.isNaN(saved)) return null;
  const minutes = Math.floor((Date.now() - saved) / 60_000);
  return minutes < 1 ? "刚刚的数据" : `${minutes} 分钟前的数据`;
}

export function SyncStatus({
  isFetching,
  isPlaceholder,
  savedAt,
  error,
  onRetry,
}: {
  isFetching: boolean;
  isPlaceholder: boolean;
  savedAt: string | null;
  error: unknown;
  onRetry: () => void;
}) {
  const age = isPlaceholder ? dataAge(savedAt) : null;
  const hint = age ?? (isFetching ? "正在同步…" : null);

  return (
    <>
      {hint ? (
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {hint}
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="刷新"
        disabled={isFetching}
        onClick={onRetry}
      >
        {isFetching ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <RefreshCw aria-hidden />
        )}
      </Button>
      {error ? (
        <div
          role="status"
          className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <span>
            无法同步最新数据{age ? ` · 显示的是 ${age}` : ""}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : null}
    </>
  );
}
