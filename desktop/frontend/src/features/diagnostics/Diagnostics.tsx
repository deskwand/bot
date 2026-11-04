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
import { useApp } from "@/components/app-context";
import { ErrorAlert, StatusRow } from "@/components/feedback";
import { SyncStatus } from "@/components/sync-status";
import { useDirty } from "@/components/use-dirty";
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
  const [exportMessage, setExportMessage] = useState("");
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
    setExportMessage("");
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
      setExportMessage(`已导出（${new Blob([json]).size} 字节），敏感字段已脱敏。`);
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
      if (!ref) throw new Error("MODELS_REQUIRED: 请选择要测试的模型。");
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
      <PageHeader title="诊断" actions={<>
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
            导出诊断
          </Button>
        </div>
</>} />

      <ErrorAlert error={error} onRetry={refresh} />
      <ErrorAlert error={exportError} onRetry={exportDiagnostics} retryLabel="重新导出" />
      {exportMessage ? (
        <Alert className="my-4">
          <AlertTitle>导出完成</AlertTitle>
          <AlertDescription>{exportMessage}</AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-5" aria-label="状态检查">
        <div className="mb-3">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Stethoscope className="size-4" aria-hidden />
            状态检查
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            没有证据时显示「未知」。
          </p>
        </div>
        <div>
          {items.length === 0 ? (
            loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                正在加载…
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">暂无状态数据，不代表服务已停止。</p>
            )
          ) : (
            items.map((item) => <StatusRow key={item.kind} item={item} />)
          )}
        </div>
      </section>

      <section className="mt-6 border-t border-border pt-5" aria-label="模型连接测试">
        <div className="mb-3">
          <h2 className="text-base font-medium">模型连接测试</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            用你输入的密钥直连供应商。
          </p>
        </div>
        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="probe-model">模型</Label>
              <ModelSelect id="probe-model" label="模型" value={probeModel} onChange={setProbeModel} options={options} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="probe-key">API 密钥</Label>
              <Input
                id="probe-key"
                type="password"
                value={probeKey}
                onChange={(event) => setProbeKey(event.target.value)}
                placeholder="已有密钥不可读，需重新输入"
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setProbeOpen(true)} disabled={!probeKey.trim() || probeRunning}>
              {probeRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Zap aria-hidden />}
              {probeRunning ? "正在测试…" : "测试模型连接"}
            </Button>
          </div>
          {probeResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">测试结果</span>
                <Badge variant="outline">本机测试</Badge>
              </div>
              <StatusRow item={probeResult} />
            </div>
          ) : null}
          <ErrorAlert error={probeError} onRetry={() => setProbeOpen(true)} retryLabel="重新测试" />
        </div>
      </section>

      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行模型连接测试？</DialogTitle>
            <DialogDescription>
              会真实调用一次模型，可能产生费用；密钥不写入云端。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setProbeOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void probe()} disabled={probeRunning}>
              {probeRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              确认并测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
