import { PageHeader } from "@/components/page-header";
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
import { SyncStatus } from "@/components/sync-status";
import { useDirty } from "@/components/use-dirty";
import { toClientError } from "@/services/errors";
import { useConfigQuery, useInvalidate, useModelCatalogQuery } from "@/services/queries";
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
  providerNeedsKey,
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
    return "ID 只能用小写字母、数字和 -，以字母或数字开头";
  }
  if (catalog?.providers.some((provider) => provider.id === id)) {
    return `与内置厂商重名：${id}`;
  }
  if (providers.some((provider, index) => index !== draft.index && provider.id === id)) {
    return `端点 ID 重复：${id}`;
  }
  if (draft.name.trim().length > 128) {
    return "名称最多 128 字符";
  }
  if (draft.api !== "openai-completions" && draft.api !== "anthropic-messages") {
    return "协议必须是 openai-completions 或 anthropic-messages";
  }
  if (!BASE_URL_PATTERN.test(draft.baseUrl.trim())) {
    return "必须 https://；localhost 可用 http://";
  }
  const models = parseModelIDs(draft.models);
  if (models.length === 0) {
    return "至少一个模型";
  }
  if (models.length > 64) {
    return "最多 64 个模型";
  }
  if (new Set(models).size !== models.length) {
    return "模型 ID 不能重复";
  }
  if (draft.index === null && providers.length >= 16) {
    return "最多 16 个端点";
  }
  return "";
}

export function Models() {
  const { client } = useApp();
  const configQuery = useConfigQuery();
  const catalogQuery = useModelCatalogQuery();
  const invalidate = useInvalidate();
  const catalog = catalogQuery.data ?? null;
  const [baseline, setBaseline] = useState<ConfigDTO | null>(null);
  const config = baseline ?? configQuery.data ?? null;
  const [customProviders, setCustomProviders] = useState<CustomProviderDTO[]>([]);
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [keyDrafts, setKeyDrafts] = useState<
    Record<string, { value: string; clear: boolean }>
  >({});
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
  // Remounts the form rows after a publish so transient UI (open details) does
  // not outlive the config it was showing.
  const [formVersion, setFormVersion] = useState(0);
  // The publish result has no fingerprint, so the form stays locked until the
  // invalidated config fetch confirms the new baseline.
  const [awaitingFreshConfig, setAwaitingFreshConfig] = useState(false);

  const fillFromConfig = useCallback((next: ConfigDTO) => {
    setCustomProviders(next.customProviders ?? []);
    setButler(modelKey(next.butlerModel) || modelKey(DEFAULT_MODEL));
    setTask(modelKey(next.taskModel) || modelKey(DEFAULT_MODEL));
    setKeyDrafts({});
  }, []);

  const applyConfig = (next: ConfigDTO) => {
    setBaseline(next);
    fillFromConfig(next);
    setAwaitingFreshConfig(false);
    setError(null);
    setConflict(false);
  };

  const applyFreshConfig = async (): Promise<ConfigDTO | undefined> => {
    const fresh = await configQuery.refetch();
    // A failed refetch still carries the previous data in v5; adopting it would
    // restore the pre-publish fingerprint, so keep the form locked instead.
    if (fresh.status !== "success" || !fresh.data) {
      setError(fresh.error ?? null);
      return undefined;
    }
    applyConfig(fresh.data);
    return fresh.data;
  };

  const refresh = async () => {
    setError(null);
    setConflict(false);
    await configQuery.refetch();
    await catalogQuery.refetch();
  };

  const reload = async () => {
    setError(null);
    setConflict(false);
    await applyFreshConfig();
    await catalogQuery.refetch();
  };

  const options = useMemo(
    () => providerOptions(catalog ?? { providers: [] }, customProviders),
    [catalog, customProviders],
  );

  const keylessSelected = useMemo(() => {
    const catalogProviders = catalog ?? { providers: [] };
    return [butler, task].some((value) => {
      const provider = parseModelKey(value)?.provider;
      return Boolean(provider && !providerNeedsKey(catalogProviders, provider));
    });
  }, [butler, catalog, task]);

  const keyProviders = useMemo(() => {
    const catalogProviders = catalog ?? { providers: [] };
    const ids: string[] = [];
    const roles: Record<string, string[]> = {};
    for (const [role, value] of [
      ["管家", butler],
      ["任务", task],
    ] as const) {
      const provider = parseModelKey(value)?.provider;
      if (!provider) continue;
      if (!providerNeedsKey(catalogProviders, provider)) continue;
      if (!ids.includes(provider)) ids.push(provider);
      (roles[provider] ??= []).push(role);
    }
    return ids.map((id) => ({
      id,
      roles: roles[id] ?? [],
      option: options.find((provider) => provider.id === id),
      custom: customProviders.find((provider) => provider.id === id),
    }));
  }, [butler, catalog, customProviders, options, task]);

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
    if (!baseline) return false;
    const keysDirty = keyProviders.some(({ id }) => {
      const draft = keyDrafts[id];
      return Boolean(draft && (draft.value.length > 0 || draft.clear));
    });
    return (
      keysDirty ||
      modelKey(baseline.butlerModel) !== butler ||
      modelKey(baseline.taskModel) !== task ||
      JSON.stringify(baseline.customProviders ?? []) !== JSON.stringify(customProviders)
    );
  }, [baseline, butler, customProviders, keyDrafts, keyProviders, task]);
  useDirty(dirty);

  useEffect(() => {
    if (awaitingFreshConfig) return;
    const next = configQuery.data;
    if (!next) return;
    if (configQuery.isPlaceholder) {
      // Read-only preview from the disk cache; it must never seed the form's
      // baseline or the fingerprint sent with a publish.
      if (!baseline) fillFromConfig(next);
      return;
    }
    if (!baseline || (!dirty && next.fingerprint !== baseline.fingerprint)) {
      setBaseline(next);
      fillFromConfig(next);
    }
  }, [
    awaitingFreshConfig,
    baseline,
    configQuery.data,
    configQuery.isPlaceholder,
    dirty,
    fillFromConfig,
  ]);

  const cloudUpdated = Boolean(
    baseline &&
      dirty &&
      configQuery.data &&
      !configQuery.isPlaceholder &&
      configQuery.data.fingerprint !== baseline.fingerprint,
  );

  const loadLatest = () => {
    const next = configQuery.data;
    if (!next || configQuery.isPlaceholder) return;
    applyConfig(next);
  };

  const loadError =
    !configQuery.data && configQuery.error
      ? configQuery.error
      : !catalogQuery.data && catalogQuery.error
        ? catalogQuery.error
        : null;
  const loading = !configQuery.data && configQuery.isFetching;

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
      JSON.stringify(baseline?.customProviders ?? []) !== JSON.stringify(customProviders);
    return {
      baseFingerprint: baseline?.fingerprint,
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
          ? "配置已发布。"
          : "发布未完成，可继续。",
      );
      setKeyDrafts({});
      setAwaitingFreshConfig(true);
      setBaseline(null);
      setFormVersion((current) => current + 1);
      invalidate.config();
      await applyFreshConfig();
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
      setKeyDrafts({});
      setAwaitingFreshConfig(true);
      setBaseline(null);
      setFormVersion((current) => current + 1);
      invalidate.config();
      await applyFreshConfig();
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
      <PageHeader title="模型" actions={<>
        <SyncStatus
          isFetching={configQuery.isFetching}
          isPlaceholder={configQuery.isPlaceholder}
          savedAt={configQuery.savedAt}
          error={configQuery.data ? configQuery.error : null}
          onRetry={() => void (awaitingFreshConfig ? reload() : refresh())}
        />
        <Badge variant="outline">
          <ShieldCheck aria-hidden />
          密钥不回显
        </Badge>
</>} />

      <ErrorAlert error={loadError} onRetry={() => void reload()} />
      <ErrorAlert error={error} onReload={conflict ? () => void reload() : undefined} reloadLabel="重新加载配置" onRetry={!conflict ? openPreview : undefined} />
      {cloudUpdated ? (
        <Alert className="my-4" role="status">
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>云端配置已更新</span>
            <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
              载入最新
            </Button>
          </AlertTitle>
          <AlertDescription>
            后台刷新发现了新版本，你的修改没有被覆盖。
          </AlertDescription>
        </Alert>
      ) : null}
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
            {result.state === "published" || result.state === "completed" ? <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">执行详情</summary><StepList steps={result.steps ?? []} /></details> : <StepList steps={result.steps ?? []} />}
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
                继续
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <fieldset
        disabled={
          baseline === null ||
          (result !== null && (result.state === "unknown" || result.state === "needs_input"))
        }
        className="m-0 min-w-0 border-0 p-0"
      >
      <section className="mt-5" aria-labelledby="role-models-title">
        <h2 id="role-models-title" className="mb-4 text-base font-medium">角色模型</h2>
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
          <p className="mt-2 text-xs text-muted-foreground">
            找不到供应商？可以在下面加自定义端点。
          </p>

          <section className="mt-5 border-t border-border pt-4" aria-labelledby="provider-keys-title">
            <h3 id="provider-keys-title" className="text-sm font-medium">供应商密钥</h3>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">
              每个供应商一个密钥，只写入 Cloudflare。
            </p>
            {keylessSelected ? (
              <p className="mb-3 text-sm text-muted-foreground" data-testid="workers-ai-quota-notice">
                使用你 Cloudflare 账号每天 10,000 neurons 的免费额度，用完后 UTC 0 点重置；超出后免费账号会暂停，付费账号按量计费。
              </p>
            ) : null}
            {keyProviders.length === 0 ? (
              keylessSelected ? null : (
                <p className="text-sm text-muted-foreground">请先选择管家模型或任务模型。</p>
              )
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
                      key={`${provider.id}-${formVersion}`}
                      data-testid={`model-key-row-${provider.id}`}
                      className="rounded-md border border-border p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {provider.option?.label ?? provider.id}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            用于{provider.roles.join("、")}模型
                          </span>
                        </p>
                        <Badge variant={configured ? "secondary" : "outline"}>
                          {configured ? "已配置" : "未配置"}
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
                            {draft.clear ? "待清除" : "清除已保存密钥"}
                          </Button>
                          {!draft.value.trim() ? (
                            <span className="text-xs text-muted-foreground">
                              测试需重新输入密钥。
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <details className="mt-3 min-w-0 break-all">
                        <summary className="cursor-pointer text-xs text-muted-foreground">密钥详情</summary>
                        <p className="mt-2 text-xs text-muted-foreground">{secret} {configured ? "已配置" : "未配置"}</p>
                      </details>
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
                            只验证这台机器上的密钥。
                          </p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <p className="mt-4 text-xs text-muted-foreground">
            未编辑的配置会保留。
          </p>
      </section>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>自定义端点</CardTitle>
              <CardDescription>
                保存后随下一次发布生效。
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
            <p className="text-sm text-muted-foreground">还没有自定义端点。</p>
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

      </fieldset>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void reload()} disabled={running !== null}>
          <RefreshCw aria-hidden />
          重新加载
        </Button>
        <Button
          type="button"
          onClick={() => void openPreview()}
          disabled={
            running !== null ||
            !dirty ||
            baseline === null ||
            (result !== null && (result.state === "unknown" || result.state === "needs_input"))
          }
        >
          {running === "preview" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Save aria-hidden />}
          {running === "preview" ? "正在生成预览…" : "保存并发布"}
        </Button>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>确认保存并发布</DialogTitle>
            <DialogDescription>
              将按以下步骤修改部署。
            </DialogDescription>
          </DialogHeader>
          <StepList steps={previewSteps ?? []} />
          <Alert>
            <AlertTitle>已知限制</AlertTitle>
            <AlertDescription>
              别人在控制台改过同名密钥的值，本机无法发现。
            </AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">
            发布后会重新核对版本。
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
              会真实调用一次模型，可能产生费用。
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
              端点 ID 决定密钥名 MODEL_KEY_&lt;ID&gt;。
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
                  OpenAI 兼容通常带 /v1，Anthropic 不带
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
