import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Download, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/components/app-context";
import { ErrorAlert, StateBadge, StepList } from "@/components/feedback";
import { useT } from "@/i18n";
import { describeCode } from "@/services/errors";
import { useInvalidate } from "@/services/queries";
import type {
  ResultDTO,
  UpgradeDTO,
} from "@/services/types";

declare const __APP_VERSION__: string;

export function Updates() {
  const { client, navigateImport } = useApp();
  const t = useT();
  const invalidate = useInvalidate();
  const [upgrade, setUpgrade] = useState<UpgradeDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [clientChecking, setClientChecking] = useState(false);
  const [clientChecked, setClientChecked] = useState(false);
  const [clientError, setClientError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUpgrade(await client.upgradeAvailable());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  const checkClientUpdates = async () => {
    setClientChecking(true);
    setClientChecked(false);
    setClientError(null);
    try {
      await client.checkClientUpdates();
      setClientChecked(true);
    } catch (cause) {
      setClientError(cause);
    } finally {
      setClientChecking(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const upgradeCloud = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const upgraded = await client.upgrade();
      setResult(upgraded);
      invalidate.configAndStatus();
      await load();
    } catch (cause) {
      setRunError(cause);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("shell.pages.updates")} actions={<>
        <Button type="button" variant="outline" size="icon" aria-label={t("shell.refresh")} onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
        </Button>
</>} />

      <ErrorAlert error={error} onRetry={load} />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpCircle className="size-4" aria-hidden />
                {t("common.cloudService")}
              </CardTitle>
              <CardDescription>{t("updates.verifySignature")}</CardDescription>
            </div>
            {upgrade?.available ? (
              <Badge>{t("updates.available")}</Badge>
            ) : (
              <Badge variant="outline">{upgrade?.reason === "UP_TO_DATE" ? t("updates.upToDate") : t("updates.noUpgrade")}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {upgrade ? (
            <div className="space-y-2 text-sm">
              <p>
                {t("updates.versionLine", {
                  current: upgrade.currentVersion || t("common.unknown"),
                  available: upgrade.availableVersion || t("common.unknown"),
                })}
              </p>
              {upgrade.reason ? (
                <div className="text-muted-foreground">
                  <p>{describeCode(upgrade.reason)}</p>
                  <details className="mt-2"><summary className="cursor-pointer text-xs" data-testid="upgrade-reason">{t("common.details")}</summary><p className="mt-1 break-all text-xs" data-i18n-ignore>{upgrade.reason}</p></details>
                </div>
              ) : null}
              {upgrade.modelKeysMissing?.length ? (
                <Alert>
                  <AlertTitle>{t("updates.modelKeysMissingTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("updates.modelKeysMissingDescription", { keys: upgrade.modelKeysMissing.join(t("updates.listSeparator")) })}
                  </AlertDescription>
                </Alert>
              ) : null}
              {upgrade.reason === "VERSION_UNKNOWN_REIMPORT" ? (
                <Button type="button" size="sm" variant="outline" onClick={navigateImport}>
                  {t("errors.reimport")}
                </Button>
              ) : null}

            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("updates.readingVersions")}</p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              data-testid="upgrade-cloud"
              onClick={() => setConfirmOpen(true)}
              disabled={!upgrade?.available || running}
            >
              {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {running ? t("updates.upgrading") : t("updates.upgrade")}
            </Button>
          </div>
          {result ? (
            <div className="mt-4 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("updates.resultTitle")}</span>
                <StateBadge state={result.state} />
              </div>
              {result.state === "published" ? <>
                <p className="mt-2 text-xs text-muted-foreground">{t("updates.publishedHint")}</p>
                <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary><StepList steps={result.steps ?? []} /></details>
              </> : <StepList steps={result.steps ?? []} />}
              {result.state === "unknown" || result.state === "needs_input" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={running}
                  onClick={() => {
                    setRunning(true);
                    void client
                      .resumeOperation(result.operationId)
                      .then((resumed) => {
                        setResult(resumed);
                        invalidate.configAndStatus();
                      })
                      .catch(setRunError)
                      .finally(() => setRunning(false));
                  }}
                >
                  {t("common.continue")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={runError} onRetry={() => setConfirmOpen(true)} retryLabel={t("updates.retryUpgrade")} />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Download className="size-4" aria-hidden />
                {t("updates.desktopClient")}
              </CardTitle>
              <CardDescription>
                {t("updates.clientDescription")}
              </CardDescription>
            </div>
            <Badge variant="outline">v{__APP_VERSION__}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void checkClientUpdates()}
              disabled={clientChecking}
            >
              {clientChecking ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              {t("updates.checkClient")}
            </Button>
          </div>
          {clientChecked ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("updates.clientWindowOpened")}</p>
          ) : null}
          <ErrorAlert error={clientError} onRetry={checkClientUpdates} retryLabel={t("common.retry")} />
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("updates.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("updates.confirmDescription", {
                current: upgrade?.currentVersion || t("common.unknown"),
                available: upgrade?.availableVersion || t("common.unknown"),
              })}
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>{t("updates.compatTitle")}</AlertTitle>
            <AlertDescription>
              {t("updates.compatDescription")}
            </AlertDescription>
          </Alert>
          {upgrade?.modelKeysMissing?.length ? (
            <Alert>
              <AlertTitle>{t("updates.modelKeysMissingTitle")}</AlertTitle>
              <AlertDescription>
                {t("updates.modelKeysMissingDescription", { keys: upgrade.modelKeysMissing.join(t("updates.listSeparator")) })}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void upgradeCloud()}>
              {t("updates.confirmUpgrade")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
