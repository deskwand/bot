import { useQueryClient } from "@tanstack/react-query";
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
import { pageLabel, pageSubtitle, useApp, type Page } from "@/components/app-context";
import { ErrorAlert, StatusRow, StatusBadge } from "@/components/feedback";
import { SyncStatus } from "@/components/sync-status";
import { useT, type MessageKey } from "@/i18n";
import { isCode } from "@/services/errors";
import {
  queryKeys,
  useConfigQuery,
  useContainerStatusQuery,
  useInvalidate,
  useLifeVitalsQuery,
  useStatusQuery,
} from "@/services/queries";
import type { ConnectionDTO, PendingRestoreDTO } from "@/services/types";
import { containerStatusKey } from "@/features/server/Server";
import { VitalsCard } from "./VitalsCard";
import { WalletCard } from "./WalletCard";

export function Overview() {
  const { client, navigate, targetKind } = useApp();
  const t = useT();
  const isContainer = targetKind === "container";
  const configQuery = useConfigQuery();
  const statusQuery = useStatusQuery();
  const vitalsQuery = useLifeVitalsQuery(!isContainer);
  const containerQuery = useContainerStatusQuery(isContainer);
  const container = containerQuery.data;
  const refetchVitals = vitalsQuery.refetch;
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  const config = configQuery.data;
  const mcpCount = Array.isArray(config?.mcpServers) ? config.mcpServers.length : 0;
  const status = statusQuery.data ?? [];
  const [connection, setConnection] = useState<ConnectionDTO | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreDTO | null>(null);
  const [pendingError, setPendingError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState<"backup" | "snapshot" | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryMessage, setRetryMessage] = useState<MessageKey | null>(null);
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
    if (!isContainer) void refetchVitals();
    void queryClient.invalidateQueries({ queryKey: queryKeys.walletStatus });
    void loadLocal();
  }, [configQuery, isContainer, loadLocal, queryClient, refetchVitals, statusQuery]);

  const error = configQuery.data
    ? localError
    : (configQuery.error ?? statusQuery.error ?? localError);
  const syncError = configQuery.data
    ? (configQuery.error ?? statusQuery.error)
    : null;

  const entryStatus = status.find((item) => item.kind === config?.activeChannel);
  const modelStatus = status.find((item) => item.kind === "model");
  const modelsConfigured = Boolean(config?.butlerModel && config?.taskModel);
  const corruptPendingRecord = pendingError !== null && isCode(pendingError, "RESTORE_JOURNAL_CORRUPT");
  const pendingCheckFailed = pendingError !== null && !corruptPendingRecord;

  const retryRestore = async (useSnapshot: boolean) => {
    setRetrying(useSnapshot ? "snapshot" : "backup");
    setRetryError(null);
    setRetryMessage(null);
    try {
      await client.retryRestore(useSnapshot);
      setRetryMessage("overview.restoreRetried");
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
      setRetryMessage("overview.recordCleared");
      invalidate.configAndStatus();
      await loadLocal();
    } catch (cause) {
      setAbandonError(cause);
    } finally {
      setAbandoning(false);
    }
  };

  const configRows: { page: Page; description: ReactNode; testId?: string }[] = [
    {
      page: "models",
      description: (
        <>
          {config?.butlerModel ? (
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
          )}
          {modelStatus ? (
            <>
              {" "}
              <StatusBadge item={modelStatus} />
            </>
          ) : null}
        </>
      ),
    },
    {
      page: "search",
      description: config?.searchProvider ? (
        t("overview.searchOn", { provider: config.searchProvider })
      ) : (
        t("overview.notConfigured")
      ),
    },
    {
      page: "entries",
      description: (
        <>
          {config?.activeChannel === "wechat"
            ? t("overview.channelWechat")
            : config?.activeChannel === "telegram"
              ? t("overview.channelTelegram")
              : t("overview.channelNone")}
          {entryStatus ? (
            <>
              {" "}
              <StatusBadge item={entryStatus} />
            </>
          ) : null}
        </>
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
      page: isContainer ? "server" : "cloudflare",
      testId: isContainer ? "health-server" : "health-cloudflare",
      description: isContainer ? (
        <>
          {container ? t(containerStatusKey(container)) : t("overview.notRead")}
          {container?.image ? (
            <>
              {" · "}
              <span data-i18n-ignore>{container.image}</span>
            </>
          ) : null}
        </>
      ) : config?.workerName ? (
        <span data-i18n-ignore>{config.workerName}</span>
      ) : (
        t("overview.notRead")
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t("shell.pages.overview")} subtitle={pageSubtitle("overview")} actions={<>
        <SyncStatus
          isFetching={configQuery.isFetching || statusQuery.isFetching || vitalsQuery.isFetching}
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
              <p className="mt-2 text-xs text-muted-foreground">{t(retryMessage)}</p>
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

      {!isContainer ? <VitalsCard /> : null}

      {!isContainer ? <WalletCard /> : null}

      <section className="mt-6" aria-labelledby="overview-health-title">
        <h2 id="overview-health-title" className="text-base font-medium">{t("overview.health")}</h2>
        {configRows.map(({ page, description, testId }) => (
          <div key={page} data-testid={testId} className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-0">
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
        {config ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {config.activeVersionCount === 1
              ? t("overview.traffic_one", { count: config.activeVersionCount })
              : t("overview.traffic_other", { count: config.activeVersionCount })}
          </p>
        ) : null}
        {status.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{t("common.noStatusData")}</p> : status.map((item) => <StatusRow key={item.kind} item={item} />)}
      </details>

    </div>
  );
}
