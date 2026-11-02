import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorAlert, StateBadge, StepList } from "@/components/feedback";
import { useDirty } from "@/components/use-dirty";
import { toClientError } from "@/services/errors";
import { useApp } from "@/components/app-context";
import { useUiStore } from "@/store/ui";
import type { ImportPreviewDTO, ResultDTO, WorkerDTO } from "@/services/types";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  parseUserIDs,
  providerOptions,
  type ProviderOption,
} from "@/features/models/catalog";
import { ModelSelect } from "@/features/models/ModelSelect";

export type SetupPhase = "disconnected" | "choose";

const PERMISSIONS = [
  ["Workers Scripts", "Edit", "发布 Worker、版本与部署", false],
  ["Workers R2 Storage", "Edit", "创建并保留文件存储桶", false],
  ["Account Settings", "Read", "读取账号与资源信息", false],
  ["Workers Observability", "Edit", "读取脱敏运行事件并配置日志（诊断）", true],
] as const;

function useCatalogModelOptions(): {
  options: ProviderOption[];
  error: unknown;
  reload: () => void;
} {
  const { client } = useApp();
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .modelCatalog()
      .then((catalog) => {
        if (!cancelled) setOptions(providerOptions(catalog, []));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  return { options, error, reload };
}

export function Setup({
  phase,
  connectionError,
  onSessionChange,
  onReady,
  initialStep = "welcome",
}: {
  phase: SetupPhase;
  connectionError?: unknown;
  onSessionChange: () => void;
  onReady: () => void;
  initialStep?: "welcome" | "deploy" | "import";
}) {
  const [step, setStep] = useState<"welcome" | "deploy" | "import">(initialStep);

  if (phase === "disconnected") {
    return (
      <Welcome
        connectionError={connectionError}
        onConnected={onSessionChange}
        onShowDeploy={() => setStep("deploy")}
        onShowImport={() => setStep("import")}
      />
    );
  }

  if (step === "deploy") {
    return <DeployFlow onBack={() => setStep("welcome")} onReady={onReady} />;
  }
  if (step === "import") {
    return <ImportFlow onBack={() => setStep("welcome")} onReady={onReady} />;
  }

  return (
    <Welcome
      connected
      onConnected={onSessionChange}
      onShowDeploy={() => setStep("deploy")}
      onShowImport={() => setStep("import")}
    />
  );
}

function Welcome({
  connected = false,
  connectionError,
  onConnected,
  onShowDeploy,
  onShowImport,
}: {
  connected?: boolean;
  connectionError?: unknown;
  onConnected: () => void;
  onShowDeploy: () => void;
  onShowImport: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">让云端服务更容易开始</p>
      <h1 className="text-3xl font-semibold tracking-tight">部署一次，随时管理。</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        将 DeskWand Bot 运行在你自己的 Cloudflare 账号中。这个客户端帮你完成部署、配置和日常维护。
      </p>

      {!connected ? (
        <ConnectCard connectionError={connectionError} onConnected={onConnected} />
      ) : (
        <>
          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              className="text-left"
              onClick={onShowDeploy}
              aria-label="部署新服务"
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Cloud className="size-4" aria-hidden />
                    部署新服务
                  </CardTitle>
                  <CardDescription>第一次使用？从检查资源开始，发布一套新的云端服务。</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                    开始部署 <ArrowRight className="size-4" aria-hidden />
                  </span>
                </CardContent>
              </Card>
            </button>
            <button
              type="button"
              className="text-left"
              onClick={onShowImport}
              aria-label="连接已有服务"
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <RefreshCw className="size-4" aria-hidden />
                    连接已有服务
                  </CardTitle>
                  <CardDescription>接管已部署的 DeskWand Bot，保留现有数据和 Cloudflare secret。</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                    连接 <ArrowRight className="size-4" aria-hidden />
                  </span>
                </CardContent>
              </Card>
            </button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            目前支持 Cloudflare · 服务在客户端关闭后继续运行
          </p>
        </>
      )}
    </div>
  );
}

function ConnectCard({
  connectionError,
  onConnected,
}: {
  connectionError?: unknown;
  onConnected: () => void;
}) {
  const { client } = useApp();
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = accountId.length > 0 || token.length > 0;
  useDirty(dirty);

  const connect = async () => {
    setRunning(true);
    setError(null);
    try {
      await client.connectCloudflare(accountId.trim(), token);
      setToken("");
      onConnected();
    } catch (cause) {
      setToken("");
      setError(cause);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="mt-7">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden />
          连接你的 Cloudflare
        </CardTitle>
        <CardDescription>
          使用你自己的账号。API token 只保存在系统凭据库，前端不会读回；客户端不会把 token 写入浏览器存储。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorAlert error={connectionError} />
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="account-id">Cloudflare 账户 ID</Label>
            <Input
              id="account-id"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="32 位十六进制账户 ID"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-token">API Token</Label>
            <Input
              id="api-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="只写入一次，提交后清空"
              autoComplete="new-password"
              spellCheck={false}
              required
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void client.openTokenPage().catch(() => undefined);
              }}
            >
              <ExternalLink aria-hidden />
              打开 Cloudflare 创建令牌
            </Button>
            <Button type="submit" disabled={running || !accountId.trim() || !token.trim()}>
              {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {running ? "正在验证令牌…" : "连接 Cloudflare"}
            </Button>
          </div>
        </form>

        <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4" aria-hidden />
            所需权限（账户范围）
          </div>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {PERMISSIONS.map(([group, level, reason, optional]) => (
              <li key={group} className="flex flex-wrap items-baseline gap-2">
                <Badge variant="outline" className="font-mono text-[11px]">
                  {group}:{level}
                </Badge>
                {optional ? <Badge variant="outline">可选</Badge> : null}
                <span>{reason}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            可选的 Workers Observability:Edit 对应 API 权限组 “Workers Observability Write”；没有该权限时，诊断会显示未知，而不会伪造成功。
          </p>
        </div>

        <ErrorAlert error={error} onRetry={connect} retryLabel="重新连接" />
      </CardContent>
    </Card>
  );
}

function GuardedBack({
  dirty,
  onBack,
  label = "返回",
}: {
  dirty: boolean;
  onBack: () => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2"
        onClick={() => (dirty ? setOpen(true) : onBack())}
      >
        <ArrowLeft aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>有未保存的更改</DialogTitle>
            <DialogDescription>返回会丢弃当前表单内容，不会修改云端配置。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              继续编辑
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                onBack();
              }}
            >
              放弃更改并返回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeployFlow({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const { client } = useApp();
  const { options: modelOptions, error: catalogError, reload: reloadCatalog } =
    useCatalogModelOptions();
  const setPage = useUiStore((state) => state.setPage);
  const [workerName, setWorkerName] = useState("deskwand-bot");
  const [bucketName, setBucketName] = useState("deskwand-files");
  const [ownerIDs, setOwnerIDs] = useState("");
  const [channel, setChannel] = useState("");
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const initial = useRef({ workerName: "deskwand-bot", bucketName: "deskwand-files" });
  const dirty =
    workerName !== initial.current.workerName ||
    bucketName !== initial.current.bucketName ||
    ownerIDs.length > 0 ||
    channel.length > 0;
  useDirty(dirty && !result);

  const checkAndInstall = async () => {
    setError(null);
    setChecking(true);
    setProgress(8);
    try {
      const scripts = await client.listWorkers();
      setWorkers(scripts);
      if (scripts.some((script) => script.name === workerName.trim())) {
        setError(
          new Error("NAME_TAKEN: Worker 名称已被占用。请换一个名称，或改用“连接已有服务”。"),
        );
        return;
      }
      const butlerModel = parseModelKey(butler);
      const taskModel = parseModelKey(task);
      if (!butlerModel || !taskModel) {
        setError(new Error("MODELS_REQUIRED: 请选择管家模型和任务模型。"));
        return;
      }
      setProgress(25);
      setRunning(true);
      const installed = await client.install({
        accountId: "",
        workerName: workerName.trim(),
        bucketName: bucketName.trim(),
        telegramUserIds: parseUserIDs(ownerIDs),
        butlerModel,
        taskModel,
        activeChannel: channel,
      });
      setProgress(100);
      setResult(installed);
    } catch (cause) {
      setError(cause);
    } finally {
      setChecking(false);
      setRunning(false);
    }
  };

  const resume = async () => {
    if (!result) return;
    setRunning(true);
    setError(null);
    try {
      const resumed = await client.resumeOperation(result.operationId);
      setResult(resumed);
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(false);
    }
  };

  const published = result?.state === "published";
  const installErrorCode = error ? toClientError(error).code : "";
  const installRetryBlocked =
    installErrorCode === "OPERATION_IN_PROGRESS" || installErrorCode === "INSTALL_CONFLICT";

  return (
    <div className="mx-auto max-w-3xl">
      <GuardedBack dirty={dirty} onBack={onBack} />
      <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">新建服务</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        {published ? "服务已部署，接下来设置消息入口" : "部署前，确认这些信息"}
      </h1>

      {!result ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>部署检查</CardTitle>
            <CardDescription>
              将创建一个 Worker 和一个 R2 存储桶。实际费用以 Cloudflare 用量和套餐为准。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorAlert
              error={catalogError}
              onRetry={reloadCatalog}
              retryLabel="重新读取模型目录"
            />
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void checkAndInstall();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="worker-name">服务名称</Label>
                  <Input
                    id="worker-name"
                    value={workerName}
                    onChange={(event) => setWorkerName(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bucket-name">R2 存储桶名称</Label>
                  <Input
                    id="bucket-name"
                    value={bucketName}
                    onChange={(event) => setBucketName(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="install-owners">允许使用的 Telegram 用户 ID</Label>
                  <Input
                    id="install-owners"
                    value={ownerIDs}
                    onChange={(event) => setOwnerIDs(event.target.value)}
                    placeholder="可留空；发布 owner 前 Worker 会忽略所有消息"
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="install-butler">管家模型</Label>
                  <ModelSelect id="install-butler" value={butler} onChange={setButler} options={modelOptions} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="install-task">任务模型</Label>
                  <ModelSelect id="install-task" value={task} onChange={setTask} options={modelOptions} />
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">初始消息入口</legend>
                <p className="text-xs text-muted-foreground">
                  必须显式选择。同一时间只启用一个入口；未就绪的入口会暂时不可用，不会自动切换。
                </p>
                <RadioGroup
                  value={channel}
                  onValueChange={setChannel}
                  aria-label="初始消息入口"
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                    <RadioGroupItem value="telegram" id="install-channel-telegram" />
                    <span>Telegram</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                    <RadioGroupItem value="wechat" id="install-channel-wechat" />
                    <span>微信</span>
                  </label>
                </RadioGroup>
              </fieldset>

              <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <Check className="size-4 text-emerald-600" aria-hidden />
                  Cloudflare 账户已连接
                </div>
                <p className="mt-1">
                  部署前会检查名称冲突、Worker 与 R2 可用性。中断后会保留进度，可稍后继续。
                </p>
                {workers.length > 0 ? <p className="mt-1">已检查 {workers.length} 个现有 Worker 名称。</p> : null}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <GuardedBack dirty={dirty} onBack={onBack} label="上一步" />
                <Button
                  type="submit"
                  disabled={
                    checking ||
                    running ||
                    !workerName.trim() ||
                    !bucketName.trim() ||
                    !channel
                  }
                >
                  {checking || running ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {running ? "正在部署…" : checking ? "正在检查…" : "检查并部署"}
                </Button>
              </div>
            </form>

            {checking || running ? (
              <div className="mt-5" aria-live="polite">
                <Progress value={progress} aria-label="部署进度" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {progress < 30 ? "正在创建并检查资源…" : "正在发布服务包并核实部署…"}
                </p>
              </div>
            ) : null}
            <ErrorAlert
              error={error}
              onRetry={installRetryBlocked ? undefined : checkAndInstall}
              retryLabel="重新检查并部署"
            />
          </CardContent>
        </Card>
      ) : (
        <ResultPanel
          title={published ? "服务已部署" : "部署需要继续处理"}
          result={result}
          running={running}
          error={error}
          onResume={result.state === "unknown" || result.state === "needs_input" ? resume : undefined}
        >
          {published ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  setPage("models");
                  onReady();
                }}
              >
                设置模型 <ArrowRight aria-hidden />
              </Button>
              <Button type="button" variant="outline" onClick={onReady}>
                进入管理首页
              </Button>
            </div>
          ) : null}
        </ResultPanel>
      )}
    </div>
  );
}

function ImportFlow({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const { client } = useApp();
  const { options: modelOptions, error: catalogError, reload: reloadCatalog } =
    useCatalogModelOptions();
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [ownerIDs, setOwnerIDs] = useState("");
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const dirty = Boolean(selected || ownerIDs || Object.values(secrets).some(Boolean));
  useDirty(dirty && !result);

  const loadWorkers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWorkers(await client.listWorkers());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  const inspect = async (scriptName: string) => {
    setSelected(scriptName);
    setPreview(null);
    setResult(null);
    setError(null);
    setSubmitError(null);
    setRunning(true);
    try {
      await client.selectDeployment(scriptName);
      setPreview(await client.inspectImport());
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setRunning(true);
    setSubmitError(null);
    try {
      const butlerModel = parseModelKey(butler);
      const taskModel = parseModelKey(task);
      if (!butlerModel || !taskModel) {
        throw new Error("MODELS_REQUIRED: 请选择管家模型和任务模型。");
      }
      const confirmed = await client.confirmImport({
        baseFingerprint: "",
        telegramUserIds: parseUserIDs(ownerIDs),
        butlerModel,
        taskModel,
        secrets: Object.entries(secrets)
          .filter(([, value]) => value.trim().length > 0)
          .map(([name, value]) => ({ name, value })),
      });
      setResult(confirmed);
    } catch (cause) {
      setSubmitError(cause);
    } finally {
      setSecrets({});
      setRunning(false);
    }
  };

  const resume = async () => {
    if (!result?.operationId) return;
    setRunning(true);
    setSubmitError(null);
    try {
      setResult(await client.resumeOperation(result.operationId));
    } catch (cause) {
      setSubmitError(cause);
    } finally {
      setRunning(false);
    }
  };

  const published = result?.state === "published";
  const requiredSecrets = preview?.plaintextSecrets?.map((entry) => entry.secretName) ?? [];
  const canRetryImport = requiredSecrets.every(
    (name) => (secrets[name] ?? "").trim().length > 0,
  );

  return (
    <div className="mx-auto max-w-3xl">
      <GuardedBack dirty={dirty} onBack={onBack} />
      <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">已有部署</p>
      <h1 className="text-2xl font-semibold tracking-tight">连接已有服务</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        授权后选择要管理的服务。接管时保留已有任务、记忆、文件和 Cloudflare secret。
      </p>

      <ErrorAlert
        error={catalogError}
        onRetry={reloadCatalog}
        retryLabel="重新读取模型目录"
      />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>候选 Worker</CardTitle>
              <CardDescription>通过绑定和发布元数据识别；名称本身不足以证明归属。</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadWorkers()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workers.length === 0 && !loading ? (
            <p className="text-sm text-muted-foreground">没有找到可连接的 Worker。</p>
          ) : null}
          <ul className="space-y-2">
            {workers.map((worker) => (
              <li key={worker.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div>
                  <div className="font-medium">{worker.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {worker.modifiedOn ? `修改于 ${worker.modifiedOn}` : "修改时间未知"}
                    {worker.migrationTag ? ` · 迁移 ${worker.migrationTag}` : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={selected === worker.name ? "secondary" : "outline"}
                  disabled={running}
                  onClick={() => void inspect(worker.name)}
                >
                  {selected === worker.name ? "已选择" : "检查并接管"}
                </Button>
              </li>
            ))}
          </ul>
          <ErrorAlert error={error} onRetry={() => (selected ? inspect(selected) : loadWorkers())} />
        </CardContent>
      </Card>

      {preview ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {preview.workerName}
              {preview.legacy ? <Badge variant="outline">需要兼容升级</Badge> : <Badge variant="secondary">配置可读取</Badge>}
            </CardTitle>
            <CardDescription>
              通过 Cloudflare 读取配置和资源。旧版源码配置需要重新填写；原资源与 secrets 沿用，不新增公网管理接口。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Info label="当前发布版本" value={preview.releaseVersion || "未知"} />
              <Info label="DESKWAND_CONFIG" value={preview.configPresent ? "存在" : "不存在"} />
              <Info label="owner" value={preview.ownerConfigured ? "已配置" : "需重新填写"} />
              <Info label="角色模型" value={preview.modelsConfigured ? "已配置" : "需重新填写"} />
              <Info label="ACTIVE_CHANNEL" value={preview.activeChannel || "未设置（旧版默认 Telegram，需确认）"} />
              <Info label="现有 secrets" value={preview.secretNames.join("、") || "无"} />
            </dl>

            {preview.preserveSecretNames.length > 0 ? (
              <Alert>
                <ShieldCheck />
                <AlertTitle>沿用已有 secret</AlertTitle>
                <AlertDescription>
                  {preview.preserveSecretNames.join("、")} 保持原值。客户端不读取、不导出，也不会把它们迁移到普通配置。
                </AlertDescription>
              </Alert>
            ) : null}

            {preview.plaintextSecrets?.length ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <h3 className="text-sm font-medium">发现内联凭据，需要迁移为 secret</h3>
                {preview.plaintextSecrets.map((migration) => (
                  <div key={migration.secretName} className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {migration.field} → {migration.reference}
                    </p>
                    <Label htmlFor={`migrate-${migration.secretName}`}>{migration.secretName} 的值</Label>
                    <Input
                      id={`migrate-${migration.secretName}`}
                      type="password"
                      autoComplete="new-password"
                      value={secrets[migration.secretName] ?? ""}
                      onChange={(event) =>
                        setSecrets((current) => ({ ...current, [migration.secretName]: event.target.value }))
                      }
                      placeholder="只写入一次，提交后清空"
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {preview.requiredInputs?.includes("telegramUserIds") || preview.legacy ? (
              <div className="space-y-2">
                <Label htmlFor="import-owners">允许使用的 Telegram 用户 ID</Label>
                <Input
                  id="import-owners"
                  value={ownerIDs}
                  onChange={(event) => setOwnerIDs(event.target.value)}
                  placeholder="例如 123456789"
                  inputMode="numeric"
                />
              </div>
            ) : null}

            {preview.legacy ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="import-butler">管家模型</Label>
                  <ModelSelect id="import-butler" value={butler} onChange={setButler} options={modelOptions} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="import-task">任务模型</Label>
                  <ModelSelect id="import-task" value={task} onChange={setTask} options={modelOptions} />
                </div>
              </div>
            ) : null}

            {preview.warnings?.length ? (
              <Alert>
                <AlertTitle>接管说明</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {!result ? (
              <div className="flex flex-wrap justify-end gap-2">
                <GuardedBack dirty={dirty} onBack={onBack} />
                <Button type="button" onClick={() => void confirm()} disabled={running}>
                  {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                  {running ? "正在接管…" : "确认配置并接管"}
                </Button>
              </div>
            ) : null}
            {!result ? (
              <>
                <ErrorAlert
                  error={submitError}
                  onRetry={canRetryImport ? confirm : undefined}
                  retryLabel="重新确认"
                />
                {submitError && !canRetryImport ? (
                  <p className="text-xs text-muted-foreground">
                    请重新输入上方标记的 secret 值后再重试；已提交的值已在失败后清空。
                  </p>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <ResultPanel
          title={published ? "已有服务已连接" : "接管需要继续处理"}
          result={result}
          running={running}
          error={submitError}
          onResume={result.state === "unknown" || result.state === "needs_input" ? resume : undefined}
        >
          {published ? (
            <Button type="button" className="mt-4" onClick={onReady}>
              进入管理首页 <ArrowRight aria-hidden />
            </Button>
          ) : null}
        </ResultPanel>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
  );
}

export function ResultPanel({
  title,
  result,
  running,
  error,
  onResume,
  children,
}: {
  title: string;
  result: ResultDTO;
  running: boolean;
  error: unknown;
  onResume?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {title}
          <StateBadge state={result.state} />
        </CardTitle>
        <CardDescription>
          {result.state === "published"
            ? "控制面发布完成。云端是否实际收发消息仍需真实消息或云端证据验证。"
            : "客户端保留了操作 ID。继续时会先核实远端状态，不会盲目重复写入。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {result.operationId ? (
          <p className="text-xs text-muted-foreground">操作 ID：{result.operationId}</p>
        ) : null}
        <StepList steps={result.steps ?? []} />
        {result.warnings?.length ? (
          <Alert className="my-3">
            <AlertTitle>注意</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {onResume ? (
          <Button type="button" className="mt-2" onClick={onResume} disabled={running}>
            {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            继续操作
          </Button>
        ) : null}
        <ErrorAlert error={error} onRetry={onResume} retryLabel="重试" />
        {children}
      </CardContent>
    </Card>
  );
}

