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
import { getT, useT, type MessageKey } from "@/i18n";
import { cloudflareNeuronsNotice } from "@/lib/copy";
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
  ModelDTO,
  ResultDTO,
  SecretEditDTO,
  StatusItemDTO,
} from "@/services/types";
import {
  DEFAULT_MODEL,
  clampThinkingLevel,
  modelKey,
  parseModelKey,
  providerNeedsKey,
  providerOptions,
  secretNameFor,
  thinkingLevelsFor,
} from "./catalog";
import { defaultLevelFrom } from "./thinking-level";
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

/** The role model patch, carrying the level the select currently shows. */
function withThinkingLevel(
  model: ModelDTO | null,
  thinkingLevel: string,
): ModelDTO | undefined {
  return model ? { ...model, thinkingLevel } : undefined;
}

/**
 * What is worth knowing about this model's level list: most are unremarkable,
 * but a model that cannot stop thinking surprises people.
 */
function LevelNote({ levels }: { levels: string[] }) {
  const t = useT();
  if (levels.length <= 1) {
    return (
      <p className="text-xs text-muted-foreground">{t("models.thinkingLevelFixed")}</p>
    );
  }
  if (levels.includes("off")) return null;
  const low = t(`models.thinkingLevel.${levels[0]}` as MessageKey);
  const high = t(`models.thinkingLevel.${levels[levels.length - 1]}` as MessageKey);
  return (
    <p className="text-xs text-muted-foreground">
      {t("models.thinkingLevelFloor", { low, high })}
    </p>
  );
}

/** One role's thinking level; only the levels its model supports are offered. */
function ThinkingLevelSelect({
  id,
  value,
  levels,
  onChange,
}: {
  id: string;
  value: string;
  levels: string[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const fixed = levels.length <= 1;
  return (
    <Select value={value} onValueChange={onChange} disabled={fixed}>
      <SelectTrigger
        id={id}
        aria-label={t("models.thinkingLevelLabel")}
        data-testid={id}
        className="w-32 shrink-0"
      >
        <span className="text-xs text-muted-foreground">
          {t("models.thinkingLevelInline")}
        </span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {t(`models.thinkingLevel.${level}` as MessageKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function customDraftError(
  draft: CustomDraft,
  catalog: ModelCatalogDTO | null,
  providers: CustomProviderDTO[],
): string {
  const t = getT();
  const id = draft.id.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return t("models.errors.idPattern");
  }
  if (catalog?.providers.some((provider) => provider.id === id)) {
    return t("models.errors.builtinName", { id });
  }
  if (providers.some((provider, index) => index !== draft.index && provider.id === id)) {
    return t("models.errors.duplicateId", { id });
  }
  if (draft.name.trim().length > 128) {
    return t("models.errors.nameTooLong");
  }
  if (draft.api !== "openai-completions" && draft.api !== "anthropic-messages") {
    return t("models.errors.protocol");
  }
  if (!BASE_URL_PATTERN.test(draft.baseUrl.trim())) {
    return t("models.errors.baseUrl");
  }
  const models = parseModelIDs(draft.models);
  if (models.length === 0) {
    return t("models.errors.noModels");
  }
  if (models.length > 64) {
    return t("models.errors.tooManyModels");
  }
  if (new Set(models).size !== models.length) {
    return t("models.errors.duplicateModels");
  }
  if (draft.index === null && providers.length >= 16) {
    return t("models.errors.tooManyProviders");
  }
  return "";
}

export function Models() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const catalogQuery = useModelCatalogQuery();
  const invalidate = useInvalidate();
  const catalog = catalogQuery.data ?? null;
  const [baseline, setBaseline] = useState<ConfigDTO | null>(null);
  const config = baseline ?? configQuery.data ?? null;
  const [customProviders, setCustomProviders] = useState<CustomProviderDTO[]>([]);
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [butlerLevel, setButlerLevel] = useState<string | null>(null);
  const [taskLevel, setTaskLevel] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<
    Record<string, { value: string; clear: boolean }>
  >({});
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [running, setRunning] = useState<"preview" | "publish" | "probe" | null>(null);
  const [previewSteps, setPreviewSteps] = useState<ResultDTO["steps"]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const [success, setSuccess] = useState<MessageKey | null>(null);
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
    setButlerLevel(next.butlerModel?.thinkingLevel ?? null);
    setTaskLevel(next.taskModel?.thinkingLevel ?? null);
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

  // An unconfigured role uses the middle of what its model offers. The select
  // and the published value both read this, so they cannot disagree, and a
  // level the model dropped is clamped instead of rendering as empty.
  const butlerLevels = thinkingLevelsFor(options, butler);
  const butlerLevelValue = clampThinkingLevel(
    butlerLevel ?? defaultLevelFrom(butlerLevels),
    butlerLevels,
  );
  const taskLevels = thinkingLevelsFor(options, task);
  const taskLevelValue = clampThinkingLevel(
    taskLevel ?? defaultLevelFrom(taskLevels),
    taskLevels,
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
      ["roleButler", butler],
      ["roleTask", task],
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
      (baseline.butlerModel?.thinkingLevel ?? null) !== butlerLevel ||
      (baseline.taskModel?.thinkingLevel ?? null) !== taskLevel ||
      JSON.stringify(baseline.customProviders ?? []) !== JSON.stringify(customProviders)
    );
  }, [baseline, butler, butlerLevel, customProviders, keyDrafts, keyProviders, task, taskLevel]);
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
      butlerModel: withThinkingLevel(parseModelKey(butler), butlerLevelValue),
      taskModel: withThinkingLevel(parseModelKey(task), taskLevelValue),
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
    setSuccess(null);
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
          ? "models.published"
          : "models.publishPending",
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
        {t("models.loading")}
      </div>
    );
  }

  const draftError = customDraft
    ? customDraftError(customDraft, catalog, customProviders)
    : "";

  return (
    <div>
      <PageHeader title={t("shell.pages.models")} actions={<>
        <SyncStatus
          isFetching={configQuery.isFetching}
          isPlaceholder={configQuery.isPlaceholder}
          savedAt={configQuery.savedAt}
          error={configQuery.data ? configQuery.error : null}
          onRetry={() => void (awaitingFreshConfig ? reload() : refresh())}
        />
        <Badge variant="outline">
          <ShieldCheck aria-hidden />
          {t("models.keysNeverEchoed")}
        </Badge>
</>} />

      <ErrorAlert error={loadError} onRetry={() => void reload()} />
      <ErrorAlert error={error} onReload={conflict ? () => void reload() : undefined} reloadLabel={t("models.reloadConfig")} onRetry={!conflict ? openPreview : undefined} />
      {cloudUpdated ? (
        <Alert className="my-4" role="status">
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("models.cloudUpdatedTitle")}</span>
            <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
              {t("models.loadLatest")}
            </Button>
          </AlertTitle>
          <AlertDescription>
            {t("models.cloudUpdatedDescription")}
          </AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <Alert className="my-4 border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
          <AlertTitle>{t("models.submitted")}</AlertTitle>
          <AlertDescription>{t(success)}</AlertDescription>
        </Alert>
      ) : null}
      {result ? (
        <Card className="my-4">
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t("models.resultTitle")}</span>
              <StateBadge state={result.state} />
              {result.operationId ? (
                <span className="text-xs text-muted-foreground" data-i18n-ignore>{result.operationId}</span>
              ) : null}
            </div>
            {result.state === "published" || result.state === "completed" ? <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary><StepList steps={result.steps ?? []} /></details> : <StepList steps={result.steps ?? []} />}
            {result.warnings?.length ? (
              <Alert>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {result.warnings.map((warning) => (
                      <li key={warning} data-i18n-ignore>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {result.state === "unknown" || result.state === "needs_input" ? (
              <Button type="button" className="mt-2" onClick={() => void resume()} disabled={running === "publish"}>
                {running === "publish" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                {t("common.continue")}
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
        <h2 id="role-models-title" className="mb-4 text-base font-medium">{t("models.rolesTitle")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="butler-model">{t("models.butlerModel")}</Label>
              <ModelSelect
                id="butler-model"
                label={t("models.butlerModel")}
                value={butler}
                onChange={setButler}
                options={options}
                trailing={
                  <ThinkingLevelSelect
                    id="butler-thinking-level"
                    value={butlerLevelValue}
                    levels={butlerLevels}
                    onChange={setButlerLevel}
                  />
                }
              />
              <LevelNote levels={butlerLevels} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-model">{t("models.taskModel")}</Label>
              <ModelSelect
                id="task-model"
                label={t("models.taskModel")}
                value={task}
                onChange={setTask}
                options={options}
                trailing={
                  <ThinkingLevelSelect
                    id="task-thinking-level"
                    value={taskLevelValue}
                    levels={taskLevels}
                    onChange={setTaskLevel}
                  />
                }
              />
              <LevelNote levels={taskLevels} />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("models.thinkingLevelHint")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("models.customHint")}
          </p>

          <section className="mt-5 border-t border-border pt-4" aria-labelledby="provider-keys-title">
            <h3 id="provider-keys-title" className="text-sm font-medium">{t("models.keysTitle")}</h3>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">
              {t("models.keysDescription")}
            </p>
            {keylessSelected ? (
              <p className="mb-3 text-sm text-muted-foreground" data-testid="workers-ai-quota-notice">
                {cloudflareNeuronsNotice()}
              </p>
            ) : null}
            {keyProviders.length === 0 ? (
              keylessSelected ? null : (
                <p className="text-sm text-muted-foreground">{t("models.chooseModelFirst")}</p>
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
                          <span data-i18n-ignore>{provider.option?.label ?? provider.id}</span>
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {t("models.roleUsage", {
                              roles: provider.roles
                                .map((role) =>
                                  role === "roleButler"
                                    ? t("models.roleButler")
                                    : t("models.roleTask"),
                                )
                                .join(t("models.listSeparator")),
                            })}
                          </span>
                        </p>
                        <Badge variant={configured ? "secondary" : "outline"}>
                          {configured ? t("models.configured") : t("models.notConfigured")}
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={`api-key-${provider.id}`}>{t("models.apiKey")}</Label>
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
                            placeholder={configured ? t("models.keyPlaceholderConfigured") : t("models.keyPlaceholderNew")}
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
                            {t("models.testConnection")}
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
                            {draft.clear ? t("models.pendingClear") : t("models.clearSavedKey")}
                          </Button>
                          {!draft.value.trim() ? (
                            <span className="text-xs text-muted-foreground">
                              {t("models.testNeedsKey")}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <details className="mt-3 min-w-0 break-all">
                        <summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary>
                        <p className="mt-2 text-xs text-muted-foreground"><span data-i18n-ignore>{secret}</span> {configured ? t("models.configured") : t("models.notConfigured")}</p>
                      </details>
                      {rowProbeError ? (
                        <ErrorAlert
                          error={rowProbeError}
                          onRetry={() => {
                            setProbeTarget(provider.id);
                            setProbeOpen(true);
                          }}
                          retryLabel={t("models.retest")}
                        />
                      ) : null}
                      {rowProbeItem ? (
                        <div className="mt-3 rounded-md border border-border p-3">
                          <StatusRow item={rowProbeItem} />
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t("models.localOnly")}
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
            {t("models.uneditedKept")}
          </p>
      </section>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{t("models.customTitle")}</CardTitle>
              <CardDescription>
                {t("models.customDescription")}
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
              {t("models.addCustom")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {customProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("models.noCustom")}</p>
          ) : (
            <ul className="space-y-2">
              {customProviders.map((provider, index) => (
                <li
                  key={provider.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium" data-i18n-ignore>{provider.name || provider.id}</p>
                    <p className="text-xs text-muted-foreground">
                      <span data-i18n-ignore>{provider.id}</span> · <span data-i18n-ignore>{provider.api}</span>
                    </p>
                    <p className="break-all text-xs text-muted-foreground" data-i18n-ignore>{provider.baseUrl}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("models.modelsPrefix")}
                      <span data-i18n-ignore>{provider.models.map((model) => model.id).join(t("models.listSeparator"))}</span>
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
                      {t("models.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeCustom(index)}
                    >
                      <Trash2 aria-hidden />
                      {t("models.delete")}
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
          {t("models.reload")}
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
          {running === "preview" ? t("models.generatingPreview") : t("models.saveAndPublish")}
        </Button>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("models.previewTitle")}</DialogTitle>
            <DialogDescription>
              {t("models.previewDescription")}
            </DialogDescription>
          </DialogHeader>
          <StepList steps={previewSteps ?? []} />
          <Alert>
            <AlertTitle>{t("models.knownLimits")}</AlertTitle>
            <AlertDescription>
              {t("models.knownLimitsDescription")}
            </AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">
            {t("models.reverifyAfterPublish")}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(false)} disabled={running === "publish"}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void publish()} disabled={running === "publish"}>
              {running === "publish" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {running === "publish" ? t("models.publishing") : t("models.previewTitle")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("models.probeTitle")}</DialogTitle>
            <DialogDescription>
              {t("models.probeDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setProbeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void probe(probeTarget)} disabled={running !== null}>
              {running === "probe" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {t("models.confirmProbe")}
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
                ? t("models.addCustom")
                : t("models.editCustom")}
            </DialogTitle>
            <DialogDescription>
              {t("models.customIdHint")}
            </DialogDescription>
          </DialogHeader>
          {customDraft ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="custom-id">{t("models.endpointId")}</Label>
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
                <Label htmlFor="custom-name">{t("models.displayName")}</Label>
                <Input
                  id="custom-name"
                  value={customDraft.name}
                  onChange={(event) =>
                    setCustomDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  placeholder={t("models.namePlaceholder")}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-api">{t("models.protocol")}</Label>
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
                      {t("models.protocolOpenAI")}
                    </SelectItem>
                    <SelectItem value="anthropic-messages">
                      {t("models.protocolAnthropic")}
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
                  {t("models.baseUrlHint")}
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-models">{t("models.modelsLabel")}</Label>
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
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={saveCustom} disabled={!customDraft || draftError !== ""}>
              {t("models.saveEndpoint")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
