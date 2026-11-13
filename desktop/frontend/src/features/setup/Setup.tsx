import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Laptop,
  Loader2,
  RefreshCw,
  Server,
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
import { useT, type MessageKey } from "@/i18n";
import { useDirty } from "@/components/use-dirty";
import { toClientError } from "@/services/errors";
import { useApp } from "@/components/app-context";
import { cloudflareNeuronsNotice } from "@/lib/copy";
import { useUiStore } from "@/store/ui";
import type { AccountDTO, ImportPreviewDTO, ResultDTO, WorkerDTO } from "@/services/types";
import {
  DEFAULT_MODEL,
  modelKey,
  parseModelKey,
  parseUserIDs,
  providerOptions,
  type ProviderOption,
} from "@/features/models/catalog";
import { ModelSelect } from "@/features/models/ModelSelect";
import { ContainerFlow } from "./ContainerFlow";

export type SetupPhase = "disconnected" | "choose";


export function useCatalogModelOptions(): {
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
  localSupported = false,
  connectionError,
  connectionAccount,
  onSessionChange,
  onReady,
  initialStep = "welcome",
}: {
  phase: SetupPhase;
  localSupported?: boolean;
  connectionError?: unknown;
  connectionAccount?: string;
  onSessionChange: () => void;
  onReady: () => void;
  initialStep?: "welcome" | "deploy" | "import";
}) {
  const [step, setStep] = useState<
    "welcome" | "deploy" | "import" | "container" | "local"
  >(initialStep);

  if (step === "container" || step === "local") {
    return (
      <ContainerFlow
        mode={step === "local" ? "local" : "ssh"}
        onBack={() => setStep("welcome")}
        onReady={onReady}
      />
    );
  }

  if (phase === "disconnected") {
    return (
      <Welcome
        connectionError={connectionError}
        connectionAccount={connectionAccount}
        localSupported={localSupported}
        onConnected={onSessionChange}
        onShowDeploy={() => setStep("deploy")}
        onShowImport={() => setStep("import")}
        onShowContainer={() => setStep("container")}
        onShowLocal={() => setStep("local")}
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
      localSupported={localSupported}
      onConnected={onSessionChange}
      onShowDeploy={() => setStep("deploy")}
      onShowImport={() => setStep("import")}
      onShowContainer={() => setStep("container")}
      onShowLocal={() => setStep("local")}
    />
  );
}

function Welcome({
  connected = false,
  connectionError,
  connectionAccount,
  localSupported = false,
  onConnected,
  onShowDeploy,
  onShowImport,
  onShowContainer,
  onShowLocal,
}: {
  connected?: boolean;
  connectionError?: unknown;
  connectionAccount?: string;
  localSupported?: boolean;
  onConnected: () => void;
  onShowDeploy: () => void;
  onShowImport: () => void;
  onShowContainer: () => void;
  onShowLocal: () => void;
}) {
  const { client } = useApp();
  const t = useT();
  const [accountName, setAccountName] = useState("");

  useEffect(() => {
    if (!connected) {
      setAccountName("");
      return;
    }
    let cancelled = false;
    client
      .cloudflareStatus()
      .then((connection) => {
        if (!cancelled) setAccountName(connection.accountName ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, connected]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">{t("setup.title")}</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        {t("setup.subtitle")}
      </p>

      {!connected ? (
        <>
          <ConnectCard
            connectionError={connectionError}
            connectionAccount={connectionAccount}
            onConnected={onConnected}
          />
          <div className={localSupported ? "mt-4 grid gap-4 sm:grid-cols-2" : "mt-4"}>
            <button
              type="button"
              className="w-full text-left"
              onClick={onShowContainer}
              aria-label={t("setup.containerTitle")}
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Server className="size-4" aria-hidden />
                    {t("setup.containerTitle")}
                  </CardTitle>
                  <CardDescription>{t("setup.containerDescription")}</CardDescription>
                </CardHeader>
              </Card>
            </button>
            {localSupported ? (
              <button
                type="button"
                className="w-full text-left"
                onClick={onShowLocal}
                aria-label={t("setup.localTitle")}
              >
                <Card className="h-full transition-colors hover:border-primary/60">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Laptop className="size-4" aria-hidden />
                      {t("setup.localTitle")}
                    </CardTitle>
                    <CardDescription>{t("setup.localDescription")}</CardDescription>
                  </CardHeader>
                </Card>
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              className="text-left"
              onClick={onShowDeploy}
              aria-label={t("setup.deployTitle")}
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Cloud className="size-4" aria-hidden />
                    {t("setup.deployTitle")}
                  </CardTitle>
                  <CardDescription>{t("setup.deployDescription")}</CardDescription>
                </CardHeader>
              </Card>
            </button>
            <button
              type="button"
              className="text-left"
              onClick={onShowImport}
              aria-label={t("setup.importTitle")}
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <RefreshCw className="size-4" aria-hidden />
                    {t("setup.importTitle")}
                  </CardTitle>
                  <CardDescription>{t("setup.importDescription")}</CardDescription>
                </CardHeader>
              </Card>
            </button>
            <button
              type="button"
              className="text-left"
              onClick={onShowContainer}
              aria-label={t("setup.containerTitle")}
            >
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Server className="size-4" aria-hidden />
                    {t("setup.containerTitle")}
                  </CardTitle>
                  <CardDescription>{t("setup.containerDescription")}</CardDescription>
                </CardHeader>
              </Card>
            </button>
            {localSupported ? (
              <button
                type="button"
                className="text-left"
                onClick={onShowLocal}
                aria-label={t("setup.localTitle")}
              >
                <Card className="h-full transition-colors hover:border-primary/60">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Laptop className="size-4" aria-hidden />
                      {t("setup.localTitle")}
                    </CardTitle>
                    <CardDescription>{t("setup.localDescription")}</CardDescription>
                  </CardHeader>
                </Card>
              </button>
            ) : null}
          </div>
          {accountName ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {t("setup.connectedAccount")}
              <span data-i18n-ignore>{accountName}</span>
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {t("setup.cloudKeepsRunning")}
          </p>
        </>
      )}
    </div>
  );
}

function ConnectCard({
  connectionError,
  connectionAccount,
  onConnected,
}: {
  connectionError?: unknown;
  connectionAccount?: string;
  onConnected: () => void;
}) {
  const { client } = useApp();
  const t = useT();
  const [state, setState] = useState<"idle" | "waiting" | "select" | "connected">("idle");
  const [accounts, setAccounts] = useState<AccountDTO[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const opIDRef = useRef("");

  useEffect(
    () =>
      client.subscribeCloudflareLogin((status) => {
        // The first event can arrive before startCloudflareLogin resolves, so
        // adopt its operation id instead of dropping it.
        if (opIDRef.current === "") {
          opIDRef.current = status.operationId;
        } else if (status.operationId !== opIDRef.current) {
          return;
        }
        switch (status.state) {
          case "waiting_browser":
            setState("waiting");
            break;
          case "select_account":
            setAccounts(status.accounts ?? []);
            setSelected(status.accounts?.[0]?.id ?? "");
            setState("select");
            break;
          case "connected":
            // Stay in a success state: the parent keeps rendering this card
            // until its status read finishes, and flipping back to the login
            // button here makes a successful login look like a failure.
            opIDRef.current = "";
            setState("connected");
            onConnected();
            break;
          case "cancelled":
            opIDRef.current = "";
            setState("idle");
            break;
          default:
            opIDRef.current = "";
            setState("idle");
            setError(new Error(`${status.code ?? "AUTH_OAUTH_EXCHANGE_FAILED"}: `));
        }
      }),
    [client, onConnected],
  );

  // Closing the card or the window must not leave a login holding the port.
  useEffect(
    () => () => {
      if (opIDRef.current) {
        void client.cancelCloudflareLogin(opIDRef.current).catch(() => undefined);
      }
    },
    [client],
  );

  const start = async () => {
    setError(null);
    setState("waiting");
    try {
      const operationID = await client.startCloudflareLogin();
      // An event may already have adopted this id; never clobber it.
      if (!opIDRef.current) opIDRef.current = operationID;
    } catch (cause) {
      opIDRef.current = "";
      setState("idle");
      setError(cause);
    }
  };

  const cancel = () => {
    const opID = opIDRef.current;
    opIDRef.current = "";
    setState("idle");
    if (opID) void client.cancelCloudflareLogin(opID).catch(() => undefined);
  };

  const confirm = async () => {
    if (confirming) return;
    setConfirming(true);
    setError(null);
    try {
      await client.confirmCloudflareAccount(selected);
    } catch (cause) {
      setError(cause);
    } finally {
      setConfirming(false);
    }
  };

  // A success that the parent has already contradicted must not keep claiming
  // success: fall back to the login button so the user still has a way in.
  const showSuccess = state === "connected" && !connectionError;
  const showLogin = state === "idle" || (state === "connected" && Boolean(connectionError));

  return (
    <Card className="mt-7">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="size-4" aria-hidden />
          {t("setup.connectTitle")}
        </CardTitle>
        <CardDescription>
          {t("setup.connectDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorAlert error={connectionError} />
        {connectionAccount ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("errors.reauthAccount")}
            <span data-i18n-ignore>{connectionAccount}</span>
          </p>
        ) : null}

        {showLogin ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("setup.browserAuth")}</p>
            <Button type="button" onClick={() => void start()}>
              <Cloud aria-hidden />
              {t("setup.loginWithCloudflare")}
            </Button>
          </div>
        ) : null}

        {state === "waiting" ? (
          <div className="space-y-3">
            <p className="text-sm">{t("setup.waitingBrowser")}</p>
            <Button type="button" variant="outline" onClick={cancel}>
              {t("common.cancel")}
            </Button>
          </div>
        ) : null}

        {showSuccess ? (
          <div className="space-y-3">
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4" aria-hidden />
              {t("setup.connectedReading")}
            </p>
            <Button type="button" variant="outline" onClick={() => onConnected()}>
              {t("setup.recheck")}
            </Button>
          </div>
        ) : null}

        {state === "select" ? (
          <div className="space-y-3">
            <p className="text-sm">{t("setup.multipleAccounts")}</p>
            <RadioGroup value={selected} onValueChange={setSelected}>
              {accounts.map((account) => (
                <div key={account.id} className="flex items-center gap-2">
                  <RadioGroupItem value={account.id} id={`account-${account.id}`} />
                  <Label htmlFor={`account-${account.id}`}><span data-i18n-ignore>{account.name || account.id}</span></Label>
                </div>
              ))}
            </RadioGroup>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void confirm()} disabled={!selected || confirming}>
                {t("common.continue")}
              </Button>
              <Button type="button" variant="outline" onClick={cancel}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        <ErrorAlert error={error} onRetry={start} retryLabel={t("setup.retryLogin")} />
      </CardContent>
    </Card>
  );
}

function GuardedBack({
  dirty,
  onBack,
  label,
}: {
  dirty: boolean;
  onBack: () => void;
  label?: string;
}) {
  const t = useT();
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
        {label ?? t("shell.back")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shell.unsavedTitle")}</DialogTitle>
            <DialogDescription>{t("setup.unsavedDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("shell.keepEditing")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                onBack();
              }}
            >
              {t("setup.discardAndBack")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeployFlow({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const { client } = useApp();
  const t = useT();
  const { options: modelOptions, error: catalogError, reload: reloadCatalog } =
    useCatalogModelOptions();
  const setPage = useUiStore((state) => state.setPage);
  const [workerName, setWorkerName] = useState("deskwand-bot");
  const [bucketName, setBucketName] = useState("deskwand-files");
  const [ownerIDs, setOwnerIDs] = useState("");
  const [channel, setChannel] = useState("");
  const [butler, setButler] = useState(modelKey(DEFAULT_MODEL));
  const [task, setTask] = useState(modelKey(DEFAULT_MODEL));
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourceError, setResourceError] = useState<MessageKey | null>(null);
  const [invalidResource, setInvalidResource] = useState<"worker-name" | "bucket-name" | null>(null);
  const workerRef = useRef<HTMLInputElement>(null);
  const bucketRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (resourcesOpen && invalidResource) {
      (invalidResource === "worker-name" ? workerRef : bucketRef).current?.focus();
    }
  }, [resourcesOpen, invalidResource]);
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
    setResourceError(null);
    setInvalidResource(null);
    if (!workerName.trim() || !bucketName.trim()) {
      setResourceError("setup.resourceRequired");
      setInvalidResource(!workerName.trim() ? "worker-name" : "bucket-name");
      setResourcesOpen(true);
      return;
    }
    setChecking(true);
    setProgress(8);
    try {
      const scripts = await client.listWorkers();
      if (scripts.some((script) => script.name === workerName.trim())) {
        setResourceError("setup.nameTaken");
        setInvalidResource("worker-name");
        setResourcesOpen(true);
        return;
      }
      const butlerModel = parseModelKey(butler);
      const taskModel = parseModelKey(task);
      if (!butlerModel || !taskModel) {
        setError(new Error("MODELS_REQUIRED: "));
        return;
      }
      setProgress(25);
      setRunning(true);
      const installed = await client.install({
        accountId: "",
        workerName: workerName.trim(),
        bucketName: bucketName.trim(),
        telegramUserIds: channel === "telegram" ? parseUserIDs(ownerIDs) : [],
        butlerModel,
        taskModel,
        activeChannel: channel,
      });
      setProgress(100);
      setResult(installed);
    } catch (cause) {
      setError(cause);
      const code = toClientError(cause).code;
      if (code === "NAME_TAKEN" || code === "BUCKET_TAKEN") {
        setInvalidResource(code === "NAME_TAKEN" ? "worker-name" : "bucket-name");
        setResourcesOpen(true);
      }
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
      <PageHeader title={published ? t("setup.deployedNext") : t("setup.deployTitle")} />

      {!result ? (
        <section>
            <ErrorAlert
              error={catalogError}
              onRetry={reloadCatalog}
              retryLabel={t("setup.reloadCatalog")}
            />
            <form
              noValidate
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                void checkAndInstall();
              }}
            >
              <section aria-label={t("setup.modelsSection")}>
                <h2 className="mb-3 text-base font-medium">{t("setup.modelsSection")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="install-butler">{t("models.butlerModel")}</Label><ModelSelect id="install-butler" label={t("models.butlerModel")} value={butler} onChange={setButler} options={modelOptions} /></div>
                  <div className="space-y-2"><Label htmlFor="install-task">{t("models.taskModel")}</Label><ModelSelect id="install-task" label={t("models.taskModel")} value={task} onChange={setTask} options={modelOptions} /></div>
                </div>
              </section>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("setup.initialChannel")}</legend>
                <p className="text-xs text-muted-foreground">
                  {t("setup.initialChannelHint")}
                </p>
                <RadioGroup
                  value={channel}
                  onValueChange={setChannel}
                  aria-label={t("setup.initialChannel")}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                    <RadioGroupItem value="telegram" id="install-channel-telegram" />
                    <span>Telegram</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
                    <RadioGroupItem value="wechat" id="install-channel-wechat" />
                    <span>{t("common.wechat")}</span>
                  </label>
                </RadioGroup>
              </fieldset>

              {channel === "telegram" ? <div className="space-y-2">
                <Label htmlFor="install-owners">{t("setup.ownersLabel")}</Label>
                <Input id="install-owners" value={ownerIDs} onChange={(event) => setOwnerIDs(event.target.value)} placeholder={t("setup.ownersPlaceholder")} inputMode="numeric" aria-describedby="install-owner-hint" />
                <p id="install-owner-hint" className="text-xs text-muted-foreground">{t("setup.ownersHint")}</p>
              </div> : channel === "wechat" ? <p className="text-sm text-muted-foreground">{t("setup.wechatAfterDeploy")}</p> : null}

              {parseModelKey(butler)?.provider === "workers-ai" || parseModelKey(task)?.provider === "workers-ai" ? (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t("setup.quotaSummary")}</summary>
                  <p className="mt-2" data-testid="workers-ai-quota-notice">{cloudflareNeuronsNotice()}</p>
                </details>
              ) : null}

              <details open={resourcesOpen} onToggle={(event) => setResourcesOpen(event.currentTarget.open)} className="border-t border-border pt-4">
                <summary className="cursor-pointer text-sm font-medium">{t("setup.resources")}</summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="worker-name">{t("setup.workerName")}</Label>
                    <Input ref={workerRef} id="worker-name" value={workerName} onChange={(event) => setWorkerName(event.target.value)} required aria-invalid={invalidResource === "worker-name"} aria-describedby={resourceError ? "resource-error" : invalidResource && error ? "install-error" : undefined} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bucket-name">{t("setup.bucketName")}</Label>
                    <Input ref={bucketRef} id="bucket-name" value={bucketName} onChange={(event) => setBucketName(event.target.value)} required aria-invalid={invalidResource === "bucket-name"} aria-describedby={resourceError ? "resource-error" : invalidResource && error ? "install-error" : undefined} />
                  </div>
                </div>
                {resourceError ? <p id="resource-error" role="alert" className="mt-2 text-sm text-destructive">{t(resourceError)}</p> : null}
              </details>

              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                <div className="text-xs text-muted-foreground">
                  <p className="flex items-center gap-1"><Check className="size-3" aria-hidden />{t("shell.accountConnected")}</p>
                  <p className="mt-1">{t("setup.resourcesCost")}</p>
                </div>
              <div className="flex flex-wrap justify-end gap-2">
                <GuardedBack dirty={dirty} onBack={onBack} label={t("setup.previous")} />
                <Button
                  type="submit"
                  disabled={
                    checking ||
                    running ||
                    !channel
                  }
                >
                  {checking || running ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {running ? t("setup.deploying") : checking ? t("setup.checking") : t("setup.checkAndDeploy")}
                </Button>
              </div>
              </div>
            </form>

            {checking || running ? (
              <div className="mt-5" aria-live="polite">
                <Progress value={progress} aria-label={t("setup.deployProgress")} />
                <p className="mt-2 text-xs text-muted-foreground">
                  {progress < 30 ? t("setup.creatingResources") : t("setup.publishing")}
                </p>
              </div>
            ) : null}
            <div id="install-error">
              <ErrorAlert
                error={error}
                onRetry={installRetryBlocked ? undefined : checkAndInstall}
                retryLabel={t("setup.retryInstall")}
              />
            </div>
        </section>
      ) : (
        <ResultPanel
          title={published ? t("setup.deployed") : t("setup.deployIncomplete")}
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
                {t("setup.setModels")} <ArrowRight aria-hidden />
              </Button>
              <Button type="button" variant="outline" onClick={onReady}>
                {t("setup.enterHome")}
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
  const t = useT();
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
      let models = {};
      if (preview.legacy) {
        const butlerModel = parseModelKey(butler);
        const taskModel = parseModelKey(task);
        if (!butlerModel || !taskModel) {
          throw new Error("MODELS_REQUIRED: ");
        }
        models = { butlerModel, taskModel };
      }
      const ownerVisible =
        preview.legacy || preview.requiredInputs?.includes("telegramUserIds") === true;
      const confirmed = await client.confirmImport({
        baseFingerprint: "",
        ...(ownerVisible ? { telegramUserIds: parseUserIDs(ownerIDs) } : {}),
        ...models,
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
      <PageHeader title={t("setup.importTitle")} />
      <p className="mt-2 text-sm text-muted-foreground">
        {t("setup.importSubtitle")}
      </p>

      <ErrorAlert
        error={catalogError}
        onRetry={reloadCatalog}
        retryLabel={t("setup.reloadCatalog")}
      />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{t("setup.connectable")}</CardTitle>
              </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadWorkers()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {t("shell.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workers.length === 0 && !loading ? (
            <p className="text-sm text-muted-foreground">{t("setup.noWorkers")}</p>
          ) : null}
          <ul className="space-y-2">
            {workers.map((worker) => (
              <li key={worker.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div>
                  <div className="font-medium" data-i18n-ignore>{worker.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {worker.modifiedOn ? <>{t("setup.modifiedAt")}<span data-i18n-ignore>{worker.modifiedOn}</span></> : t("setup.modifiedUnknown")}
                    {worker.migrationTag ? <>{t("setup.migration")}<span data-i18n-ignore>{worker.migrationTag}</span></> : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={selected === worker.name ? "secondary" : "outline"}
                  disabled={running}
                  onClick={() => void inspect(worker.name)}
                >
                  {selected === worker.name ? t("setup.selected") : t("setup.inspect")}
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
              <span data-i18n-ignore>{preview.workerName}</span>
              {preview.legacy ? <Badge variant="outline">{t("setup.needsUpgrade")}</Badge> : <Badge variant="secondary">{t("setup.configReadable")}</Badge>}
            </CardTitle>
            <CardDescription>
              {t("setup.legacyDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <details className="min-w-0 break-words"><summary className="cursor-pointer text-sm text-muted-foreground">{t("common.details")}</summary>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Info label={t("setup.currentRelease")} value={preview.releaseVersion ? <span data-i18n-ignore>{preview.releaseVersion}</span> : t("common.unknown")} />
              <Info label="DESKWAND_CONFIG" value={preview.configPresent ? t("setup.present") : t("setup.absent")} />
              <Info label="owner" value={preview.ownerConfigured ? t("setup.configured") : t("setup.needsRefill")} />
              <Info label={t("setup.roleModels")} value={preview.modelsConfigured ? t("setup.configured") : t("setup.needsRefill")} />
              <Info label="ACTIVE_CHANNEL" value={preview.activeChannel ? <span data-i18n-ignore>{preview.activeChannel}</span> : t("common.notSet")} />
              <Info label={t("setup.existingSecrets")} value={preview.secretNames.length ? <span data-i18n-ignore>{preview.secretNames.join(t("setup.listSeparator"))}</span> : t("setup.none")} />
            </dl>
            </details>

            {preview.preserveSecretNames.length > 0 ? (
              <Alert>
                <ShieldCheck />
                <AlertTitle>{t("setup.preserveTitle")}</AlertTitle>
                <AlertDescription>
                  <span data-i18n-ignore>{preview.preserveSecretNames.join(t("setup.listSeparator"))}</span> {t("setup.preserveKeeps")}
                </AlertDescription>
              </Alert>
            ) : null}

            {preview.plaintextSecrets?.length ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <h3 className="text-sm font-medium">{t("setup.plaintextTitle")}</h3>
                {preview.plaintextSecrets.map((migration) => (
                  <div key={migration.secretName} className="space-y-2">
                    <p className="text-xs text-muted-foreground" data-i18n-ignore>
                      {migration.field} → {migration.reference}
                    </p>
                    <Label htmlFor={`migrate-${migration.secretName}`}><span data-i18n-ignore>{migration.secretName}</span> {t("setup.secretValueOf")}</Label>
                    <Input
                      id={`migrate-${migration.secretName}`}
                      type="password"
                      autoComplete="new-password"
                      value={secrets[migration.secretName] ?? ""}
                      onChange={(event) =>
                        setSecrets((current) => ({ ...current, [migration.secretName]: event.target.value }))
                      }
                      placeholder={t("setup.secretPlaceholder")}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {preview.requiredInputs?.includes("telegramUserIds") || preview.legacy ? (
              <div className="space-y-2">
                <Label htmlFor="import-owners">{t("setup.ownersLabel")}</Label>
                <Input
                  id="import-owners"
                  value={ownerIDs}
                  onChange={(event) => setOwnerIDs(event.target.value)}
                  placeholder={t("setup.ownersPlaceholder")}
                  inputMode="numeric"
                />
              </div>
            ) : null}

            {preview.legacy ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="import-butler">{t("models.butlerModel")}</Label>
                  <ModelSelect id="import-butler" label={t("models.butlerModel")} value={butler} onChange={setButler} options={modelOptions} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="import-task">{t("models.taskModel")}</Label>
                  <ModelSelect id="import-task" label={t("models.taskModel")} value={task} onChange={setTask} options={modelOptions} />
                </div>
              </div>
            ) : null}

            {preview.warnings?.length ? (
              <Alert>
                <AlertTitle>{t("setup.notes")}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {preview.warnings.map((warning) => (
                      <li key={warning} data-i18n-ignore>{warning}</li>
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
                  {running ? t("setup.takingOver") : t("setup.confirmTakeover")}
                </Button>
              </div>
            ) : null}
            {!result ? (
              <>
                <ErrorAlert
                  error={submitError}
                  onRetry={canRetryImport ? confirm : undefined}
                  retryLabel={t("setup.retryConfirm")}
                />
                {submitError && !canRetryImport ? (
                  <p className="text-xs text-muted-foreground">
                    {t("setup.refillSecrets")}
                  </p>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <ResultPanel
          title={published ? t("setup.connected") : t("setup.takeoverIncomplete")}
          result={result}
          running={running}
          error={submitError}
          onResume={result.state === "unknown" || result.state === "needs_input" ? resume : undefined}
        >
          {published ? (
            <Button type="button" className="mt-4" onClick={onReady}>
              {t("setup.enterHome")} <ArrowRight aria-hidden />
            </Button>
          ) : null}
        </ResultPanel>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
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
  const t = useT();
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {title}
          <StateBadge state={result.state} />
        </CardTitle>
        <CardDescription>
          {result.state === "published"
            ? t("setup.publishedHint")
            : t("shell.pendingDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {result.state === "published" ? <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary>
          <p className="mt-2 break-all text-xs text-muted-foreground">{t("setup.operationId")}<span data-i18n-ignore>{result.operationId}</span></p>
          <StepList steps={result.steps ?? []} />
        </details> : <>
          {result.operationId ? <p className="break-all text-xs text-muted-foreground">{t("setup.operationId")}<span data-i18n-ignore>{result.operationId}</span></p> : null}
          <StepList steps={result.steps ?? []} />
        </>}
        {result.warnings?.length ? (
          <Alert className="my-3">
            <AlertTitle>{t("setup.notice")}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {result.warnings.map((warning) => (
                  <li key={warning} data-i18n-ignore>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {onResume ? (
          <Button type="button" className="mt-2" data-testid="result-resume" onClick={onResume} disabled={running}>
            {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            {t("common.continue")}
          </Button>
        ) : null}
        <ErrorAlert error={error} onRetry={onResume} retryLabel={t("common.retry")} />
        {children}
      </CardContent>
    </Card>
  );
}

