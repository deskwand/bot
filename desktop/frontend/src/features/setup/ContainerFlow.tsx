import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Server } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ErrorAlert, StepList } from "@/components/feedback";
import { useApp } from "@/components/app-context";
import { useT, type MessageKey } from "@/i18n";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  parseUserIDs,
  secretNameFor,
} from "@/features/models/catalog";
import { ModelSelect } from "@/features/models/ModelSelect";
import type {
  ContainerPreflightDTO,
  LocalEngine,
  LocalRuntimesDTO,
  SSHHostInputDTO,
  SSHProbeDTO,
  StepDTO,
} from "@/services/types";
import { useCatalogModelOptions } from "./Setup";

type Stage = "host" | "fingerprint" | "runtime" | "preflight" | "configure";

const CHECK_LABELS: Record<string, MessageKey> = {
  docker: "setup.containerCheckDocker",
  compose: "setup.containerCheckCompose",
  permission: "setup.containerCheckPermission",
  arch: "setup.containerCheckArch",
  port: "setup.containerCheckPort",
  dir: "setup.containerCheckDir",
  container: "setup.containerCheckContainer",
  version: "setup.containerCheckVersion",
  service: "setup.containerCheckService",
};

const APPLE_RELEASES = "https://github.com/apple/container/releases";
const ORBSTACK = "https://orbstack.dev";
const DOCKER_DESKTOP = "https://www.docker.com/products/docker-desktop/";

/** The single installed runtime, or null when there is none or a choice to make. */
function onlyEngine(found: LocalRuntimesDTO): LocalEngine | null {
  if (found.apple && found.compose) return null;
  if (found.apple) return "apple";
  if (found.compose) return "compose";
  return null;
}

export function ContainerFlow({
  mode,
  onBack,
  onReady,
}: {
  mode: "ssh" | "local";
  onBack: () => void;
  onReady: () => void;
}) {
  const { client } = useApp();
  const t = useT();
  const { options, error: catalogError, reload: reloadCatalog } =
    useCatalogModelOptions();
  const modelOptions = useMemo(
    () => options.filter((option) => !option.keyless),
    [options],
  );

  const [stage, setStage] = useState<Stage>(mode === "local" ? "runtime" : "host");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [installFailed, setInstallFailed] = useState(false);
  const [probe, setProbe] = useState<SSHProbeDTO | null>(null);
  const [preflight, setPreflight] = useState<ContainerPreflightDTO | null>(null);
  const [runtimes, setRuntimes] = useState<LocalRuntimesDTO | null>(null);
  const [engine, setEngine] = useState<LocalEngine>("apple");
  const detected = useRef(false);

  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState("key");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [secret, setSecret] = useState("");
  const [dir, setDir] = useState("~/deskwand");

  const [ownerIDs, setOwnerIDs] = useState("");
  const [channel, setChannel] = useState("telegram");
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [modelKeys, setModelKeys] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<StepDTO[]>([]);

  // The container runtime has no Workers AI, so the keyless providers are not
  // offered at all; fall back to the first provider that takes a key.
  useEffect(() => {
    const first = modelOptions[0];
    const model = first?.models[0];
    if (!first || !model) return;
    const value = `${first.id}/${model.id}`;
    setButler((current) =>
      modelOptions.some((option) => option.id === parseModelKey(current)?.provider)
        ? current
        : value,
    );
    setTask((current) =>
      modelOptions.some((option) => option.id === parseModelKey(current)?.provider)
        ? current
        : value,
    );
  }, [modelOptions]);

  useEffect(
    () =>
      client.onContainerProgress((step) => {
        setSteps((current) => {
          const index = current.findIndex((entry) => entry.id === step.id);
          if (index === -1) return [...current, step];
          const next = current.slice();
          next[index] = step;
          return next;
        });
      }),
    [client],
  );

  const usedProviders = useMemo(() => {
    const ids = [parseModelKey(butler)?.provider, parseModelKey(task)?.provider]
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }, [butler, task]);

  const hostInput = (): SSHHostInputDTO => ({
    address: address.trim(),
    port: Number(port) || 0,
    user: user.trim(),
    auth,
    ...(auth === "key" ? { keyPath: keyPath.trim() } : {}),
    ...(secret ? { secret } : {}),
    dir: dir.trim(),
  });

  const connectWith = async (fingerprint: string) => {
    setBusy(true);
    setError(null);
    try {
      const report = await client.connectSSHHost(hostInput(), fingerprint);
      setPreflight(report);
      setStage("preflight");
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const probed = await client.probeSSHHost(hostInput());
      setProbe(probed);
      if (probed.known) {
        await connectWith("");
      } else {
        setStage("fingerprint");
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const connectLocalWith = async (chosen: LocalEngine) => {
    setBusy(true);
    setError(null);
    try {
      setPreflight(await client.connectLocal(chosen));
      setStage("preflight");
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const detectRuntimes = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await client.detectLocalRuntimes();
      setRuntimes(found);
      // Exactly one runtime needs no choice, so the preflight starts at once;
      // two leave the choice to the user and none leave the install hints.
      const only = onlyEngine(found);
      if (only) {
        setEngine(only);
        await connectLocalWith(only);
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  // StrictMode mounts twice; a second detection would race the first answer.
  useEffect(() => {
    if (mode !== "local" || detected.current) return;
    detected.current = true;
    void detectRuntimes();
  }, [mode]);

  const recheck = async () => {
    setBusy(true);
    setError(null);
    setInstallFailed(false);
    try {
      setPreflight(await client.containerPreflight());
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const adopt = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.adoptContainer();
      onReady();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const butlerModel = parseModelKey(butler);
    const taskModel = parseModelKey(task);
    if (!butlerModel || !taskModel) {
      setError(new Error("MODELS_REQUIRED: "));
      return;
    }
    const secrets = Object.entries(modelKeys)
      .filter(([, value]) => value.trim().length > 0)
      .map(([provider, value]) => ({
        name: secretNameFor(provider),
        operation: "replace",
        value: value.trim(),
      }));
    setBusy(true);
    setError(null);
    setInstallFailed(false);
    setSteps([]);
    try {
      const result = await client.installContainer({
        telegramUserIds: channel === "telegram" ? parseUserIDs(ownerIDs) : [],
        butlerModel,
        taskModel,
        activeChannel: channel,
        secrets,
      });
      setSteps(result.steps ?? []);
      onReady();
    } catch (cause) {
      setError(cause);
      setInstallFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    setSecret("");
    setModelKeys({});
    onBack();
  };

  const recheckAfterFailure = () => {
    setStage("preflight");
    void recheck();
  };

  const existing = preflight?.existing;
  // Nothing to choose from, or the detection itself failed: the runtime stage
  // can then only offer to look again.
  const showRuntimeRecheck =
    (runtimes === null && error !== null) ||
    (runtimes !== null && !runtimes.apple && !runtimes.compose);

  return (
    <div className="mx-auto max-w-3xl">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2"
        onClick={leave}
      >
        <ArrowLeft aria-hidden />
        {t("shell.back")}
      </Button>
      <PageHeader
        title={mode === "local" ? t("setup.localTitle") : t("setup.containerTitle")}
      />

      {stage === "host" ? (
        <section data-testid="container-host" className="mt-5 space-y-4">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Server className="size-4" aria-hidden />
            {t("setup.containerHostTitle")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="container-address">{t("setup.containerAddress")}</Label>
              <Input
                id="container-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="container-port">{t("setup.containerPort")}</Label>
              <Input
                id="container-port"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="container-user">{t("setup.containerUser")}</Label>
              <Input
                id="container-user"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="container-dir">{t("setup.containerDir")}</Label>
              <Input
                id="container-dir"
                value={dir}
                onChange={(event) => setDir(event.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("setup.containerAuth")}</legend>
            <RadioGroup
              value={auth}
              onValueChange={setAuth}
              aria-label={t("setup.containerAuth")}
              className="grid gap-2 sm:grid-cols-3"
            >
              {[
                { value: "key", label: t("setup.containerAuthKey"), id: "container-auth-key" },
                { value: "agent", label: t("setup.containerAuthAgent"), id: "container-auth-agent" },
                { value: "password", label: t("setup.containerAuthPassword"), id: "container-auth-password" },
              ].map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3"
                >
                  <RadioGroupItem value={option.value} id={option.id} />
                  <span>{option.label}</span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>

          {auth === "key" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="container-key-path">{t("setup.containerKeyPath")}</Label>
                <Input
                  id="container-key-path"
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="container-passphrase">{t("setup.containerPassphrase")}</Label>
                <Input
                  id="container-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {auth === "password" ? (
            <div className="space-y-2 sm:max-w-sm">
              <Label htmlFor="container-password">{t("setup.containerPassword")}</Label>
              <Input
                id="container-password"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </div>
          ) : null}

          <ErrorAlert error={error} />
          <Button
            type="button"
            onClick={() => void connect()}
            disabled={busy || !address.trim() || !user.trim()}
          >
            {busy ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : null}
            {busy ? t("setup.containerConnecting") : t("setup.containerConnect")}
          </Button>
        </section>
      ) : null}

      {stage === "fingerprint" ? (
        <section data-testid="container-fingerprint" className="mt-5 space-y-4">
          <h2 className="text-base font-medium">{t("setup.containerFingerprintTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("setup.containerFingerprintHint")}
          </p>
          <code
            data-i18n-ignore
            className="block break-all rounded-md border border-border p-3 font-mono text-sm"
          >
            {probe?.fingerprint}
          </code>
          <ErrorAlert error={error} />
          <Button
            type="button"
            onClick={() => (probe ? void connectWith(probe.fingerprint) : undefined)}
            disabled={busy || !probe}
          >
            {busy ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : null}
            {t("setup.containerTrust")}
          </Button>
        </section>
      ) : null}

      {stage === "runtime" ? (
        <section data-testid="container-runtime" className="mt-5 space-y-4">
          <h2 className="text-base font-medium">{t("setup.containerRuntimeTitle")}</h2>

          {!runtimes && !error ? (
            <p className="text-sm text-muted-foreground">
              {t("setup.containerRuntimeDetecting")}
            </p>
          ) : null}

          {runtimes && !runtimes.apple && !runtimes.compose ? (
            <>
              <p className="text-sm">{t("setup.containerRuntimeMissing")}</p>
              <div className="space-y-1 rounded-md border border-border p-3">
                <p className="text-sm font-medium">
                  {t("setup.containerRuntimeApple")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("setup.containerRuntimeAppleHint")}
                </p>
                <a
                  href={APPLE_RELEASES}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline underline-offset-3"
                >
                  {t("setup.containerRuntimeAppleLink")}
                </a>
              </div>
              <div className="space-y-1 rounded-md border border-border p-3">
                <p className="text-sm font-medium">
                  {t("setup.containerRuntimeCompose")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("setup.containerRuntimeComposeHint")}
                </p>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={ORBSTACK}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-3"
                  >
                    OrbStack
                  </a>
                  <a
                    href={DOCKER_DESKTOP}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-3"
                  >
                    Docker Desktop
                  </a>
                </div>
              </div>
            </>
          ) : null}

          {runtimes?.apple && runtimes.compose ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {t("setup.containerRuntimeTitle")}
              </legend>
              <RadioGroup
                value={engine}
                onValueChange={(value) => setEngine(value as LocalEngine)}
                aria-label={t("setup.containerRuntimeTitle")}
                className="grid gap-2 sm:grid-cols-2"
              >
                <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                  <RadioGroupItem value="apple" id="container-runtime-apple" />
                  <span>{t("setup.containerRuntimeApple")}</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                  <RadioGroupItem value="compose" id="container-runtime-compose" />
                  <span>{t("setup.containerRuntimeCompose")}</span>
                </label>
              </RadioGroup>
            </fieldset>
          ) : null}

          {busy && runtimes && onlyEngine(runtimes) ? (
            <p className="text-sm text-muted-foreground">
              {t("setup.containerConnecting")}
            </p>
          ) : null}

          <ErrorAlert error={error} />

          {runtimes?.apple && runtimes.compose ? (
            <Button
              type="button"
              onClick={() => void connectLocalWith(engine)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {busy ? t("setup.containerConnecting") : t("common.continue")}
            </Button>
          ) : null}
          {showRuntimeRecheck ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void detectRuntimes()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("setup.containerRecheck")}
            </Button>
          ) : null}
          {runtimes && onlyEngine(runtimes) && error ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void connectLocalWith(engine)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("common.retry")}
            </Button>
          ) : null}
        </section>
      ) : null}

      {stage === "preflight" ? (
        <section data-testid="container-preflight" className="mt-5 space-y-4">
          <h2 className="text-base font-medium">{t("setup.containerPreflightTitle")}</h2>
          <ul className="space-y-2">
            {preflight?.checks.map((check) => (
              <li
                key={check.id}
                data-testid={`container-check-${check.id}`}
                className="rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {check.id === "dir" && mode === "local"
                      ? t("setup.containerCheckDirLocal")
                      : CHECK_LABELS[check.id]
                        ? t(CHECK_LABELS[check.id]!)
                        : check.id}
                  </span>
                  <Badge variant={check.ok ? "secondary" : "outline"}>
                    {check.ok
                      ? t("setup.containerCheckOK")
                      : t("setup.containerCheckFailed")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span data-i18n-ignore>{check.detail}</span>
                </p>
                {check.fix ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code
                      data-i18n-ignore
                      className="break-all rounded bg-muted px-2 py-1 font-mono text-xs"
                    >
                      {check.fix}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void navigator.clipboard.writeText(check.fix ?? "")}
                    >
                      {t("setup.containerCopy")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {existing ? (
            <Card>
              <CardContent className="pt-4">
                <h3 className="text-sm font-medium">
                  {t("setup.containerExistingTitle")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {mode === "local"
                    ? t("setup.containerExistingHintLocal")
                    : t("setup.containerExistingHint")}
                </p>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("setup.containerOwner")}
                    </dt>
                    <dd data-i18n-ignore>{existing.ownerUserIds.join(", ")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("setup.containerRelease")}
                    </dt>
                    <dd data-i18n-ignore>{existing.releaseVersion ?? ""}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("models.butlerModel")}
                    </dt>
                    <dd data-i18n-ignore>
                      {existing.butlerModel
                        ? `${existing.butlerModel.provider}/${existing.butlerModel.id}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("models.taskModel")}
                    </dt>
                    <dd data-i18n-ignore>
                      {existing.taskModel
                        ? `${existing.taskModel.provider}/${existing.taskModel.id}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("setup.initialChannel")}
                    </dt>
                    <dd data-i18n-ignore>{existing.activeChannel ?? ""}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <ErrorAlert error={error} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void recheck()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("setup.containerRecheck")}
            </Button>
            {existing ? (
              <Button type="button" onClick={() => void adopt()} disabled={busy}>
                {t("setup.containerAdopt")}
              </Button>
            ) : preflight?.passed ? (
              <Button type="button" onClick={() => setStage("configure")} disabled={busy}>
                {t("setup.containerNext")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {stage === "configure" ? (
        <section data-testid="container-configure" className="mt-5 space-y-5">
          <h2 className="text-base font-medium">{t("setup.containerConfigureTitle")}</h2>

          <ErrorAlert
            error={catalogError}
            onRetry={reloadCatalog}
            retryLabel={t("setup.reloadCatalog")}
          />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("setup.initialChannel")}</legend>
            <RadioGroup
              value={channel}
              onValueChange={setChannel}
              aria-label={t("setup.initialChannel")}
              className="grid gap-2 sm:grid-cols-2"
            >
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="telegram" id="container-channel-telegram" />
                <span>Telegram</span>
              </label>
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="wechat" id="container-channel-wechat" />
                <span>{t("common.wechat")}</span>
              </label>
            </RadioGroup>
          </fieldset>

          {channel === "telegram" ? (
            <div className="space-y-2">
              <Label htmlFor="container-owners">{t("setup.ownersLabel")}</Label>
              <Input
                id="container-owners"
                value={ownerIDs}
                onChange={(event) => setOwnerIDs(event.target.value)}
                placeholder={t("setup.ownersPlaceholder")}
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">{t("setup.ownersHint")}</p>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="container-butler">{t("models.butlerModel")}</Label>
              <ModelSelect
                id="container-butler"
                label={t("models.butlerModel")}
                value={butler}
                onChange={setButler}
                options={modelOptions}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="container-task">{t("models.taskModel")}</Label>
              <ModelSelect
                id="container-task"
                label={t("models.taskModel")}
                value={task}
                onChange={setTask}
                options={modelOptions}
              />
            </div>
          </div>

          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">{t("setup.containerModelKeys")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("setup.containerModelKeyHint")}
            </p>
            {usedProviders.map((provider) => {
              const option = modelOptions.find((entry) => entry.id === provider);
              return (
                <div key={provider} className="space-y-2">
                  <Label htmlFor={`container-model-key-${provider}`}>
                    {t("setup.containerModelKey", {
                      provider: option?.label ?? provider,
                    })}
                  </Label>
                  <Input
                    id={`container-model-key-${provider}`}
                    data-testid={`container-model-key-${provider}`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={modelKeys[provider] ?? ""}
                    onChange={(event) =>
                      setModelKeys((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                  />
                </div>
              );
            })}
          </section>

          <ErrorAlert
            error={error}
            onRetry={installFailed ? recheckAfterFailure : undefined}
            retryLabel={t("setup.containerRecheck")}
          />

          {steps.length > 0 ? (
            <div data-testid="container-progress">
              <p className="text-sm font-medium">{t("setup.containerProgress")}</p>
              <StepList steps={steps} />
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              onClick={() => void install()}
              disabled={
                busy ||
                !butler ||
                !task ||
                !channel ||
                !Object.values(modelKeys).some((value) => value.trim().length > 0)
              }
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {busy ? t("setup.containerDeploying") : t("setup.containerSubmit")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
