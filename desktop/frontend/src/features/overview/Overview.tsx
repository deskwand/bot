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
import { useApp } from "@/components/app-context";
import { ErrorAlert, StatusRow, StateBadge, formatObserved, sourceLabel } from "@/components/feedback";
import type { ConfigDTO, ConnectionDTO, StatusItemDTO } from "@/services/types";

export function Overview({ initialError }: { initialError?: unknown }) {
  const { client, navigate } = useApp();
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [status, setStatus] = useState<StatusItemDTO[]>([]);
  const [connection, setConnection] = useState<ConnectionDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(initialError ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextConfig, nextStatus, nextConnection] = await Promise.all([
        client.getConfig(),
        client.status(),
        client.cloudflareStatus(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setConnection(nextConnection);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const entryStatus = status.find((item) => item.kind === config?.activeChannel);
  const modelsConfigured = Boolean(config?.butlerModel && config?.taskModel);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">我的云端服务</p>
          <h1 className="text-2xl font-semibold tracking-tight">服务概览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {config ? `${config.workerName} · Cloudflare` : "正在读取部署信息"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={config ? "secondary" : "outline"}>
            {config ? "已读取部署配置" : "尚未读取部署配置"}
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
            重新检查
          </Button>
        </div>
      </div>

      <ErrorAlert error={error} onRetry={load} />

      {connection?.state === "reauth_required" ? (
        <Alert className="mt-4">
          <AlertTitle>Cloudflare 授权已过期，请重新登录</AlertTitle>
          <AlertDescription>部署和诊断会暂停，直到你重新登录。</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>云端服务</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Server className="size-5 text-muted-foreground" aria-hidden />
              {config ? "已读取部署配置" : "状态未知"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {config ? (
              <>
                <p className="text-xs text-muted-foreground">来源：Cloudflare 配置 · {formatObserved(new Date().toISOString())}</p>
                <p>当前发布版本 {config.releaseVersion || "未知"}</p>
                <p>接收流量的版本数 {config.activeVersionCount}</p>
              </>
            ) : (
              <p>无法读取当前部署。API 失败不等于服务停止。</p>
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
                <p className="mt-2">
                  已配置或已选择不等于云端收发正常。没有云端证据时不会显示“收发已验证”。
                </p>
              </>
            ) : (
              <p>连接消息入口后开始使用。同一时间只启用一个入口。</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>状态证据</CardTitle>
          <CardDescription>
            每项状态都注明来源和检查时间。本机测试通过不等于云端收发正常。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有可用状态证据；这不代表服务停止。</p>
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
            description={config ? `${config.workerName}` : "尚未读取到部署"}
          />
          <ChecklistRow
            done={modelsConfigured}
            title="配置模型"
            description={
              config?.butlerModel
                ? `管家 ${config.butlerModel.id} · 任务 ${config.taskModel?.id ?? "未设置"}`
                : "尚未配置角色模型"
            }
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => navigate("models")}>
                查看设置 <ArrowRight aria-hidden />
              </Button>
            }
          />
          <ChecklistRow
            done={Boolean(config?.activeChannel)}
            title="连接微信或 Telegram"
            description={config?.activeChannel ? "当前入口已发布；请用真实消息验证" : "尚未选择消息入口"}
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => navigate("entries")}>
                设置消息入口 <ArrowRight aria-hidden />
              </Button>
            }
          />
        </CardContent>
      </Card>

      <Alert className="mt-4">
        <AlertTitle>客户端关闭后云端继续运行</AlertTitle>
        <AlertDescription>
          配置发布只证明 Cloudflare 接受了版本。真实收发需要云端日志证据，或由你确认收到回复；两者会分别展示。
        </AlertDescription>
      </Alert>
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
