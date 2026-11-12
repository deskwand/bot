import { PageHeader } from "@/components/page-header";
import { useMemo, useState } from "react";
import { Download, Loader2, Stethoscope, Zap } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert, StatusRow } from "@/components/feedback";
import { SyncStatus } from "@/components/sync-status";
import { useDirty } from "@/components/use-dirty";
import { useT, type MessageKey } from "@/i18n";
import { useModelCatalogQuery, useStatusQuery } from "@/services/queries";
import type { StatusItemDTO } from "@/services/types";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  providerOptions,
} from "@/features/models/catalog";
import { ModelSelect } from "@/features/models/ModelSelect";

export function Diagnostics() {
  const { client } = useApp();
  const t = useT();
  const statusQuery = useStatusQuery();
  const catalogQuery = useModelCatalogQuery();
  const items = statusQuery.data ?? [];
  const catalog = catalogQuery.data ?? null;
  const loading = !statusQuery.data && statusQuery.isFetching;
  const error =
    statusQuery.error && !statusQuery.data
      ? statusQuery.error
      : catalogQuery.error && !catalogQuery.data
        ? catalogQuery.error
        : null;
  const [exportRunning, setExportRunning] = useState(false);
  const [exportMessage, setExportMessage] = useState<{
    key: MessageKey;
    params?: Record<string, string | number>;
  } | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);

  const [probeModel, setProbeModel] = useState(modelKey(DEFAULT_MODEL));
  const [probeKey, setProbeKey] = useState("");
  const [probeOpen, setProbeOpen] = useState(false);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState<StatusItemDTO | null>(null);
  const [probeError, setProbeError] = useState<unknown>(null);
  useDirty(probeKey.length > 0);

  const refresh = () => {
    void statusQuery.refetch();
    void catalogQuery.refetch();
  };

  const options = useMemo(
    () => providerOptions(catalog ?? { providers: [] }, []),
    [catalog],
  );

  const exportDiagnostics = async () => {
    setExportRunning(true);
    setExportError(null);
    setExportMessage(null);
    try {
      const json = await client.exportDiagnostics();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `deskwand-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportMessage({
        key: "diagnostics.exported",
        params: { size: new Blob([json]).size },
      });
    } catch (cause) {
      setExportError(cause);
    } finally {
      setExportRunning(false);
    }
  };

  const probe = async () => {
    setProbeOpen(false);
    setProbeRunning(true);
    setProbeError(null);
    setProbeResult(null);
    const ref = parseModelKey(probeModel);
    try {
      if (!ref) throw new Error(`MODELS_REQUIRED: ${t("diagnostics.selectModel")}`);
      setProbeResult(await client.probeModel(ref.provider, ref.id, probeKey, "", ""));
    } catch (cause) {
      setProbeError(cause);
    } finally {
      setProbeKey("");
      setProbeRunning(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("shell.pages.diagnostics")} subtitle={pageSubtitle("diagnostics")} actions={<>
<div className="flex flex-wrap gap-2">
          <SyncStatus
            isFetching={statusQuery.isFetching}
            isPlaceholder={statusQuery.isPlaceholder}
            savedAt={statusQuery.savedAt}
            error={statusQuery.data ? statusQuery.error : null}
            onRetry={refresh}
          />
          <Button type="button" onClick={() => void exportDiagnostics()} disabled={exportRunning}>
            {exportRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Download aria-hidden />}
            {t("diagnostics.export")}
          </Button>
        </div>
</>} />

      <ErrorAlert error={error} onRetry={refresh} />
      <ErrorAlert error={exportError} onRetry={exportDiagnostics} retryLabel={t("diagnostics.reexport")} />
      {exportMessage ? (
        <Alert className="my-4">
          <AlertTitle>{t("diagnostics.exportDone")}</AlertTitle>
          <AlertDescription>{t(exportMessage.key, exportMessage.params)}</AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-5" aria-label={t("diagnostics.statusCheck")}>
        <div className="mb-3">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Stethoscope className="size-4" aria-hidden />
            {t("diagnostics.statusCheck")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("diagnostics.unknownHint")}
          </p>
        </div>
        <div>
          {items.length === 0 ? (
            loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                {t("shell.pageLoading")}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.noStatusData")}</p>
            )
          ) : (
            items.map((item) => <StatusRow key={item.kind} item={item} />)
          )}
        </div>
      </section>

      <section className="mt-6 border-t border-border pt-5" aria-label={t("diagnostics.probeTitle")}>
        <div className="mb-3">
          <h2 className="text-base font-medium">{t("diagnostics.probeTitle")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("diagnostics.probeDescription")}
          </p>
        </div>
        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="probe-model">{t("diagnostics.model")}</Label>
              <ModelSelect id="probe-model" label={t("diagnostics.model")} value={probeModel} onChange={setProbeModel} options={options} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="probe-key">{t("diagnostics.apiKey")}</Label>
              <Input
                id="probe-key"
                type="password"
                value={probeKey}
                onChange={(event) => setProbeKey(event.target.value)}
                placeholder={t("diagnostics.apiKeyPlaceholder")}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setProbeOpen(true)} disabled={!probeKey.trim() || probeRunning}>
              {probeRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Zap aria-hidden />}
              {probeRunning ? t("diagnostics.probing") : t("diagnostics.probeButton")}
            </Button>
          </div>
          {probeResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("diagnostics.probeResult")}</span>
                <Badge variant="outline">{t("states.sources.local")}</Badge>
              </div>
              <StatusRow item={probeResult} />
            </div>
          ) : null}
          <ErrorAlert error={probeError} onRetry={() => setProbeOpen(true)} retryLabel={t("diagnostics.retest")} />
        </div>
      </section>

      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("diagnostics.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("diagnostics.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setProbeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void probe()} disabled={probeRunning}>
              {probeRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {t("diagnostics.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
