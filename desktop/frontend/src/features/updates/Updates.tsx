import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Loader2, RefreshCw } from "lucide-react";
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
import type { ResultDTO, UpgradeDTO } from "@/services/types";

declare const __APP_VERSION__: string;

export function Updates() {
  const { client } = useApp();
  const [upgrade, setUpgrade] = useState<UpgradeDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const [runError, setRunError] = useState<unknown>(null);

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
            客户端与云端服务分别更新，由你决定何时升级。升级沿用现有资源与数据，不新增公网管理接口。
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
              <CardDescription>发布包由客户端内置的受信任公钥验证后再上传。</CardDescription>
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
              <Alert>
                <AlertTitle>升级前确认</AlertTitle>
                <AlertDescription>
                  升级会替换 Worker 代码并沿用原 DO namespace、R2 数据、ACTIVE_CHANNEL 和全部 secrets。仅在数据结构兼容时提供回退；密钥更新可能不能随代码回退撤销。
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">尚未读取版本比较结果。</p>
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
              <p className="text-xs text-muted-foreground">
                控制面升级完成不等于业务已恢复。请用真实消息或云端日志证据验证。
              </p>
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
                  继续操作
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
              <CardTitle>桌面客户端</CardTitle>
              <CardDescription>客户端版本与云端版本独立管理。</CardDescription>
            </div>
            <Badge variant="outline">v{__APP_VERSION__}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            本页只显示当前客户端版本。客户端自动更新不在本次范围内，不会自动修改云端服务。
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>升级前确认</DialogTitle>
            <DialogDescription>
              将把云端服务从 {upgrade?.currentVersion || "未知"} 升级到{" "}
              {upgrade?.availableVersion || "未知"}。升级会保留现有资源、数据和 secrets；涉及不可逆迁移时会单独提示。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>兼容性</AlertTitle>
            <AlertDescription>
              客户端已验证发布包签名、配置 schema 与迁移历史。下载或预检失败不会修改远端。
            </AlertDescription>
          </Alert>
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
