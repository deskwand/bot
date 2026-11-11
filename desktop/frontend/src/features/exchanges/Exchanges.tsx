import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDirty } from "@/components/use-dirty";
import { useT, type MessageKey } from "@/i18n";
import { toClientError } from "@/services/errors";
import { useConfigQuery, useInvalidate } from "@/services/queries";
import type {
  ConfigDTO,
  ConfigEditDTO,
  ExchangeAccountDTO,
  ExchangeProbeDTO,
  SecretEditDTO,
} from "@/services/types";
import { EXCHANGE_VENUES, exchangeSecretName, venueOption } from "./providers";
import { accountProblems } from "./validate";

type SecretDraft = { key: string; secret: string; passphrase: string };
type ProbeState = {
  status: "idle" | "running" | "done" | "error";
  result?: ExchangeProbeDTO;
};

/**
 * Rows carry their own identity: the account id is editable, and drafts must
 * survive the user fixing a typo in it.
 */
type Row = { rowKey: string; account: ExchangeAccountDTO };

const emptyDraft = (): SecretDraft => ({ key: "", secret: "", passphrase: "" });

const draftTouched = (draft: SecretDraft): boolean =>
  draft.key.trim() !== "" ||
  draft.secret.trim() !== "" ||
  draft.passphrase.trim() !== "";

export function Exchanges() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const invalidate = useInvalidate();
  const [baseline, setBaseline] = useState<ConfigDTO | null>(null);
  const config = baseline ?? configQuery.data ?? null;
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, SecretDraft>>({});
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [running, setRunning] = useState<null | "publish">(null);
  const [awaitingFreshConfig, setAwaitingFreshConfig] = useState(false);
  const [success, setSuccess] = useState(false);
  const nextRowKey = useRef(0);

  const makeRowKey = (): string => {
    nextRowKey.current += 1;
    return `row-${nextRowKey.current}`;
  };

  // A config cached by an older client has no exchangeAccounts field at all.
  const fillFromConfig = useCallback((next: ConfigDTO) => {
    const published = next.exchangeAccounts ?? [];
    const rows = published.map((account) => ({
      rowKey: `row-${++nextRowKey.current}`,
      account: { ...account },
    }));
    setRows(rows);
    setDrafts(
      Object.fromEntries(rows.map((row) => [row.rowKey, emptyDraft()])),
    );
    setProbes({});
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
    setSuccess(false);
    await applyFreshConfig();
  };

  useEffect(() => {
    if (awaitingFreshConfig) return;
    const next = configQuery.data;
    if (!next) return;
    // Read-only preview from the disk cache; it must never seed the form's
    // baseline or the fingerprint sent with a publish.
    if (configQuery.isPlaceholder) return;
    if (!baseline) {
      setBaseline(next);
      fillFromConfig(next);
    }
  }, [
    awaitingFreshConfig,
    baseline,
    configQuery.data,
    configQuery.isPlaceholder,
    fillFromConfig,
  ]);

  const accounts = useMemo(
    () => rows.map((row) => row.account),
    [rows],
  );
  const problems = useMemo(() => accountProblems(accounts), [accounts]);

  const draftOf = (rowKey: string): SecretDraft =>
    drafts[rowKey] ?? emptyDraft();

  const incompleteRows = useMemo(() => {
    const incomplete = new Set<string>();
    for (const row of rows) {
      const draft = draftOf(row.rowKey);
      if (!draftTouched(draft)) continue;
      const needsPassphrase = (
        venueOption(row.account.venue)?.fields ?? []
      ).includes("passphrase");
      if (
        draft.key.trim() === "" ||
        draft.secret.trim() === "" ||
        (needsPassphrase && draft.passphrase.trim() === "")
      ) {
        incomplete.add(row.rowKey);
      }
    }
    return incomplete;
  }, [rows, drafts]);

  const dirty = useMemo(() => {
    if (!baseline) return false;
    const changed =
      JSON.stringify(accounts) !== JSON.stringify(baseline.exchangeAccounts ?? []);
    const secretsChanged = Object.values(drafts).some(draftTouched);
    return changed || secretsChanged;
  }, [accounts, baseline, drafts]);
  useDirty(dirty);

  const configured = (name: string) =>
    config?.secrets.find((entry) => entry.name === name)?.configured ?? false;

  // Probing a row that has never been published would sit in the Worker's
  // 30-second "version not live yet" retry for nothing.
  const publishedIds = useMemo(
    () => new Set((config?.exchangeAccounts ?? []).map((account) => account.id)),
    [config?.exchangeAccounts],
  );

  // Removing an account leaves its secret behind: this version does not delete
  // secrets. Say so instead of pretending the page is clean.
  const orphanSecrets = (config?.secrets ?? [])
    .filter((entry) => entry.name.startsWith("EXCHANGE_SECRET_"))
    .filter(
      (entry) =>
        !accounts.some(
          (account) => exchangeSecretName(account.id) === entry.name,
        ),
    )
    .map((entry) => entry.name);

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
    // Explicit choice: adopting the newer config drops this form's drafts.
    applyConfig(next);
    setSuccess(false);
  };

  const updateAccount = (
    rowKey: string,
    patch: Partial<ExchangeAccountDTO>,
  ) => {
    setRows((current) =>
      current.map((row) =>
        row.rowKey === rowKey
          ? { ...row, account: { ...row.account, ...patch } }
          : row,
      ),
    );
    // Anything the probe depends on makes its result stale.
    setProbes((current) => {
      if (current[rowKey] === undefined) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  };

  const addAccount = () => {
    let suffix = rows.length + 1;
    while (accounts.some((account) => account.id === `exchange-${suffix}`)) {
      suffix += 1;
    }
    const rowKey = makeRowKey();
    setRows((current) => [
      ...current,
      {
        rowKey,
        account: { id: `exchange-${suffix}`, venue: "okx", label: "", baseUrl: "" },
      },
    ]);
    setDrafts((current) => ({ ...current, [rowKey]: emptyDraft() }));
  };

  const removeAccount = (rowKey: string) => {
    setRows((current) => current.filter((row) => row.rowKey !== rowKey));
    setDrafts((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setProbes((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  };

  const updateDraft = (
    rowKey: string,
    field: keyof SecretDraft,
    value: string,
  ) => {
    setDrafts((current) => ({
      ...current,
      [rowKey]: { ...(current[rowKey] ?? emptyDraft()), [field]: value },
    }));
  };

  const edit = (): ConfigEditDTO => {
    const secrets: SecretEditDTO[] = [];
    for (const row of rows) {
      const draft = draftOf(row.rowKey);
      if (!draft.key.trim() || !draft.secret.trim()) continue;
      const payload: Record<string, string> = {
        key: draft.key.trim(),
        secret: draft.secret.trim(),
      };
      if (
        (venueOption(row.account.venue)?.fields ?? []).includes("passphrase")
      ) {
        if (!draft.passphrase.trim()) continue;
        payload.passphrase = draft.passphrase.trim();
      }
      secrets.push({
        name: exchangeSecretName(row.account.id),
        operation: "replace",
        value: JSON.stringify(payload),
      });
    }
    const changed =
      baseline !== null &&
      JSON.stringify(accounts) !== JSON.stringify(baseline.exchangeAccounts ?? []);
    return {
      baseFingerprint: baseline?.fingerprint,
      ...(changed ? { exchangeAccounts: accounts } : {}),
      secrets,
    };
  };

  const publish = async () => {
    if (problems.length > 0 || incompleteRows.size > 0) return;
    setRunning("publish");
    setError(null);
    setConflict(false);
    setSuccess(false);
    try {
      await client.publishConfig(edit());
      setSuccess(true);
      setAwaitingFreshConfig(true);
      setBaseline(null);
      invalidate.config();
      // The refetch re-seeds the form and clears the write-only drafts. On a
      // failure the drafts stay: a pasted API secret cannot be read back.
      const fresh = await applyFreshConfig();
      if (fresh === undefined) setSuccess(false);
    } catch (cause) {
      if (toClientError(cause).code === "CONFIG_CONFLICT") setConflict(true);
      setError(cause);
      setSuccess(false);
    } finally {
      setRunning(null);
    }
  };

  const test = async (rowKey: string, accountId: string) => {
    setProbes((current) => ({ ...current, [rowKey]: { status: "running" } }));
    try {
      const result = await client.testExchange(accountId);
      setProbes((current) => ({
        ...current,
        [rowKey]: { status: "done", result },
      }));
    } catch (cause) {
      setError(cause);
      setProbes((current) => ({ ...current, [rowKey]: { status: "error" } }));
    }
  };

  if (!config && configQuery.isFetching) {
    return (
      <div className="flex min-h-[40svh] items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        {t("exchange.loading")}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("shell.pages.exchange")}
        description={t("exchange.intro")}
        actions={
          <Badge variant="outline">
            <ShieldCheck aria-hidden />
            {t("exchange.keysNeverEchoed")}
          </Badge>
        }
      />

      <ErrorAlert
        error={error}
        onReload={conflict ? () => void reload() : undefined}
        reloadLabel={t("exchange.reloadConfig")}
      />
      {cloudUpdated ? (
        <Alert className="my-4" role="status">
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("exchange.cloudUpdatedTitle")}</span>
            <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
              {t("exchange.loadLatest")}
            </Button>
          </AlertTitle>
          <AlertDescription>
            {t("exchange.cloudUpdatedDescription")}
          </AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <Alert className="my-4" role="status">
          <AlertDescription>{t("exchange.submitted")}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={baseline === null} className="m-0 min-w-0 border-0 p-0">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="exchange-empty">
            {t("exchange.empty")}
          </p>
        ) : null}

        <ul className="mt-3 space-y-4">
          {rows.map((row, index) => {
            const account = row.account;
            const option = venueOption(account.venue) ?? EXCHANGE_VENUES[0]!;
            const secretName = exchangeSecretName(account.id);
            const draft = draftOf(row.rowKey);
            const probe = probes[row.rowKey];
            const rowProblems = problems.filter(
              (problem) => problem.index === index,
            );
            const secretReady = configured(secretName) || draftTouched(draft);
            return (
              <li
                key={row.rowKey}
                className="rounded-md border border-border p-4"
                data-testid={`exchange-row-${index}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{option.name}</p>
                  <Badge
                    variant={configured(secretName) ? "secondary" : "outline"}
                  >
                    {configured(secretName)
                      ? t("exchange.configured")
                      : t("exchange.notConfigured")}
                  </Badge>
                </div>

                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`exchange-id-${index}`}>
                      {t("exchange.id")}
                    </Label>
                    <Input
                      id={`exchange-id-${index}`}
                      value={account.id}
                      onChange={(event) =>
                        updateAccount(row.rowKey, { id: event.target.value })
                      }
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("exchange.idHint")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`exchange-venue-${index}`}>
                      {t("exchange.venue")}
                    </Label>
                    <select
                      id={`exchange-venue-${index}`}
                      value={account.venue}
                      onChange={(event) =>
                        updateAccount(row.rowKey, { venue: event.target.value })
                      }
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {EXCHANGE_VENUES.map((venue) => (
                        <option key={venue.id} value={venue.id}>
                          {venue.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`exchange-label-${index}`}>
                      {t("exchange.label")}
                    </Label>
                    <Input
                      id={`exchange-label-${index}`}
                      value={account.label ?? ""}
                      onChange={(event) =>
                        updateAccount(row.rowKey, {
                          label: event.target.value,
                        })
                      }
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`exchange-base-${index}`}>
                      {t("exchange.baseUrl")}
                    </Label>
                    <Input
                      id={`exchange-base-${index}`}
                      value={account.baseUrl ?? ""}
                      placeholder={option.defaultBaseUrl}
                      onChange={(event) =>
                        updateAccount(row.rowKey, {
                          baseUrl: event.target.value,
                        })
                      }
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("exchange.baseUrlHint")}
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  {option.fields.map((field) => (
                    <div key={field} className="space-y-2">
                      <Label htmlFor={`exchange-${field}-${index}`}>
                        {field === "key"
                          ? t("exchange.apiKey")
                          : field === "secret"
                            ? t("exchange.apiSecret")
                            : t("exchange.passphrase")}
                      </Label>
                      <Input
                        id={`exchange-${field}-${index}`}
                        type="password"
                        value={draft[field]}
                        onChange={(event) =>
                          updateDraft(row.rowKey, field, event.target.value)
                        }
                        placeholder={
                          configured(secretName)
                            ? t("exchange.keyPlaceholderConfigured")
                            : t("exchange.keyPlaceholderNew")
                        }
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void test(row.rowKey, account.id)}
                    disabled={
                      probe?.status === "running" || !publishedIds.has(account.id)
                    }
                  >
                    {probe?.status === "running"
                      ? t("exchange.testing")
                      : t("exchange.test")}
                  </Button>
                  {publishedIds.has(account.id) ? null : (
                    <span className="text-xs text-muted-foreground">
                      {t("exchange.testNeedsSave")}
                    </span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => removeAccount(row.rowKey)}
                  >
                    <Trash2 aria-hidden />
                    {t("exchange.remove")}
                  </Button>
                  <a
                    href={option.signupUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-3"
                  >
                    {t("exchange.signup")}
                  </a>
                </div>

                <p className="mt-2 text-xs text-muted-foreground">
                  {t("exchange.permissions", { permission: option.permissions })}
                </p>

                {rowProblems.map((problem) => (
                  <p
                    key={problem.key + problem.field}
                    className="mt-1 text-xs text-destructive"
                  >
                    {t(problem.key as MessageKey)}
                  </p>
                ))}
                {incompleteRows.has(row.rowKey) ? (
                  <p className="mt-1 text-xs text-destructive">
                    {t("exchange.problemSecretIncomplete")}
                  </p>
                ) : null}
                {secretReady ? null : (
                  <p className="mt-1 text-xs text-destructive">
                    {t("exchange.secretNotSet")}
                  </p>
                )}

                {probe?.status === "done" && probe.result ? (
                  <p
                    className="mt-2 text-xs"
                    data-testid={`exchange-probe-${index}`}
                  >
                    {probe.result.ok
                      ? probe.result.total === undefined
                        ? t("exchange.testOKNoTotal", {
                            currencies: probe.result.currencies,
                          })
                        : t("exchange.testOK", {
                            currencies: probe.result.currencies,
                            total: probe.result.total.toFixed(2),
                          })
                      : probe.result.code === "EXCHANGE_ACCOUNT_UNKNOWN"
                        ? t("exchange.testNeedsSave")
                        : t("exchange.testRefused", {
                            message:
                              probe.result.message ?? probe.result.code ?? "",
                          })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        {orphanSecrets.length > 0 ? (
          <Alert
            className="mt-4"
            role="status"
            data-testid="exchange-orphan-secrets"
          >
            <AlertDescription>
              {t("exchange.orphanSecrets", { names: orphanSecrets.join("、") })}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={addAccount}>
            <Plus aria-hidden />
            {t("exchange.addAccount")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("exchange.uneditedKept")}
          </p>
        </div>
      </fieldset>

      {problems.length > 0 ? (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            {t("exchange.invalid", { count: problems.length })}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void reload()}
          disabled={running !== null}
        >
          <RefreshCw aria-hidden />
          {t("exchange.reload")}
        </Button>
        <Button
          type="button"
          onClick={() => void publish()}
          disabled={
            running !== null ||
            !dirty ||
            baseline === null ||
            problems.length > 0 ||
            incompleteRows.size > 0
          }
        >
          {running === "publish" ? (
            <Loader2
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Save aria-hidden />
          )}
          {running === "publish" ? t("exchange.saving") : t("exchange.save")}
        </Button>
      </div>
    </div>
  );
}
