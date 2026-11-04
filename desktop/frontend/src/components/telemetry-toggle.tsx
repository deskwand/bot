import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app-context";
import { codeCopy, toClientError } from "@/services/errors";

/**
 * Sidebar footer switch for the anonymous usage report. Go owns the choice and
 * the reporting: turning it off stops the heartbeat before its next tick. One
 * row keeps it level with the appearance control above; the scope lives behind
 * the info button so the sidebar keeps its height.
 */
export function TelemetryToggle() {
  const { client } = useApp();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
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
        <span className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">匿名统计</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-5 text-muted-foreground"
            aria-label="匿名统计说明"
            aria-expanded={scopeOpen}
            aria-controls="telemetry-scope"
            onClick={() => setScopeOpen((open) => !open)}
          >
            <Info aria-hidden />
          </Button>
        </span>
        <Switch
          checked={enabled ?? false}
          disabled={enabled === null}
          aria-label="匿名统计"
          onCheckedChange={(next) => void choose(next)}
        />
      </div>
      <p id="telemetry-scope" hidden={!scopeOpen} className="mt-1 text-xs text-muted-foreground">
        只发送匿名设备号、版本、平台和功能使用次数，不包含任何内容。关闭后立即停止上报。
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {codeCopy(toClientError(error).code).short}
        </p>
      ) : null}
    </div>
  );
}
