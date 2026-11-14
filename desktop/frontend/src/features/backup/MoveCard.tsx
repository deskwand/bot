import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { getT, useT, type MessageKey } from "@/i18n";
import type { BootStateDTO, MoveDTO } from "@/services/types";

const PHASE_KEYS: Record<string, MessageKey> = {
  packing: "backup.movePhasePacking",
  muting: "backup.movePhaseMuting",
  homing: "backup.movePhaseHoming",
  unloading: "backup.movePhaseUnloading",
};

function phaseLabel(phase: string): string {
  const key = PHASE_KEYS[phase];
  return key ? getT()(key) : phase;
}

/**
 * MoveCard is the residence card: it starts a move, shows the phase the move
 * is in, and offers the way back. Silencing happens before the new residence
 * exists, so no two residences poll the same entry.
 */
export function MoveCard() {
  const { client } = useApp();
  const t = useT();
  const [move, setMove] = useState<MoveDTO | null>(null);
  const [boot, setBoot] = useState<BootStateDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setMove(await client.moveStatus());
      setBoot(await client.bootState());
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(cause);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const running = move !== null && move.phase !== "done" && move.phase !== "abandoned";
  // An abandoned move leaves the old residence muted on purpose. It stays
  // silent until the owner asks for it back, so that way out has to exist.
  const abandoned = move !== null && move.phase === "abandoned";
  const previous = boot?.previousTarget;

  return (
    <Card className="mt-5" data-testid="move-card">
      <CardHeader>
        <CardTitle>{running ? t("backup.moveInProgressTitle") : t("backup.moveTitle")}</CardTitle>
        <CardDescription>
          {running ? phaseLabel(move.phase) : t("backup.moveDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorAlert error={error} onRetry={refresh} retryLabel={t("backup.moveRetry")} />
        {running ? (
          <>
            <Alert>
              <AlertTriangle aria-hidden />
              <AlertTitle>{t("backup.moveOutageTitle")}</AlertTitle>
              <AlertDescription>{t("backup.moveOutageBody")}</AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              {move.phase === "homing" ? (
                <Button disabled={busy} onClick={() => void run(() => client.settleMove())}>
                  {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                  {t("backup.moveSettle")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => client.moveBack())}
              >
                {t("backup.moveBack")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => client.abandonMove())}
              >
                {t("backup.moveAbandon")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {abandoned ? (
              <Alert>
                <AlertTriangle aria-hidden />
                <AlertTitle>{t("backup.moveAbandonedTitle")}</AlertTitle>
                <AlertDescription>{t("backup.moveAbandonedBody", { name: move.from.name })}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy} onClick={() => void run(() => client.startMove())}>
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                {t("backup.moveStart")}
              </Button>
              {abandoned ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => client.reviveOldHouse())}
                >
                  {t("backup.moveRevive")}
                </Button>
              ) : null}
              {previous ? (
                <Button
                  variant="outline"
                  disabled={busy || !previous.reachable}
                  onClick={() => void run(() => client.moveBack())}
                >
                  {t("backup.moveBack")}
                </Button>
              ) : null}
            </div>
            {previous ? (
              <p className="text-sm text-muted-foreground">
                {t("backup.movePrevious", { name: previous.name })}
                {previous.reachable ? null : ` · ${t("backup.movePreviousUnreachable")}`}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("backup.moveBackHint")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
