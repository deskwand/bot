import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { pageSubtitle, useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorAlert } from "@/components/feedback";
import { formatDateTime, useT, type MessageKey } from "@/i18n";
import { queryKeys, useContainerStatusQuery } from "@/services/queries";
import type { ContainerStatusDTO } from "@/services/types";

export function containerStatusKey(
  status: ContainerStatusDTO | undefined,
): MessageKey {
  if (!status) return "server.statusUnknown";
  if (!status.reachable)
    return status.transport === "local"
      ? "server.statusUnreachableLocal"
      : "server.statusUnreachable";
  if (!status.running) return "server.statusStopped";
  if (status.health !== "healthy") return "server.statusUnhealthy";
  return "server.statusHealthy";
}

export function Server() {
  const { client, refresh, targetKind } = useApp();
  const t = useT();
  const queryClient = useQueryClient();
  const statusQuery = useContainerStatusQuery(targetKind === "container");
  const status = statusQuery.data;
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"restore" | "disconnect" | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const healthy = status?.reachable === true && status.running && status.health === "healthy";

  const restore = async () => {
    setBusy("restore");
    setActionError(null);
    try {
      await client.restoreContainerConfig();
      setRestoreOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.containerStatus }),
        queryClient.invalidateQueries({ queryKey: queryKeys.config }),
      ]);
    } catch (cause) {
      setActionError(cause);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setActionError(null);
    try {
      await client.disconnectContainer();
      setDisconnectOpen(false);
      await refresh(true);
    } catch (cause) {
      setActionError(cause);
      setBusy(null);
    }
  };

  const startedAt = status?.startedAt ? new Date(status.startedAt) : null;
  const startedAtText =
    startedAt && !Number.isNaN(startedAt.getTime())
      ? formatDateTime(startedAt)
      : t("common.unknown");
  // A local target has no address or user, only the runtime that hosts it.
  const local = status?.transport === "local";

  return (
    <div data-testid="server-page">
      <PageHeader
        title={local ? t("server.localTitle") : t("shell.pages.server")}
        subtitle={local ? t("server.subtitleLocal") : pageSubtitle("server")}
      />

      <ErrorAlert error={actionError ?? statusQuery.error} />

      <dl className="max-w-2xl divide-y divide-border rounded-lg border border-border bg-card text-sm">
        {local ? (
          <div className="flex flex-wrap gap-2 p-4">
            <dt className="w-28 shrink-0 text-muted-foreground">
              {t("server.runtime")}
            </dt>
            <dd className="min-w-0 break-all">
              {status?.engine === "compose"
                ? t("server.runtimeCompose")
                : status?.engine === "apple"
                  ? t("server.runtimeApple")
                  : t("common.unknown")}
            </dd>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 p-4">
              <dt className="w-28 shrink-0 text-muted-foreground">{t("server.address")}</dt>
              <dd className="min-w-0 break-all">
                {status?.address ? (
                  <span data-i18n-ignore>{status.address}</span>
                ) : (
                  t("common.unknown")
                )}
              </dd>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              <dt className="w-28 shrink-0 text-muted-foreground">{t("server.user")}</dt>
              <dd className="min-w-0 break-all">
                {status?.user ? (
                  <span data-i18n-ignore>{status.user}</span>
                ) : (
                  t("common.unknown")
                )}
              </dd>
            </div>
          </>
        )}
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">
            {local ? t("server.dirLocal") : t("server.dir")}
          </dt>
          <dd className="min-w-0 break-all">
            {status?.dir ? (
              <span data-i18n-ignore>{status.dir}</span>
            ) : (
              t("common.unknown")
            )}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("server.status")}</dt>
          <dd>
            <Badge variant={healthy ? "secondary" : "destructive"}>
              {t(containerStatusKey(status))}
            </Badge>
          </dd>
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("server.image")}</dt>
          <dd className="min-w-0 break-all">
            {status?.image ? (
              <span data-i18n-ignore>{status.image}</span>
            ) : (
              t("common.unknown")
            )}
          </dd>
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("server.startedAt")}</dt>
          <dd className="min-w-0 break-all">{startedAtText}</dd>
        </div>
        {!local ? (
          <div className="flex flex-wrap gap-2 p-4" data-testid="server-tunnel">
            <dt className="w-28 shrink-0 text-muted-foreground">
              {t("server.tunnel")}
            </dt>
            <dd className="min-w-0 break-all">
              {status?.tunnelOpen ? t("server.tunnelOpen") : t("server.tunnelClosed")}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        {status?.canRestore && !healthy ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setRestoreOpen(true)}
          >
            {busy === "restore" ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : null}
            {t("server.restore")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setDisconnectOpen(true)}
        >
          {busy === "disconnect" ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : null}
          {t("server.disconnect")}
        </Button>
      </div>

      <Dialog open={restoreOpen} onOpenChange={(open) => !open && setRestoreOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("server.restoreTitle")}</DialogTitle>
            <DialogDescription>{t("server.restoreDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={busy !== null} onClick={() => void restore()}>
              {t("server.confirmRestore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disconnectOpen} onOpenChange={(open) => !open && setDisconnectOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {local ? t("server.disconnectTitleLocal") : t("server.disconnectTitle")}
            </DialogTitle>
            <DialogDescription>
              {local
                ? t("server.disconnectDescriptionLocal")
                : t("server.disconnectDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDisconnectOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => void disconnect()}>
              {t("server.confirmDisconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
