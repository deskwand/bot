import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { ExternalLink, Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { SyncStatus } from "@/components/sync-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDirty } from "@/components/use-dirty";
import { useT, type MessageKey } from "@/i18n";
import { toClientError } from "@/services/errors";
import { useConfigQuery, useInvalidate } from "@/services/queries";
import type { ConfigDTO, ConfigEditDTO, SecretEditDTO } from "@/services/types";
import { SEARCH_PROVIDERS, type SearchProviderOption } from "./providers";

type SearchProviderId = SearchProviderOption["id"];

function normalizeProvider(value: string | undefined): SearchProviderId {
  return SEARCH_PROVIDERS.some((provider) => provider.id === value)
    ? (value as SearchProviderId)
    : "exa";
}

export function Search() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const invalidate = useInvalidate();
  const [baseline, setBaseline] = useState<ConfigDTO | null>(null);
  const config = baseline ?? configQuery.data ?? null;
  const [selected, setSelected] = useState<SearchProviderId>("exa");
  const [keyDrafts, setKeyDrafts] = useState<
    Record<string, { value: string; clear: boolean }>
  >({});
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [running, setRunning] = useState<"publish" | null>(null);
  const [success, setSuccess] = useState<MessageKey | null>(null);
  // The publish result has no fingerprint, so the form stays locked until the
  // invalidated config fetch confirms the new baseline.
  const [awaitingFreshConfig, setAwaitingFreshConfig] = useState(false);

  const fillFromConfig = useCallback((next: ConfigDTO) => {
    setSelected(normalizeProvider(next.searchProvider));
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

  const reload = async () => {
    setError(null);
    setConflict(false);
    await applyFreshConfig();
  };

  const selectedOption =
    SEARCH_PROVIDERS.find((option) => option.id === selected) ?? {
      id: "exa",
      secret: null,
      signupUrl: null,
    };
  const secret = selectedOption.secret;
  // MODEL_KEY_DEEPSEEK is shared with the Models page, so this page must not
  // clear it; it only offers the input while the key is not configured.
  const sharedSecret = selectedOption.id === "deepseek";
  const configured =
    secret !== null &&
    (config?.secrets.find((entry) => entry.name === secret)?.configured ?? false);
  const draft = secret ? (keyDrafts[secret] ?? { value: "", clear: false }) : null;
  const showKeyInput = !sharedSecret || !configured;

  const dirty = useMemo(() => {
    if (!baseline) return false;
    const draftDirty = Boolean(draft && (draft.value.length > 0 || draft.clear));
    return (
      selected !== normalizeProvider(baseline.searchProvider) || draftDirty
    );
  }, [baseline, draft?.clear, draft?.value, selected]);
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

  const loadError = !configQuery.data && configQuery.error ? configQuery.error : null;
  const loading = !configQuery.data && configQuery.isFetching;

  const updateKeyDraft = (name: string, value: string) => {
    setKeyDrafts((current) => ({
      ...current,
      [name]: { value, clear: false },
    }));
  };

  const toggleClear = (name: string, clear: boolean) => {
    setKeyDrafts((current) => ({
      ...current,
      [name]: { value: "", clear },
    }));
  };

  const clearKeyValues = () => {
    setKeyDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).map(([name, entry]) => [
          name,
          { ...entry, value: "" },
        ]),
      ),
    );
  };

  const edit = (): ConfigEditDTO => {
    const secrets: SecretEditDTO[] = [];
    if (secret && draft) {
      if (draft.clear && !sharedSecret) {
        secrets.push({ name: secret, operation: "clear" });
      } else if (draft.value.trim()) {
        secrets.push({
          name: secret,
          operation: "replace",
          value: draft.value,
        });
      }
    }
    const providerChanged =
      baseline !== null &&
      normalizeProvider(baseline.searchProvider) !== selected;
    return {
      baseFingerprint: baseline?.fingerprint,
      ...(providerChanged ? { searchProvider: selected } : {}),
      secrets,
    };
  };

  const publish = async () => {
    setRunning("publish");
    setError(null);
    setConflict(false);
    setSuccess(null);
    try {
      const result = await client.publishConfig(edit());
      setSuccess(
        result.state === "published" ? "search.published" : "search.publishPending",
      );
      setKeyDrafts({});
      setAwaitingFreshConfig(true);
      setBaseline(null);
      invalidate.config();
      await applyFreshConfig();
    } catch (cause) {
      if (toClientError(cause).code === "CONFIG_CONFLICT") setConflict(true);
      setError(cause);
    } finally {
      // Write-only inputs are cleared after every submit attempt.
      clearKeyValues();
      setRunning(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[40svh] items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        {t("search.loading")}
      </div>
    );
  }

  const missingKey = Boolean(secret && !configured && !draft?.value.trim());

  return (
    <div>
      <PageHeader
        title={t("shell.pages.search")}
        subtitle={pageSubtitle("search")}
        description={t("search.intro")}
        actions={
          <>
            <SyncStatus
              isFetching={configQuery.isFetching}
              isPlaceholder={configQuery.isPlaceholder}
              savedAt={configQuery.savedAt}
              error={configQuery.data ? configQuery.error : null}
              onRetry={() => void reload()}
            />
            <Badge variant="outline">
              <ShieldCheck aria-hidden />
              {t("search.keysNeverEchoed")}
            </Badge>
          </>
        }
      />

      <ErrorAlert error={loadError} onRetry={() => void reload()} />
      <ErrorAlert
        error={error}
        onReload={conflict ? () => void reload() : undefined}
        reloadLabel={t("search.reloadConfig")}
        onRetry={!conflict ? () => void publish() : undefined}
      />
      {cloudUpdated ? (
        <Alert className="my-4" role="status">
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("search.cloudUpdatedTitle")}</span>
            <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
              {t("search.loadLatest")}
            </Button>
          </AlertTitle>
          <AlertDescription>
            {t("search.cloudUpdatedDescription")}
          </AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <Alert className="my-4 border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
          <AlertTitle>{t("search.submitted")}</AlertTitle>
          <AlertDescription>{t(success)}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={baseline === null} className="m-0 min-w-0 border-0 p-0">
        <div
          role="radiogroup"
          aria-label={t("search.providerAria")}
          className="grid gap-3 sm:grid-cols-2"
        >
          {SEARCH_PROVIDERS.map((provider) => {
            const active = selected === provider.id;
            return (
              <label
                key={provider.id}
                data-testid={`search-provider-${provider.id}`}
                className={cn(
                  "block cursor-pointer rounded-md border p-4 transition-colors",
                  active
                    ? "border-primary bg-muted/40"
                    : "border-border hover:bg-muted/20",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t(`search.providers.${provider.id}.name` as MessageKey)}
                  </span>
                  <input
                    type="radio"
                    name="search-provider"
                    value={provider.id}
                    checked={active}
                    onChange={() => setSelected(provider.id)}
                    aria-label={t(`search.providers.${provider.id}.name` as MessageKey)}
                    className="size-4 accent-primary"
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`search.providers.${provider.id}.quota` as MessageKey)}
                </p>
                {provider.signupUrl ? (
                  <a
                    href={provider.signupUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline underline-offset-3"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {t("search.signup")}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : null}
              </label>
            );
          })}
        </div>

        {secret ? (
          <section className="mt-5 border-t border-border pt-4" aria-labelledby="search-key-title">
            <h2 id="search-key-title" className="text-sm font-medium">
              {t("search.keyTitle")}
            </h2>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">
              {t("search.keyDescription")}
            </p>
            <div className="rounded-md border border-border p-3" data-testid="search-key-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <span data-i18n-ignore>{secret}</span>
                  {selectedOption.id === "deepseek" ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t("search.keyShared")}
                    </span>
                  ) : null}
                </p>
                <Badge variant={configured ? "secondary" : "outline"}>
                  {configured ? t("search.configured") : t("search.notConfigured")}
                </Badge>
              </div>
              {showKeyInput ? (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="search-api-key">{t("search.apiKey")}</Label>
                    <Input
                      id="search-api-key"
                      type="password"
                      value={draft?.value ?? ""}
                      onChange={(event) =>
                        updateKeyDraft(secret, event.target.value)
                      }
                      placeholder={
                        configured
                          ? t("search.keyPlaceholderConfigured")
                          : t("search.keyPlaceholderNew")
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  </div>
                  {sharedSecret ? null : (
                    <div className="flex items-end">
                      <Button
                        type="button"
                        variant={draft?.clear ? "destructive" : "outline"}
                        size="sm"
                        onClick={() => toggleClear(secret, !draft?.clear)}
                        disabled={!configured}
                      >
                        {draft?.clear
                          ? t("search.pendingClear")
                          : t("search.clearSavedKey")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {missingKey ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{t("search.missingKey")}</AlertDescription>
          </Alert>
        ) : null}

        <p className="mt-4 text-xs text-muted-foreground">
          {t("search.uneditedKept")}
        </p>
      </fieldset>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void reload()}
          disabled={running !== null}
        >
          <RefreshCw aria-hidden />
          {t("search.reload")}
        </Button>
        <Button
          type="button"
          onClick={() => void publish()}
          disabled={running !== null || !dirty || baseline === null}
        >
          {running === "publish" ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Save aria-hidden />
          )}
          {running === "publish" ? t("search.saving") : t("search.save")}
        </Button>
      </div>
    </div>
  );
}
