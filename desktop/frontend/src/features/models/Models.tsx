import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2, Zap } from "lucide-react";
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
  CustomModelDTO,
  CustomProviderDTO,
  ModelCatalogDTO,
  ResultDTO,
  SecretEditDTO,
  StatusItemDTO,
} from "@/services/types";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  providerOptions,
  secretNameFor,
} from "./catalog";
import { ModelSelect } from "./ModelSelect";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE_URL_PATTERN = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(\/|$))/;

interface CustomDraft {
  index: number | null;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: string;
}

function parseModelIDs(value: string): string[] {
  return value
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function customDraftError(
  draft: CustomDraft,
  catalog: ModelCatalogDTO | null,
  providers: CustomProviderDTO[],
): string {
  const id = draft.id.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return "端点 ID 只能使用小写字母、数字和 -，且以字母或数字开头";
  }
  if (catalog?.providers.some((provider) => provider.id === id)) {
    return `与内置厂商重名：${id}`;
  }
  if (providers.some((provider, index) => index !== draft.index && provider.id === id)) {
    return `自定义端点的 id 不能重复：${id}`;
  }
  if (draft.name.trim().length > 128) {
    return "显示名称不能超过 128 个字符";
  }
  if (draft.api !== "openai-completions" && draft.api !== "anthropic-messages") {
    return "协议必须是 openai-completions 或 anthropic-messages";
  }
  if (!BASE_URL_PATTERN.test(draft.baseUrl.trim())) {
    return "Base URL 必须以 https:// 开头，只有 localhost 或 127.0.0.1 可以使用 http://";
  }
  const models = parseModelIDs(draft.models);
  if (models.length === 0) {
    return "至少添加一个模型";
  }
  if (models.length > 64) {
    return "最多添加 64 个模型";
  }
  if (new Set(models).size !== models.length) {
    return "模型 ID 不能重复";
  }
  if (draft.index === null && providers.length >= 16) {
    return "最多添加 16 个自定义端点";
  }
  return "";
}

export function Models() {
  const { client } = useApp();
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogDTO | null>(null);
  const [customProviders, setCustomProviders] = useState<CustomProviderDTO[]>([]);
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [keyDrafts, setKeyDrafts] = useState<
    Record<string, { value: string; clear: boolean }>
  >({});
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
  const [probeTarget, setProbeTarget] = useState<string | null>(null);
  const [probeItem, setProbeItem] = useState<{ provider: string; item: StatusItemDTO } | null>(null);
  const [probeError, setProbeError] = useState<{ provider: string; error: unknown } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    setConflict(false);
    try {
      const [next, nextCatalog] = await Promise.all([
        client.getConfig(),
        client.modelCatalog(),
      ]);
      setConfig(next);
      setCatalog(nextCatalog);
      setCustomProviders(next.customProviders ?? []);
      setButler(modelKey(next.butlerModel) || modelKey(DEFAULT_MODEL));
      setTask(modelKey(next.taskModel) || modelKey(DEFAULT_MODEL));
      setKeyDrafts({});
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const options = useMemo(
    () => providerOptions(catalog ?? { providers: [] }, customProviders),
    [catalog, customProviders],
  );

  const keyProviders = useMemo(() => {
    const ids: string[] = [];
    for (const value of [butler, task]) {
      const provider = parseModelKey(value)?.provider;
      if (provider && !ids.includes(provider)) ids.push(provider);
    }
    return ids.map((id) => ({
      id,
      option: options.find((provider) => provider.id === id),
      custom: customProviders.find((provider) => provider.id === id),
    }));
  }, [butler, customProviders, options, task]);

  const updateKeyDraft = (
    id: string,
    update: Partial<{ value: string; clear: boolean }>,
  ) => {
    setKeyDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { value: "", clear: false }), ...update },
    }));
  };

  const clearKeyValues = () => {
    setKeyDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, draft]) => [id, { ...draft, value: "" }]),
      ),
    );
  };

  const dirty = useMemo(() => {
    if (!config) return false;
    const keysDirty = keyProviders.some(({ id }) => {
      const draft = keyDrafts[id];
      return Boolean(draft && (draft.value.length > 0 || draft.clear));
    });
    return (
      keysDirty ||
      modelKey(config.butlerModel) !== butler ||
      modelKey(config.taskModel) !== task ||
      JSON.stringify(config.customProviders ?? []) !== JSON.stringify(customProviders)
    );
  }, [butler, config, customProviders, keyDrafts, keyProviders, task]);
  useDirty(dirty);

  const edit = (): ConfigEditDTO => {
    const secrets: SecretEditDTO[] = [];
    for (const { id } of keyProviders) {
      const draft = keyDrafts[id];
      if (!draft) continue;
      if (draft.clear) {
        secrets.push({ name: secretNameFor(id), operation: "clear" });
      } else if (draft.value.trim()) {
        secrets.push({ name: secretNameFor(id), operation: "replace", value: draft.value });
      }
    }
    const customChanged =
      JSON.stringify(config?.customProviders ?? []) !== JSON.stringify(customProviders);
    return {
      baseFingerprint: config?.fingerprint,
      butlerModel: parseModelKey(butler) ?? undefined,
      taskModel: parseModelKey(task) ?? undefined,
      customProviders: customChanged ? customProviders : undefined,
      secrets,
    };
  };

  const openCustom = (index: number | null) => {
    if (index === null) {
      setCustomDraft({
        index: null,
        id: "",
        name: "",
        api: "openai-completions",
        baseUrl: "",
        models: "",
      });
    } else {
      const provider = customProviders[index];
      if (!provider) return;
      setCustomDraft({
        index,
        id: provider.id,
        name: provider.name ?? "",
        api: provider.api,
        baseUrl: provider.baseUrl,
        models: provider.models.map((model) => model.id).join(", "),
      });
    }
    setCustomOpen(true);
  };

  const saveCustom = () => {
    if (!customDraft || customDraftError(customDraft, catalog, customProviders)) return;
    const previous =
      customDraft.index === null ? undefined : customProviders[customDraft.index];
    const models: CustomModelDTO[] = parseModelIDs(customDraft.models).map(
      (id) => previous?.models.find((model) => model.id === id) ?? { id },
    );
    const provider: CustomProviderDTO = {
      id: customDraft.id.trim(),
      name: customDraft.name.trim() || undefined,
      api: customDraft.api,
      baseUrl: customDraft.baseUrl.trim(),
      models,
    };
    setCustomProviders((current) =>
      customDraft.index === null
        ? [...current, provider]
        : current.map((entry, index) => (index === customDraft.index ? provider : entry)),
    );
    setCustomOpen(false);
    setCustomDraft(null);
  };

  const removeCustom = (index: number) => {
    setCustomProviders((current) => current.filter((_, entryIndex) => entryIndex !== index));
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
      clearKeyValues();
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
      clearKeyValues();
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

  const probe = async (target: string | null) => {
    setProbeOpen(false);
    setProbeError(null);
    setRunning("probe");
    const provider = keyProviders.find((entry) => entry.id === target);
    if (!provider || !target) {
      setRunning(null);
      return;
    }
    setProbeItem((current) => (current?.provider === target ? null : current));
    const butlerModel = parseModelKey(butler);
    const probeModelId =
      target === butlerModel?.provider
        ? (butlerModel?.id ?? "")
        : (provider.option?.models[0]?.id ?? "");
    try {
      const item = await client.probeModel(
        target,
        probeModelId,
        keyDrafts[target]?.value ?? "",
        provider.custom?.api ?? "",
        provider.custom?.baseUrl ?? "",
      );
      setProbeItem({ provider: target, item });
    } catch (cause) {
      setProbeError({ provider: target, error: cause });
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

  const draftError = customDraft
    ? customDraftError(customDraft, catalog, customProviders)
    : "";

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
          <CardTitle>模型供应商</CardTitle>
          <CardDescription>
            密钥只写入 Cloudflare secret；输入框提交后清空，已有值不可读取。管家和任务模型用到的每个供应商各需一个 key。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keyProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground">请先选择管家模型或任务模型。</p>
          ) : (
            <div className="space-y-3">
              {keyProviders.map((provider) => {
                const secret = secretNameFor(provider.id);
                const configured =
                  config?.secrets.find((entry) => entry.name === secret)?.configured ?? false;
                const draft = keyDrafts[provider.id] ?? { value: "", clear: false };
                const rowProbeItem =
                  probeItem?.provider === provider.id ? probeItem.item : null;
                const rowProbeError =
                  probeError?.provider === provider.id ? probeError.error : null;
                return (
                  <div
                    key={provider.id}
                    data-testid={`model-key-row-${provider.id}`}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{provider.option?.label ?? provider.id}</p>
                      <Badge variant={configured ? "secondary" : "outline"}>
                        {secret} {configured ? "已配置" : "未配置"}
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`api-key-${provider.id}`}>API 密钥</Label>
                        <Input
                          id={`api-key-${provider.id}`}
                          type="password"
                          value={draft.value}
                          onChange={(event) =>
                            updateKeyDraft(provider.id, {
                              value: event.target.value,
                              ...(event.target.value ? { clear: false } : {}),
                            })
                          }
                          placeholder={configured ? "已配置；输入新值才会替换" : "输入新密钥"}
                          autoComplete="new-password"
                          spellCheck={false}
                        />
                      </div>
                      <div className="flex flex-wrap items-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setProbeTarget(provider.id);
                            setProbeOpen(true);
                          }}
                          disabled={!draft.value.trim() || running !== null}
                        >
                          <Zap aria-hidden />
                          测试连接
                        </Button>
                        <Button
                          type="button"
                          variant={draft.clear ? "destructive" : "outline"}
                          size="sm"
                          onClick={() =>
                            updateKeyDraft(provider.id, {
                              clear: !draft.clear,
                              ...(draft.clear ? {} : { value: "" }),
                            })
                          }
                          disabled={!configured}
                        >
                          {draft.clear ? "已标记清除" : "清除已保存密钥"}
                        </Button>
                        {!draft.value.trim() ? (
                          <span className="text-xs text-muted-foreground">
                            已有密钥不可读，测试连接需要重新输入密钥。
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {rowProbeError ? (
                      <ErrorAlert
                        error={rowProbeError}
                        onRetry={() => {
                          setProbeTarget(provider.id);
                          setProbeOpen(true);
                        }}
                        retryLabel="重新测试"
                      />
                    ) : null}
                    {rowProbeItem ? (
                      <div className="mt-3 rounded-md border border-border p-3">
                        <StatusRow item={rowProbeItem} />
                        <p className="mt-2 text-xs text-muted-foreground">
                          本机测试只证明该凭据在这台机器上可用，不代表云端已应用或消息收发正常。
                        </p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>自定义端点</CardTitle>
              <CardDescription>
                接入任意 OpenAI 或 Anthropic 兼容端点。保存后随下一次“保存并发布”写入云端配置。
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openCustom(null)}
              disabled={customProviders.length >= 16}
            >
              <Plus aria-hidden />
              添加自定义端点
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {customProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未添加自定义端点。</p>
          ) : (
            <ul className="space-y-2">
              {customProviders.map((provider, index) => (
                <li
                  key={provider.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{provider.name || provider.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {provider.id} · {provider.api}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">{provider.baseUrl}</p>
                    <p className="text-xs text-muted-foreground">
                      模型：{provider.models.map((model) => model.id).join("、")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openCustom(index)}
                    >
                      <Pencil aria-hidden />
                      编辑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeCustom(index)}
                    >
                      <Trash2 aria-hidden />
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
              <ModelSelect id="butler-model" label="管家模型" value={butler} onChange={setButler} options={options} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-model">任务模型</Label>
              <ModelSelect id="task-model" label="任务模型" value={task} onChange={setTask} options={options} />
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
            <Button type="button" onClick={() => void probe(probeTarget)} disabled={running !== null}>
              {running === "probe" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              确认测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={customOpen}
        onOpenChange={(open) => {
          setCustomOpen(open);
          if (!open) setCustomDraft(null);
        }}
      >
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {customDraft?.index === null || customDraft === null
                ? "添加自定义端点"
                : "编辑自定义端点"}
            </DialogTitle>
            <DialogDescription>
              端点 id 决定 secret 名（MODEL_KEY_&lt;ID&gt;）。保存端点后仍需“保存并发布”才会写入云端。
            </DialogDescription>
          </DialogHeader>
          {customDraft ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="custom-id">端点 ID</Label>
                <Input
                  id="custom-id"
                  value={customDraft.id}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current ? { ...current, id: event.target.value } : current,
                    )
                  }
                  placeholder="my-proxy"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="custom-name">显示名称</Label>
                <Input
                  id="custom-name"
                  value={customDraft.name}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  placeholder="可留空"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-api">协议</Label>
                <Select
                  value={customDraft.api}
                  onValueChange={(value) =>
                    setCustomDraft((current) => (current ? { ...current, api: value } : current))
                  }
                >
                  <SelectTrigger id="custom-api" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai-completions">
                      OpenAI 兼容（openai-completions）
                    </SelectItem>
                    <SelectItem value="anthropic-messages">
                      Anthropic 兼容（anthropic-messages）
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-base-url">Base URL</Label>
                <Input
                  id="custom-base-url"
                  value={customDraft.baseUrl}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current ? { ...current, baseUrl: event.target.value } : current,
                    )
                  }
                  placeholder="https://proxy.example.com/v1"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  OpenAI 兼容地址通常以 /v1 结尾；Anthropic 兼容地址不要带 /v1
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-models">模型 ID（用逗号分隔）</Label>
                <Input
                  id="custom-models"
                  value={customDraft.models}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current ? { ...current, models: event.target.value } : current,
                    )
                  }
                  placeholder="gpt-5.6, gpt-5.6-mini"
                  spellCheck={false}
                />
              </div>
              {draftError ? (
                <p className="text-sm text-destructive sm:col-span-2">{draftError}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCustomOpen(false);
                setCustomDraft(null);
              }}
            >
              取消
            </Button>
            <Button type="button" onClick={saveCustom} disabled={!customDraft || draftError !== ""}>
              保存端点
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
