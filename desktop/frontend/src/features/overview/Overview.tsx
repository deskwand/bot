import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, RefreshCw, Server } from "lucide-react";
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
import { ErrorAlert, StatusRow, StateBadge, formatObserved, sourceLabel } from "@/components/feedback";
import { isCode } from "@/services/errors";
import type { ConfigDTO, ConnectionDTO, PendingRestoreDTO, StatusItemDTO } from "@/services/types";

export function Overview({ initialError }: { initialError?: unknown }) {
  const { client, navigate } = useApp();
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [status, setStatus] = useState<StatusItemDTO[]>([]);
  const [connection, setConnection] = useState<ConnectionDTO | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreDTO | null>(null);
  const [pendingError, setPendingError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState<"backup" | "snapshot" | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryMessage, setRetryMessage] = useState("");
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [abandonError, setAbandonError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(initialError ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPendingError(null);
    // Load independently: a corrupt restore journal must not blank the rest
    // of the overview, and its error must stay out of the page-level alert.
    const [configResult, statusResult, connectionResult, pendingResult] = await Promise.allSettled([
      client.getConfig(),
      client.status(),
      client.cloudflareStatus(),
      client.pendingRestore(),
    ]);
    if (configResult.status === "fulfilled") {
      setConfig(configResult.value);
    } else {
      setError(configResult.reason);
    }
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
    } else {
      setError(statusResult.reason);
    }
    if (connectionResult.status === "fulfilled") {
      setConnection(connectionResult.value);
    } else {
      setError(connectionResult.reason);
    }
    if (pendingResult.status === "fulfilled") {
      setPendingRestore(pendingResult.value);
      setPendingError(null);
    } else {
      setPendingRestore(null);
      setPendingError(pendingResult.reason);
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

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
      setRetryMessage("恢复已重新执行。");
      await load();
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
      setRetryMessage("已清除本机记录，云端未改动。");
      await load();
    } catch (cause) {
      setAbandonError(cause);
    } finally {
      setAbandoning(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">我的云端服务</p>
          <h1 className="text-2xl font-semibold tracking-tight">服务概览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {config ? `${config.workerName} · Cloudflare` : "正在读取…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
            刷新
          </Button>
        </div>
      </div>

      <ErrorAlert error={error} onRetry={load} />

      {pendingRestore ? (
        <Card className="mt-4 border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">数据恢复未完成</h2>
              <Badge variant="outline">
                {pendingRestore.state === "running" ? "进行中" : "失败"}
              </Badge>
              {pendingRestore.failureCode ? (
                <Badge variant="outline">{pendingRestore.failureCode}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingRestore.state === "running"
                ? "上次恢复没有正常结束。云端可能只写入了一部分。"
                : "上次恢复中途失败。云端可能只写入了一部分。"}
            </p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p className="break-all">备份：{pendingRestore.backupPath}</p>
              <p className="break-all">恢复前快照：{pendingRestore.snapshotPath || "无"}</p>
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
                重试恢复
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
                回到恢复前快照
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={retrying !== null || abandoning}
                onClick={() => setAbandonOpen(true)}
              >
                放弃记录
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
            <h2 className="text-sm font-semibold">本机恢复记录无法读取</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              记录已损坏，读不出重试需要的信息。放弃只删本机记录，不碰云端数据。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={abandoning}
                onClick={() => setAbandonOpen(true)}
              >
                放弃记录
              </Button>
            </div>
            <ErrorAlert error={abandonError} />
          </CardContent>
        </Card>
      ) : null}

      {pendingCheckFailed ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          暂时无法检查未完成的恢复，请刷新。
        </p>
      ) : null}

      <Dialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>放弃未完成的恢复记录？</DialogTitle>
            <DialogDescription>
              只删除本机记录，不恢复也不回滚云端数据。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAbandonOpen(false)}>
              取消
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
              确认放弃记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {connection?.state === "reauth_required" ? (
        <Alert className="mt-4">
          <AlertTitle>授权已过期</AlertTitle>
          <AlertDescription>重新登录后可继续。</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>云端服务</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Server className="size-5 text-muted-foreground" aria-hidden />
              {config ? config.workerName : "未读取"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {config ? (
              <>
                <p>发布版本 {config.releaseVersion || "未知"}</p>
                <p>接收流量：{config.activeVersionCount} 个版本</p>
              </>
            ) : (
              <p>读取失败，请稍后重试。</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>消息入口</CardDescription>
            <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
              {config?.activeChannel ? (config.activeChannel === "wechat" ? "微信" : "Telegram") : "未设置"}
              {entryStatus ? <StateBadge state={entryStatus.state} /> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {entryStatus ? (
              <>
                <p>来源：{sourceLabel(entryStatus.source)}</p>
                <p>{formatObserved(entryStatus.observedAt)}</p>
              </>
            ) : (
              <p>还没有连接入口。</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>状态证据</CardTitle>
          <CardDescription>
            每项都标明来源和检查时间。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无状态数据。这不代表服务停止。</p>
          ) : (
            status.map((item) => <StatusRow key={item.kind} item={item} />)
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>完成你的设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ChecklistRow
            done={Boolean(config)}
            title="云端服务已部署"
            description={config ? `${config.workerName}` : "尚未部署"}
          />
          <ChecklistRow
            done={modelsConfigured}
            title="配置模型"
            description={
              config?.butlerModel
                ? `管家 ${config.butlerModel.id} · 任务 ${config.taskModel?.id ?? "未设置"}`
                : "未配置"
            }
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => navigate("models")}>
                去设置 <ArrowRight aria-hidden />
              </Button>
            }
          />
          <ChecklistRow
            done={Boolean(config?.activeChannel)}
            title="连接微信或 Telegram"
            description={config?.activeChannel ? "已发布，待验证收发" : "未选择"}
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => navigate("entries")}>
                去设置 <ArrowRight aria-hidden />
              </Button>
            }
          />
        </CardContent>
      </Card>

    </div>
  );
}

function ChecklistRow({
  done,
  title,
  description,
  action,
}: {
  done: boolean;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex size-6 items-center justify-center rounded-full text-xs ${
            done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground"
          }`}
          aria-hidden
        >
          {done ? "✓" : "·"}
        </span>
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
      </div>
      {action}
    </div>
  );
}
