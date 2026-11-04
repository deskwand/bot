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
import { describeCode } from "@/services/errors";
import type {
  ResultDTO,
  UpgradeDTO,
} from "@/services/types";

declare const __APP_VERSION__: string;

export function Updates() {
  const { client, navigateImport } = useApp();
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
      await load();
    } catch (cause) {
      setRunError(cause);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">维护</p>
          <h1 className="text-2xl font-semibold tracking-tight">更新</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            客户端和云端分开更新，由你决定何时升级。
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
          检查云端版本
        </Button>
      </div>

      <ErrorAlert error={error} onRetry={load} />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpCircle className="size-4" aria-hidden />
                云端服务
              </CardTitle>
              <CardDescription>上传前会验证发布包签名。</CardDescription>
            </div>
            {upgrade?.available ? (
              <Badge>有新版本</Badge>
            ) : (
              <Badge variant="outline">{upgrade?.reason === "UP_TO_DATE" ? "已是最新" : "无需升级"}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {upgrade ? (
            <div className="space-y-2 text-sm">
              <p>
                当前 {upgrade.currentVersion || "未知"} → 可用 {upgrade.availableVersion || "未知"}
              </p>
              {upgrade.reason ? (
                <p className="text-muted-foreground">
                  {upgrade.reason}：{describeCode(upgrade.reason)}
                </p>
              ) : null}
              {upgrade.modelKeysMissing?.length ? (
                <Alert>
                  <AlertTitle>模型 key 需要重新填写</AlertTitle>
                  <AlertDescription>
                    升级后需在模型页重填：{upgrade.modelKeysMissing.join("、")}
                  </AlertDescription>
                </Alert>
              ) : null}
              {upgrade.reason === "VERSION_UNKNOWN_REIMPORT" ? (
                <Button type="button" size="sm" variant="outline" onClick={navigateImport}>
                  重新导入
                </Button>
              ) : null}
              <Alert>
                <AlertTitle>升级前确认</AlertTitle>
                <AlertDescription>
                  沿用现有数据、资源和密钥。
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">正在读取版本信息。</p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={!upgrade?.available || running}
            >
              {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {running ? "正在升级…" : "升级云端服务"}
            </Button>
          </div>
          {result ? (
            <div className="mt-4 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">升级结果</span>
                <StateBadge state={result.state} />
              </div>
              <StepList steps={result.steps ?? []} />
              <p className="text-xs text-muted-foreground">已发布，接着验证收发。</p>
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
                      .then(setResult)
                      .catch(setRunError)
                      .finally(() => setRunning(false));
                  }}
                >
                  继续
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={runError} onRetry={() => setConfirmOpen(true)} retryLabel="重新升级" />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Download className="size-4" aria-hidden />
                桌面客户端
              </CardTitle>
              <CardDescription>
                后台每 6 小时检查一次，有新版本会弹窗询问，你确认后才安装。
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
              检查客户端更新
            </Button>
          </div>
          {clientChecked ? (
            <p className="mt-2 text-xs text-muted-foreground">已打开更新窗口</p>
          ) : null}
          <ErrorAlert error={clientError} onRetry={checkClientUpdates} retryLabel="重试" />
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>升级前确认</DialogTitle>
            <DialogDescription>
              从 {upgrade?.currentVersion || "未知"} 升级到 {upgrade?.availableVersion || "未知"}，保留资源和数据。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>兼容性</AlertTitle>
            <AlertDescription>
              签名、schema 和迁移历史已验证；失败不会改云端。
            </AlertDescription>
          </Alert>
          {upgrade?.modelKeysMissing?.length ? (
            <Alert>
              <AlertTitle>模型 key 需要重新填写</AlertTitle>
              <AlertDescription>
                升级后需在模型页重填：{upgrade.modelKeysMissing.join("、")}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void upgradeCloud()}>
              确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
