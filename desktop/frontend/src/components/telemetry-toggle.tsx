import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app-context";
import { codeCopy, toClientError } from "@/services/errors";

/**
 * Sidebar footer switch for the anonymous usage report. Go owns the choice and
 * the reporting: turning it off stops the heartbeat before its next tick. The
 * button carries only 开/关 — the label beside it already says what it is.
 */
export function TelemetryToggle() {
  const { client } = useApp();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .telemetryEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const choose = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      await client.setTelemetryEnabled(next);
      setError(null);
    } catch (failure) {
      // Go stores before it answers, so a rejected write means the switch never
      // moved: show the old choice again.
      setEnabled(previous);
      setError(failure);
    }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">匿名统计</span>
        <Button
          type="button"
          size="xs"
          variant={enabled ? "secondary" : "ghost"}
          disabled={enabled === null}
          aria-label="匿名统计"
          aria-pressed={enabled ?? false}
          onClick={() => void choose(!enabled)}
        >
          {enabled === null ? "…" : enabled ? "开" : "关"}
        </Button>
      </div>
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer">详情</summary>
        <p className="mt-1">
          只发送匿名设备号、版本、平台和功能使用次数，不包含任何内容。关闭后立即停止上报。
        </p>
      </details>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {codeCopy(toClientError(error).code).short}
        </p>
      ) : null}
    </div>
  );
}