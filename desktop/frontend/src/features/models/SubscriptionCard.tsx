import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/feedback";
import { useApp } from "@/components/app-context";
import { useT } from "@/i18n";
import { toClientError } from "@/services/errors";
import { useInvalidate, useModelAuthStatusQuery } from "@/services/queries";
import type { ModelLoginDTO } from "@/services/types";

/** Providers whose credential is a subscription login, with the roles using them. */
export type SubscriptionProviderRow = {
  id: string;
  label: string;
  roles: string[];
};

type LoginState = "starting" | "waiting" | "done" | "error";

/** The slow-down response asks for a longer interval; keep it bounded. */
const MAX_POLL_MS = 30_000;
const SLOW_DOWN_MS = 5_000;

export function SubscriptionProviders({
  providers,
  localeKey,
}: {
  providers: SubscriptionProviderRow[];
  /** Remounts the cards when the locale changes, like the key rows do. */
  localeKey?: string;
}) {
  if (providers.length === 0) return null;
  return (
    <section
      className="mt-5 border-t border-border pt-4"
      aria-labelledby="provider-subscriptions-title"
    >
      <h3 id="provider-subscriptions-title" className="text-sm font-medium">
        <SubscriptionHeading />
      </h3>
      <SubscriptionDescription />
      <div className="mt-3 space-y-3">
        {providers.map((provider) => (
          <SubscriptionCard key={`${provider.id}-${localeKey ?? ""}`} provider={provider} />
        ))}
      </div>
    </section>
  );
}

function SubscriptionHeading() {
  const t = useT();
  return <>{t("models.subscriptionTitle")}</>;
}

function SubscriptionDescription() {
  const t = useT();
  return (
    <p className="mt-1 text-xs text-muted-foreground">{t("models.subscriptionDescription")}</p>
  );
}

function SubscriptionCard({ provider }: { provider: SubscriptionProviderRow }) {
  const t = useT();
  const { client } = useApp();
  const invalidate = useInvalidate();
  const statusQuery = useModelAuthStatusQuery();
  const connected =
    statusQuery.data?.find((entry) => entry.provider === provider.id)?.connected ?? false;
  const statusUnavailable =
    statusQuery.error !== null &&
    toClientError(statusQuery.error).code === "MODEL_AUTH_ADMIN_UNAVAILABLE";

  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoginState>("starting");
  const [login, setLogin] = useState<ModelLoginDTO | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The poll chain is a recursive timeout; one ref cancels it on close, and
  // one ref carries the interval so slow_down really widens it.
  const timer = useRef<number | undefined>(undefined);
  const interval = useRef(0);
  // Bumped by close() so an in-flight start cannot reopen the dialog.
  const startSeq = useRef(0);

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, []);

  const startLogin = async (method: "browser" | "device" = "browser") => {
    const seq = (startSeq.current += 1);
    setOpen(true);
    setState("starting");
    setLogin(null);
    setError(null);
    setCopied(false);
    try {
      const started =
        method === "device"
          ? await client.startModelDeviceLogin()
          : await client.startModelLogin();
      if (startSeq.current !== seq) return;
      setLogin(started);
      setState("waiting");
    } catch (cause) {
      if (startSeq.current !== seq) return;
      setError(cause);
      setState("error");
    }
  };

  // One poll chain per successful start: each tick schedules the next, and a
  // slow_down response widens the gap before doing so.
  useEffect(() => {
    if (!open || state !== "waiting" || login === null) return;
    let cancelled = false;
    interval.current = Math.max(1, login.intervalSeconds) * 1000;
    const schedule = (delayMs: number) => {
      timer.current = window.setTimeout(poll, delayMs);
    };
    const poll = async () => {
      try {
        const status = await client.pollModelLogin();
        if (cancelled) return;
        if (status === "done") {
          setState("done");
          invalidate.modelAuth();
          return;
        }
        if (status === "slow_down") {
          interval.current = Math.min(interval.current + SLOW_DOWN_MS, MAX_POLL_MS);
        }
        schedule(interval.current);
      } catch (cause) {
        if (cancelled) return;
        setError(cause);
        setState("error");
      }
    };
    schedule(interval.current);
    return () => {
      cancelled = true;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [client, invalidate, login, open, state]);

  const close = () => {
    startSeq.current += 1;
    // Best effort: drops a pending login and frees the loopback port.
    void client.cancelModelLogin().catch(() => undefined);
    setOpen(false);
    setLogin(null);
    setState("starting");
    setError(null);
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await client.disconnectModel();
      invalidate.modelAuth();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (login === null) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      setCopied(true);
    } catch {
      // A clipboard the platform refuses is not worth an error.
    }
  };

  return (
    <div
      className="rounded-md border border-border p-3"
      data-testid={`model-subscription-row-${provider.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          <span data-i18n-ignore>{provider.label}</span>
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t("models.roleUsage", {
              roles: provider.roles
                .map((role) =>
                  role === "roleButler" ? t("models.roleButler") : t("models.roleTask"),
                )
                .join(t("models.listSeparator")),
            })}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Badge variant={connected ? "secondary" : "outline"}>
            {connected ? t("models.subscriptionSignedIn") : t("models.subscriptionSignedOut")}
          </Badge>
          {connected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void disconnect()}
              disabled={busy}
              data-testid="model-subscription-disconnect"
            >
              <LogOut aria-hidden />
              {t("models.subscriptionDisconnect")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void startLogin()}
              disabled={statusUnavailable}
              data-testid="model-subscription-login"
            >
              <LogIn aria-hidden />
              {t("models.subscriptionLogin")}
            </Button>
          )}
        </div>
      </div>
      {statusQuery.error ? (
        <ErrorAlert
          error={statusQuery.error}
          onRetry={() => void statusQuery.refetch()}
          retryLabel={t("models.subscriptionRetry")}
        />
      ) : null}
      {error && !open ? <ErrorAlert error={error} /> : null}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("models.subscriptionDialog", { provider: provider.label })}
            </DialogTitle>
            <DialogDescription>
              {login?.method === "device"
                ? t("models.subscriptionInstructionsDevice")
                : t("models.subscriptionInstructionsBrowser")}
            </DialogDescription>
          </DialogHeader>

          {state === "starting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              {t("models.subscriptionWaiting")}
            </p>
          ) : null}

          {login !== null && login.method === "browser" && state === "waiting" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t("models.subscriptionBrowserHint")}
              </p>
              <p className="break-all text-xs text-muted-foreground" data-i18n-ignore>
                {login.verificationUrl}
              </p>
            </div>
          ) : null}

          {login !== null && login.method === "device" && state !== "done" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("models.subscriptionCodeLabel")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="rounded-md border border-border px-3 py-2 font-mono text-xl tracking-widest"
                  data-testid="model-subscription-code"
                >
                  {login.userCode}
                </code>
                <Button type="button" variant="outline" size="sm" onClick={() => void copyCode()}>
                  <Copy aria-hidden />
                  {copied ? t("models.subscriptionCopied") : t("models.subscriptionCopy")}
                </Button>
              </div>
              <p className="break-all text-xs text-muted-foreground" data-i18n-ignore>
                {login.verificationUrl}
              </p>
              <p className="text-xs text-muted-foreground">{t("models.subscriptionCodeExpiry")}</p>
            </div>
          ) : null}

          {state === "waiting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              {t("models.subscriptionWaiting")}
            </p>
          ) : null}

          {state === "done" ? (
            <Alert data-testid="model-subscription-done">
              <AlertDescription>{t("models.subscriptionDone")}</AlertDescription>
            </Alert>
          ) : null}

          {state === "error" ? (
            <div className="space-y-2">
              {toClientError(error).code === "MODEL_AUTH_ADMIN_UNAVAILABLE" ? (
                <p className="text-sm">{t("models.subscriptionUnavailable")}</p>
              ) : null}
              <ErrorAlert error={error} />
            </div>
          ) : null}

          <DialogFooter>
            {login?.method === "browser" || state === "error" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void startLogin("device")}
                data-testid="model-subscription-use-device"
              >
                {t("models.subscriptionUseDevice")}
              </Button>
            ) : null}
            {state === "error" ? (
              <Button type="button" onClick={() => void startLogin("browser")}>
                {t("models.subscriptionRetry")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={close}
              data-testid="model-subscription-close"
            >
              {t("models.subscriptionClose")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
