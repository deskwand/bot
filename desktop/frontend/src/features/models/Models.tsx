import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, ShieldCheck, Zap } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApp } from "@/components/app-context";
import { ErrorAlert, StateBadge, StatusRow, StepList } from "@/components/feedback";
import { useDirty } from "@/components/use-dirty";
import { toClientError } from "@/services/errors";
import type {
  ConfigDTO,
  ConfigEditDTO,
  ResultDTO,
  SecretEditDTO,
  StatusItemDTO,
} from "@/services/types";
import {
  DEFAULT_MODEL,
  PROVIDERS,
  modelKey,
  parseModelKey,
  secretNameForProvider,
} from "./catalog";
import { ModelSelect } from "./ModelSelect";

export function Models() {
  const { client } = useApp();
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [keyProvider, setKeyProvider] = useState(DEFAULT_MODEL.provider);
  const [apiKey, setApiKey] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [running, setRunning] = useState<"preview" | "publish" | "probe" | null>(null);
  const [previewSteps, setPreviewSteps] = useState<ResultDTO["steps"]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const [success, setSuccess] = useState("");
  const [probeOpen, setProbeOpen] = useState(false);
  const [probeItem, setProbeItem] = useState<StatusItemDTO | null>(null);
  const [probeError, setProbeError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    setConflict(false);
    try {
      const next = await client.getConfig();
      setConfig(next);
      setButler(modelKey(next.butlerModel) || modelKey(DEFAULT_MODEL));
      setTask(modelKey(next.taskModel) || modelKey(DEFAULT_MODEL));
      setKeyProvider(next.butlerModel?.provider ?? DEFAULT_MODEL.provider);
      setApiKey("");
      setClearSecret(false);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const secretName = secretNameForProvider(keyProvider);
  const secretConfigured =
    config?.secrets.find((secret) => secret.name === secretName)?.configured ?? false;

  const dirty = useMemo(() => {
    if (!config) return false;
    return (
      apiKey.length > 0 ||
      clearSecret ||
      modelKey(config.butlerModel) !== butler ||
      modelKey(config.taskModel) !== task
    );
  }, [apiKey, butler, clearSecret, config, task]);
  useDirty(dirty);

  const edit = (): ConfigEditDTO => {
    const secrets: SecretEditDTO[] = [];
    if (clearSecret) {
      secrets.push({ name: secretName, operation: "clear" });
    } else if (apiKey.trim()) {
      secrets.push({ name: secretName, operation: "replace", value: apiKey });
    }
    return {
      baseFingerprint: config?.fingerprint,
      butlerModel: parseModelKey(butler) ?? undefined,
      taskModel: parseModelKey(task) ?? undefined,
      secrets,
    };
  };

  const openPreview = async () => {
    setRunning("preview");
    setError(null);
    setConflict(false);
    setSuccess("");
    try {
      const steps = await client.previewConfig(edit());
      setPreviewSteps(
        steps.map((step) => ({ ...step, state: step.state === "planned" ? "planned" : step.state })),
      );
      setPreviewOpen(true);
    } catch (cause) {
      if (toClientError(cause).code === "CONFIG_CONFLICT") setConflict(true);
      setApiKey("");
      setError(cause);
    } finally {
      setRunning(null);
    }
  };

  const publish = async () => {
    setRunning("publish");
    setError(null);
    try {
      const publishedResult = await client.publishConfig(edit());
      setPreviewOpen(false);
      setResult(publishedResult);
      setClearSecret(false);
      setSuccess(
        publishedResult.state === "published"
          ? "配置已发布。控制面发布完成，不代表云端消息收发已验证。"
          : "发布操作需要继续处理。请查看步骤并继续核实远端状态。",
      );
      await load();
    } catch (cause) {
      setPreviewOpen(false);
      if (toClientError(cause).code === "CONFIG_CONFLICT") setConflict(true);
      setError(cause);
    } finally {
      // Write-only inputs are cleared after every submit attempt.
      setApiKey("");
      setRunning(null);
    }
  };

  const resume = async () => {
    if (!result?.operationId) return;
    setRunning("publish");
    setError(null);
    try {
      setResult(await client.resumeOperation(result.operationId));
      await load();
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(null);
    }
  };

  const probeModelId =
    keyProvider === parseModelKey(butler)?.provider
      ? (parseModelKey(butler)?.id ?? "")
      : (PROVIDERS.find((provider) => provider.id === keyProvider)?.models[0] ?? "");

  const probe = async () => {
    setProbeOpen(false);
    setProbeItem(null);
    setProbeError(null);
    setRunning("probe");
    try {
      const item = await client.probeModel(keyProvider, probeModelId, apiKey);
      setProbeItem(item);
    } catch (cause) {
      setProbeError(cause);
    } finally {
      setRunning(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[40svh] items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        正在读取配置…
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">服务配置</p>
          <h1 className="text-2xl font-semibold tracking-tight">模型</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            管家负责对话与分派，任务模型负责执行。所有消息入口共用这些设置。保存会发布 Worker 配置版本，运行中的请求可能受到发布影响。
          </p>
        </div>
        <Badge variant="outline">
          <ShieldCheck aria-hidden />
          密钥不回显
        </Badge>
      </div>

      <ErrorAlert error={loadError} onRetry={load} />
      <ErrorAlert error={error} onReload={conflict ? load : undefined} reloadLabel="重新加载配置" onRetry={!conflict ? openPreview : undefined} />
      {success ? (
        <Alert className="my-4 border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
          <AlertTitle>已提交</AlertTitle>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      ) : null}
      {result ? (
        <Card className="my-4">
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">发布结果</span>
              <StateBadge state={result.state} />
              {result.operationId ? (
                <span className="text-xs text-muted-foreground">{result.operationId}</span>
              ) : null}
            </div>
            <StepList steps={result.steps ?? []} />
            {result.warnings?.length ? (
              <Alert>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {result.state === "unknown" || result.state === "needs_input" ? (
              <Button type="button" className="mt-2" onClick={() => void resume()} disabled={running === "publish"}>
                {running === "publish" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                继续操作
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>模型供应商</CardTitle>
              <CardDescription>
                密钥只写入 Cloudflare secret；输入框提交后清空，已有值不可读取。
              </CardDescription>
            </div>
            <Badge variant={secretConfigured ? "secondary" : "outline"}>
              {secretName} {secretConfigured ? "已配置" : "未配置"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="key-provider">密钥所属供应商</Label>
              <Select
                value={keyProvider}
                onValueChange={(value) => {
                  setKeyProvider(value);
                  setApiKey("");
                  setClearSecret(false);
                }}
              >
                <SelectTrigger id="key-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key">API 密钥</Label>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value) setClearSecret(false);
                }}
                placeholder={secretConfigured ? "已配置；输入新值才会替换" : "输入新密钥"}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setProbeOpen(true)}
              disabled={!apiKey.trim() || running !== null}
            >
              <Zap aria-hidden />
              测试连接
            </Button>
            <Button
              type="button"
              variant={clearSecret ? "destructive" : "outline"}
              size="sm"
              onClick={() => {
                setClearSecret((current) => !current);
                if (!clearSecret) setApiKey("");
              }}
              disabled={!secretConfigured}
            >
              {clearSecret ? "已标记清除" : "清除已保存密钥"}
            </Button>
            {!apiKey.trim() ? (
              <span className="text-xs text-muted-foreground">
                已有密钥不可读，测试连接需要重新输入密钥。
              </span>
            ) : null}
          </div>
          {probeError ? <ErrorAlert error={probeError} onRetry={() => setProbeOpen(true)} retryLabel="重新测试" /> : null}
          {probeItem ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <StatusRow item={probeItem} />
              <p className="mt-2 text-xs text-muted-foreground">
                本机测试只证明该凭据在这台机器上可用，不代表云端已应用或消息收发正常。
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>角色模型</CardTitle>
          <CardDescription>同一时间只启用一个消息入口；所有入口共用这两个角色模型。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="butler-model">管家模型</Label>
              <ModelSelect id="butler-model" value={butler} onChange={setButler} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-model">任务模型</Label>
              <ModelSelect id="task-model" value={task} onChange={setTask} />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            保存会发布 Worker 配置版本。未编辑的 vars、secrets、bindings 和迁移历史会保留。
          </p>
        </CardContent>
      </Card>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void load()} disabled={running !== null}>
          <RefreshCw aria-hidden />
          重新加载
        </Button>
        <Button type="button" onClick={() => void openPreview()} disabled={running !== null || dirty === false}>
          {running === "preview" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Save aria-hidden />}
          {running === "preview" ? "正在生成预览…" : "保存并发布"}
        </Button>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>确认保存并发布</DialogTitle>
            <DialogDescription>
              将按以下步骤修改当前部署。发布结果与真实消息收发会分开呈现。
            </DialogDescription>
          </DialogHeader>
          <StepList steps={previewSteps ?? []} />
          <Alert>
            <AlertTitle>已知限制</AlertTitle>
            <AlertDescription>
              他人仅替换 secret 值无法被察觉：secret 值不可读取，指纹只能覆盖名称和可读元数据。若其他人在 Cloudflare
              控制台替换了同名 secret 的值，本客户端不能检测或还原。
            </AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">
            读取与上传之间平台没有条件写入能力；若期间发生外部修改，发布后仍会重新核实版本与指纹。
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(false)} disabled={running === "publish"}>
              取消
            </Button>
            <Button type="button" onClick={() => void publish()} disabled={running === "publish"}>
              {running === "publish" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {running === "publish" ? "正在发布…" : "确认保存并发布"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行模型连接测试？</DialogTitle>
            <DialogDescription>
              测试会向模型供应商发送一次最小请求，可能产生模型调用费用。它只证明本机与当时凭据有效，不会验证已部署的
              Worker。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setProbeOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void probe()} disabled={running !== null}>
              {running === "probe" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              确认测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
