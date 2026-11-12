import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { tryT, useT } from "@/i18n";
import type { ExchangeSyncDTO } from "@/services/types";

/**
 * A code with its own copy wins over the bridge message, which in turn wins
 * over the bare code. Nothing here ever carries a key or a secret.
 */
function reasonText(status: ExchangeSyncDTO): string {
  if (status.code) {
    const known = tryT(`exchange.sync.code.${status.code}`);
    if (known !== undefined) return known;
  }
  return status.message || status.code || "";
}

function timeText(at: string): string {
  return new Date(at).toLocaleTimeString();
}

export function SyncStatus({
  accountId,
  index,
  status,
  hasLocalKey,
  onSynced,
}: {
  accountId: string;
  index: number;
  status: ExchangeSyncDTO | undefined;
  hasLocalKey: boolean;
  onSynced: () => void;
}) {
  const { client } = useApp();
  const t = useT();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const syncNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await client.syncExchange(accountId);
      onSynced();
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(false);
    }
  };

  let line: string;
  if (!hasLocalKey) {
    line = t("exchange.sync.off");
  } else if (!status?.at) {
    line = t("exchange.sync.waiting");
  } else if (status.ok) {
    // Without a valuation there is no total to show; never print "about 0".
    line =
      status.total === undefined
        ? t("exchange.sync.okNoTotal", {
            time: timeText(status.at),
            currencies: status.currencies ?? 0,
          })
        : t("exchange.sync.ok", {
            time: timeText(status.at),
            currencies: status.currencies ?? 0,
            total: status.total.toFixed(2),
          });
  } else {
    line = t("exchange.sync.failed", {
      time: timeText(status.at),
      reason: reasonText(status),
    });
  }

  return (
    <div
      className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3"
      data-testid={`exchange-sync-${index}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("exchange.sync.title")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{line}</p>
        </div>
        {hasLocalKey ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void syncNow()}
            disabled={running}
            data-testid={`exchange-sync-now-${index}`}
          >
            {running ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <RefreshCw aria-hidden />
            )}
            {t("exchange.sync.now")}
          </Button>
        ) : null}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}
