import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw, Stethoscope, Zap } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApp } from "@/components/app-context";
import { ErrorAlert, StatusRow } from "@/components/feedback";
import { useDirty } from "@/components/use-dirty";
import type { ModelCatalogDTO, StatusItemDTO } from "@/services/types";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  providerOptions,
} from "@/features/models/catalog";
import { ModelSelect } from "@/features/models/ModelSelect";

export function Diagnostics() {
  const { client } = useApp();
  const [items, setItems] = useState<StatusItemDTO[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await client.status());
      setCatalog(await client.modelCatalog());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

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
      setExportMessage(`诊断导出已生成（${new Blob([json]).size} 字节）。导出内容已按允许字段脱敏。`);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">维护</p>
          <h1 className="text-2xl font-semibold tracking-tight">诊断</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            按证据检查连接，查看来源与观察时间。无法连接服务时，先检查网络和授权；客户端不会把网络失败判定为云端服务停止。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
            重新检查
          </Button>
          <Button type="button" onClick={() => void exportDiagnostics()} disabled={exportRunning}>
            {exportRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Download aria-hidden />}
            导出诊断
          </Button>
        </div>
      </div>

      <ErrorAlert error={error} onRetry={load} />
      <ErrorAlert error={exportError} onRetry={exportDiagnostics} retryLabel="重新导出" />
      {exportMessage ? (
        <Alert className="my-4">
          <AlertTitle>导出完成</AlertTitle>
          <AlertDescription>{exportMessage}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Stethoscope className="size-4" aria-hidden />
            状态证据
          </CardTitle>
          <CardDescription>
            没有日志证据时显示“未知”，不据此宣告故障或实时就绪。心跳不是成功响应的证据。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有可用状态项；这不代表服务停止。</p>
          ) : (
            items.map((item) => <StatusRow key={item.kind} item={item} />)
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>模型连接测试</CardTitle>
          <CardDescription>
            使用本次输入的密钥直接调用供应商，只证明本机路径与当时凭据有效，不验证已部署的 Worker。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="probe-model">模型</Label>
              <ModelSelect id="probe-model" value={probeModel} onChange={setProbeModel} options={options} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="probe-key">API 密钥</Label>
              <Input
                id="probe-key"
                type="password"
                value={probeKey}
                onChange={(event) => setProbeKey(event.target.value)}
                placeholder="已有 secret 不可读；测试需要重新输入"
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
            <span className="text-xs text-muted-foreground">测试前会提示可能产生模型调用费用。</span>
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
        </CardContent>
      </Card>

      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行模型连接测试？</DialogTitle>
            <DialogDescription>
              这会向模型供应商发送一次最小请求，可能产生模型调用费用。测试只用本机内存中的密钥，不写入云端，也不会自动执行。
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
