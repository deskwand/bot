import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";
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
import { useApp } from "@/components/app-context";
import { ErrorAlert, StatusRow, StatusBadge, formatObserved } from "@/components/feedback";
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
      <PageHeader title="服务概览" actions={<>
<div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
            刷新
          </Button>
        </div>
</>} />

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

      <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2">
        <div className="min-w-0 p-5">
          <p className="text-xs text-muted-foreground">云端服务</p>
          <h2 className="mt-2 break-all text-xl font-semibold">{config?.workerName || "未读取"}</h2>
          <p className="mt-2 text-sm text-muted-foreground">发布版本 {config?.releaseVersion || "未知"}</p>
        </div>
        <div className="min-w-0 border-t border-border p-5 sm:border-t-0 sm:border-l">
          <p className="text-xs text-muted-foreground">当前消息入口</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">{config?.activeChannel ? (config.activeChannel === "wechat" ? "微信" : "Telegram") : "未设置"}</h2>
            {entryStatus ? <StatusBadge item={entryStatus} /> : <Badge variant="outline">状态未知</Badge>}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{entryStatus ? formatObserved(entryStatus.observedAt) : "暂无收发验证记录"}</p>
        </div>
      </div>

      <section className="mt-6" aria-labelledby="overview-config-title">
        <h2 id="overview-config-title" className="text-base font-medium">配置</h2>
        {([
          ["models", "模型", config?.butlerModel ? `管家 ${config.butlerModel.id} · 任务 ${config.taskModel?.id || "未设置"}` : "未配置"],
          ["mcp", "服务", "管理已接入的服务"],
          ["entries", "消息入口", config?.activeChannel === "wechat" ? "当前使用微信" : config?.activeChannel === "telegram" ? "当前使用 Telegram" : "未选择"],
        ] as const).map(([page, title, description]) => (
          <div key={page} className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-0">
            <div className="min-w-0"><h3 className="text-sm font-medium">{title}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{description}</p></div>
            <Button type="button" size="sm" variant="ghost" onClick={() => navigate(page)}>管理 <ArrowRight aria-hidden /></Button>
          </div>
        ))}
      </section>

      {config && (!modelsConfigured || !config.activeChannel) ? (
        <section data-testid="overview-todos" className="mt-5 rounded-lg bg-muted/50 p-4" aria-label="待完成设置">
          <h2 className="mb-2 text-sm font-medium">待完成设置</h2>
          {!modelsConfigured ? <Button type="button" variant="outline" size="sm" onClick={() => navigate("models")}>配置模型</Button> : null}
          {!config.activeChannel ? <Button type="button" variant="outline" size="sm" onClick={() => navigate("entries")}>连接消息入口</Button> : null}
        </section>
      ) : null}

      <details className="mt-6 min-w-0 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">状态详情</summary>
        {config ? <p className="mt-3 text-xs text-muted-foreground">接收流量：{config.activeVersionCount} 个版本</p> : null}
        {status.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">暂无状态数据，服务运行情况未知。</p> : status.map((item) => <StatusRow key={item.kind} item={item} />)}
      </details>

    </div>
  );
}
