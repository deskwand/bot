import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pageLabel, useApp, type Page } from "@/components/app-context";
import { ErrorAlert, StatusRow, StatusBadge, formatObserved } from "@/components/feedback";
import { SyncStatus } from "@/components/sync-status";
import { useT } from "@/i18n";
import { isCode } from "@/services/errors";
import { useConfigQuery, useInvalidate, useStatusQuery } from "@/services/queries";
import type { ConnectionDTO, PendingRestoreDTO } from "@/services/types";

export function Overview() {
  const { client, navigate } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const statusQuery = useStatusQuery();
  const invalidate = useInvalidate();
  const config = configQuery.data;
  const mcpCount = Array.isArray(config?.mcpServers) ? config.mcpServers.length : 0;
  const status = statusQuery.data ?? [];
  const [connection, setConnection] = useState<ConnectionDTO | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreDTO | null>(null);
  const [pendingError, setPendingError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState<"backup" | "snapshot" | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryMessage, setRetryMessage] = useState("");
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [abandonError, setAbandonError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<unknown>(null);

  const loadLocal = useCallback(async () => {
    setLocalError(null);
    setPendingError(null);
    // Load independently: a corrupt restore journal must not blank the rest
    // of the overview, and its error must stay out of the page-level alert.
    const [connectionResult, pendingResult] = await Promise.allSettled([
      client.cloudflareStatus(),
      client.pendingRestore(),
    ]);
    if (connectionResult.status === "fulfilled") {
      setConnection(connectionResult.value);
    } else {
      setLocalError(connectionResult.reason);
    }
    if (pendingResult.status === "fulfilled") {
      setPendingRestore(pendingResult.value);
      setPendingError(null);
    } else {
      setPendingRestore(null);
      setPendingError(pendingResult.reason);
    }
  }, [client]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  const refresh = useCallback(() => {
    void configQuery.refetch();
    void statusQuery.refetch();
    void loadLocal();
  }, [configQuery, loadLocal, statusQuery]);

  const error = configQuery.data
    ? localError
    : (configQuery.error ?? statusQuery.error ?? localError);
  const syncError = configQuery.data
    ? (configQuery.error ?? statusQuery.error)
    : null;

  const entryStatus = status.find((item) => item.kind === config?.activeChannel);
  const modelsConfigured = Boolean(config?.butlerModel && config?.taskModel);
  const corruptPendingRecord = pendingError !== null && isCode(pendingError, "RESTORE_JOURNAL_CORRUPT");
  const pendingCheckFailed = pendingError !== null && !corruptPendingRecord;

  const retryRestore = async (useSnapshot: boolean) => {
    setRetrying(useSnapshot ? "snapshot" : "backup");
    setRetryError(null);
    setRetryMessage("");
    try {
      await client.retryRestore(useSnapshot);
      setRetryMessage(t("overview.restoreRetried"));
      invalidate.configAndStatus();
      await loadLocal();
    } catch (cause) {
      setRetryError(cause);
    } finally {
      setRetrying(null);
    }
  };

  const abandonRestore = async () => {
    setAbandoning(true);
    setAbandonError(null);
    try {
      await client.abandonPendingRestore();
      setAbandonOpen(false);
      setRetryError(null);
      setRetryMessage(t("overview.recordCleared"));
      invalidate.configAndStatus();
      await loadLocal();
    } catch (cause) {
      setAbandonError(cause);
    } finally {
      setAbandoning(false);
    }
  };

  const configRows: { page: Page; description: ReactNode }[] = [
    {
      page: "models",
      description: config?.butlerModel ? (
        <>
          {t("overview.butlerModel")}{" "}
          <span data-i18n-ignore>{config.butlerModel.id}</span>
          {" · "}
          {t("overview.taskModel")}{" "}
          {config.taskModel?.id ? (
            <span data-i18n-ignore>{config.taskModel.id}</span>
          ) : (
            t("common.notSet")
          )}
        </>
      ) : (
        t("overview.notConfigured")
      ),
    },
    {
      page: "mcp",
      description:
        mcpCount > 0
          ? t("overview.mcpCount", { count: mcpCount })
          : t("overview.mcpNone"),
    },
    {
      page: "entries",
      description:
        config?.activeChannel === "wechat"
          ? t("overview.channelWechat")
          : config?.activeChannel === "telegram"
            ? t("overview.channelTelegram")
            : t("overview.channelNone"),
    },
  ];

  return (
    <div>
      <PageHeader title={t("shell.pages.overview")} actions={<>
        <SyncStatus
          isFetching={configQuery.isFetching || statusQuery.isFetching}
          isPlaceholder={configQuery.isPlaceholder || statusQuery.isPlaceholder}
          savedAt={configQuery.savedAt ?? statusQuery.savedAt}
          error={syncError}
          onRetry={refresh}
        />
</>} />

      <ErrorAlert error={error} onRetry={refresh} />

      {pendingRestore ? (
        <Card className="mt-4 border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{t("overview.restorePendingTitle")}</h2>
              <Badge variant="outline">
                {pendingRestore.state === "running" ? t("overview.restoreRunning") : t("states.failed")}
              </Badge>
              {pendingRestore.failureCode ? (
                <Badge variant="outline" data-i18n-ignore>{pendingRestore.failureCode}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingRestore.state === "running"
                ? t("overview.restorePendingRunning")
                : t("overview.restorePendingFailed")}
            </p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p className="break-all">{t("overview.backupPath")}<span data-i18n-ignore>{pendingRestore.backupPath}</span></p>
              <p className="break-all">{t("overview.snapshotPath")}{pendingRestore.snapshotPath ? <span data-i18n-ignore>{pendingRestore.snapshotPath}</span> : t("overview.noSnapshot")}</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={retrying !== null}
                onClick={() => void retryRestore(false)}
              >
                {retrying === "backup" ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : null}
                {t("overview.retryRestore")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={retrying !== null || !pendingRestore.snapshotPath}
                onClick={() => void retryRestore(true)}
              >
                {retrying === "snapshot" ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : null}
                {t("overview.retryFromSnapshot")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={retrying !== null || abandoning}
                onClick={() => setAbandonOpen(true)}
              >
                {t("overview.abandonRecord")}
              </Button>
            </div>
            {retryMessage ? (
              <p className="mt-2 text-xs text-muted-foreground">{retryMessage}</p>
            ) : null}
            <ErrorAlert error={retryError} onRetry={() => void retryRestore(false)} />
            <ErrorAlert error={abandonError} />
          </CardContent>
        </Card>
      ) : null}

      {corruptPendingRecord ? (
        <Card className="mt-4 border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <CardContent className="pt-4">
            <h2 className="text-sm font-semibold">{t("overview.corruptTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("overview.corruptDescription")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={abandoning}
                onClick={() => setAbandonOpen(true)}
              >
                {t("overview.abandonRecord")}
              </Button>
            </div>
            <ErrorAlert error={abandonError} />
          </CardContent>
        </Card>
      ) : null}

      {pendingCheckFailed ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("overview.pendingCheckFailed")}
        </p>
      ) : null}

      <Dialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("overview.abandonTitle")}</DialogTitle>
            <DialogDescription>
              {t("overview.abandonDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAbandonOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={abandoning}
              onClick={() => void abandonRestore()}
            >
              {abandoning ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("overview.confirmAbandon")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {connection?.state === "reauth_required" ? (
        <Alert className="mt-4">
          <AlertTitle>{t("overview.authExpired")}</AlertTitle>
          <AlertDescription>{t("overview.authExpiredDescription")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2">
        <div className="min-w-0 p-5">
          <p className="text-xs text-muted-foreground">{t("common.cloudService")}</p>
          <h2 className="mt-2 break-all text-xl font-semibold">{config?.workerName ? <span data-i18n-ignore>{config.workerName}</span> : t("overview.notRead")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("overview.releaseVersion")}{" "}{config?.releaseVersion ? <span data-i18n-ignore>{config.releaseVersion}</span> : t("common.unknown")}</p>
        </div>
        <div className="min-w-0 border-t border-border p-5 sm:border-t-0 sm:border-l">
          <p className="text-xs text-muted-foreground">{t("common.currentChannel")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">{config?.activeChannel ? (config.activeChannel === "wechat" ? t("common.wechat") : t("common.telegram")) : t("common.notSet")}</h2>
            {entryStatus ? <StatusBadge item={entryStatus} /> : <Badge variant="outline">{t("overview.statusUnknown")}</Badge>}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{entryStatus ? formatObserved(entryStatus.observedAt) : t("overview.noVerification")}</p>
        </div>
      </div>

      <section className="mt-6" aria-labelledby="overview-config-title">
        <h2 id="overview-config-title" className="text-base font-medium">{t("overview.configuration")}</h2>
        {configRows.map(({ page, description }) => (
          <div key={page} className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-0">
            <div className="min-w-0"><h3 className="text-sm font-medium">{pageLabel(page)}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{description}</p></div>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t("overview.manage", { name: pageLabel(page) })} onClick={() => navigate(page)}>
              <ArrowRight aria-hidden />
            </Button>
          </div>
        ))}
      </section>

      {config && (!modelsConfigured || !config.activeChannel) ? (
        <section data-testid="overview-todos" className="mt-5 rounded-lg bg-muted/50 p-4" aria-label={t("overview.todosTitle")}>
          <h2 className="mb-2 text-sm font-medium">{t("overview.todosTitle")}</h2>
          {!modelsConfigured ? <Button type="button" variant="outline" size="sm" onClick={() => navigate("models")}>{t("overview.configureModels")}</Button> : null}
          {!config.activeChannel ? <Button type="button" variant="outline" size="sm" onClick={() => navigate("entries")}>{t("overview.connectChannel")}</Button> : null}
        </section>
      ) : null}

      <details className="mt-6 min-w-0 border-t border-border pt-4" data-testid="overview-status-details">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("common.details")}</summary>
        {config ? <p className="mt-3 text-xs text-muted-foreground">{t("overview.traffic", { count: config.activeVersionCount })}</p> : null}
        {status.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{t("common.noStatusData")}</p> : status.map((item) => <StatusRow key={item.kind} item={item} />)}
      </details>

    </div>
  );
}
