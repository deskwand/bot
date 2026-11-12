import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, QrCode, RefreshCw, Send, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { pageSubtitle, useApp } from "@/components/app-context";
import {
  ErrorAlert,
  type LocalizedStep,
  StateBadge,
  StatusBadge,
  StatusRow,
  StepList,
} from "@/components/feedback";
import { getT, useT, type MessageKey } from "@/i18n";
import { SyncStatus } from "@/components/sync-status";
import { useDirty } from "@/components/use-dirty";
import { useConfigQuery, useInvalidate, useStatusQuery } from "@/services/queries";
import type {
  EntryResultDTO,
  LoginStatusDTO,
  ResultDTO,
} from "@/services/types";

type LoginState =
  | "idle"
  | "wait"
  | "scaned"
  | "confirmed"
  | "published"
  | "publish_failed"
  | "expired"
  | "cancelled"
  | "error";

interface PublishFailure {
  code: string;
  message: string;
  operationId: string;
}

type LoginMessage =
  | { key: MessageKey; params?: Record<string, string | number> }
  | { text: string };

export function Entries() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const statusQuery = useStatusQuery();
  const invalidate = useInvalidate();
  const config = configQuery.data;
  const status = statusQuery.data ?? [];
  const loading = !configQuery.data && configQuery.isFetching;
  const loadError = configQuery.data
    ? null
    : (configQuery.error ?? statusQuery.error);

  const [channel, setChannel] = useState("");
  const channelTouched = useRef(false);
  const refresh = useCallback(() => {
    void configQuery.refetch();
    void statusQuery.refetch();
  }, [configQuery, statusQuery]);
  const [channelRunning, setChannelRunning] = useState(false);
  const [channelError, setChannelError] = useState<unknown>(null);
  const [channelResult, setChannelResult] = useState<EntryResultDTO | null>(null);
  const [channelResumeRunning, setChannelResumeRunning] = useState(false);
  const [channelResumeError, setChannelResumeError] = useState<unknown>(null);

  const [editingTelegram, setEditingTelegram] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramRunning, setTelegramRunning] = useState(false);
  const [telegramError, setTelegramError] = useState<unknown>(null);
  const [telegramResult, setTelegramResult] = useState<ResultDTO | null>(null);

  const [qrOpen, setQrOpen] = useState(false);
  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [qrContent, setQrContent] = useState("");
  const [loginMessage, setLoginMessage] = useState<LoginMessage | null>(null);
  const [loginError, setLoginError] = useState<unknown>(null);
  const [publishFailure, setPublishFailure] = useState<PublishFailure | null>(null);
  const [loginResumeRunning, setLoginResumeRunning] = useState(false);
  const opIDRef = useRef("");
  const startingRef = useRef(false);
  const confirmedRef = useRef(false);
  const [wechatPublished, setWechatPublished] = useState(false);

  const dirty = channel !== (config?.activeChannel ?? "") || telegramToken.length > 0;
  useDirty(dirty);

  useEffect(() => {
    if (!configQuery.data || channelTouched.current) return;
    setChannel(configQuery.data.activeChannel ?? "");
  }, [configQuery.data]);

  useEffect(() => {
    const unsubscribe = client.subscribeLoginStatus((update: LoginStatusDTO) => {
      // A synchronous first event can arrive before StartWeChatLogin resolves.
      if (startingRef.current && !opIDRef.current) {
        opIDRef.current = update.operationId;
      }
      if (!opIDRef.current) return;

      const isLoginEvent = update.operationId === opIDRef.current;
      const isFollowUp =
        confirmedRef.current &&
        (update.state === "published" || update.state === "publish_failed");
      // The final events carry the publish operation ID, not the login ID. Only
      // one login can be active, so after confirmation the follow-up belongs to it.
      if (!isLoginEvent && !isFollowUp) return;

      // Login status messages come from Go; keep them verbatim.
      setLoginMessage(update.message ? { text: update.message } : null);
      if (update.qrContent) setQrContent(update.qrContent);
      switch (update.state) {
        case "wait":
        case "scaned":
          setLoginState(update.state);
          break;
        case "confirmed":
          confirmedRef.current = true;
          setLoginError(null);
          setLoginState("confirmed");
          break;
        case "published":
          confirmedRef.current = false;
          setPublishFailure(null);
          setLoginError(null);
          setWechatPublished(true);
          channelTouched.current = false;
          setLoginState("published");
          setLoginMessage({ key: "entries.publishedWaiting" });
          invalidate.configAndStatus();
          break;
        case "publish_failed":
          confirmedRef.current = false;
          setLoginError(null);
          setLoginState("publish_failed");
          setPublishFailure({
            code: update.code ?? "",
            message: update.message ?? "",
            operationId: update.operationId,
          });
          break;
        case "expired":
          confirmedRef.current = false;
          setLoginState("expired");
          break;
        case "cancelled":
          confirmedRef.current = false;
          setLoginState("cancelled");
          break;
        case "error": {
          confirmedRef.current = false;
          const code = update.code ?? "";
          setLoginState("error");
          setLoginError(
            code
              ? new Error(`${code}: `)
              : new Error(update.message || getT()("entries.loginFailedFallback")),
          );
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [client, invalidate]);

  useEffect(
    () => () => {
      if (opIDRef.current) {
        void client.cancelWeChatLogin(opIDRef.current).catch(() => undefined);
      }
    },
    [client],
  );

  const closeLogin = () => {
    if (opIDRef.current && !wechatPublished) {
      void client.cancelWeChatLogin(opIDRef.current).catch(() => undefined);
    }
    opIDRef.current = "";
    startingRef.current = false;
    confirmedRef.current = false;
    setQrOpen(false);
    setLoginState("idle");
    setQrContent("");
    setLoginMessage(null);
    setPublishFailure(null);
    setLoginError(null);
  };

  const startLogin = async () => {
    startingRef.current = true;
    confirmedRef.current = false;
    opIDRef.current = "";
    setLoginState("wait");
    setQrContent("");
    setLoginMessage({ key: "entries.creatingQr" });
    setLoginError(null);
    setPublishFailure(null);
    setWechatPublished(false);
    setQrOpen(true);
    try {
      const opID = await client.startWeChatLogin();
      opIDRef.current = opID;
    } catch (cause) {
      setLoginError(cause);
      setLoginState("error");
    } finally {
      startingRef.current = false;
    }
  };

  const resumePublish = async () => {
    if (!publishFailure?.operationId) return;
    setLoginResumeRunning(true);
    setLoginError(null);
    try {
      const result = await client.resumeOperation(publishFailure.operationId);
      if (result.state === "published") {
        channelTouched.current = false;
        setWechatPublished(true);
        setLoginState("published");
        setPublishFailure(null);
        setLoginMessage({ key: "entries.publishedWaiting" });
        invalidate.configAndStatus();
      } else {
        setLoginState("publish_failed");
        setLoginMessage({
          key: "entries.resumeState",
          params: { state: result.state },
        });
        setPublishFailure((current) =>
          current ? { ...current, operationId: result.operationId || current.operationId } : current,
        );
      }
    } catch (cause) {
      setLoginError(cause);
    } finally {
      setLoginResumeRunning(false);
    }
  };

  const publishChannel = async () => {
    if (!channel) return;
    setChannelRunning(true);
    setChannelError(null);
    setChannelResult(null);
    try {
      const result = await client.selectEntry(channel);
      setChannelResult(result);
      channelTouched.current = false;
      invalidate.configAndStatus();
    } catch (cause) {
      setChannelError(cause);
    } finally {
      setChannelRunning(false);
    }
  };

  const resumeChannel = async () => {
    if (!channelResult?.operationId) return;
    setChannelResumeRunning(true);
    setChannelResumeError(null);
    try {
      const resumed = await client.resumeOperation(channelResult.operationId);
      setChannelResult((current) =>
        current
          ? {
              ...current,
              operationId: resumed.operationId || current.operationId,
              state: resumed.state,
            }
          : current,
      );
      invalidate.configAndStatus();
    } catch (cause) {
      setChannelResumeError(cause);
    } finally {
      setChannelResumeRunning(false);
    }
  };

  const connectTelegram = async () => {
    setTelegramRunning(true);
    setTelegramError(null);
    setTelegramResult(null);
    try {
      const result = await client.connectTelegram(telegramToken);
      setTelegramResult(result);
      setTelegramToken("");
      channelTouched.current = false;
      invalidate.configAndStatus();
    } catch (cause) {
      setTelegramToken("");
      setTelegramError(cause);
    } finally {
      setTelegramRunning(false);
    }
  };

  const resumeTelegram = async () => {
    if (!telegramResult?.operationId) return;
    setTelegramRunning(true);
    try {
      setTelegramResult(await client.resumeOperation(telegramResult.operationId));
      invalidate.configAndStatus();
    } catch (cause) {
      setTelegramError(cause);
    } finally {
      setTelegramRunning(false);
    }
  };

  const wechatStatus = status.find((item) => item.kind === "wechat");
  const telegramStatus = status.find((item) => item.kind === "telegram");
  const wechatConfigured =
    config?.secrets.find((secret) => secret.name === "WECHAT_CREDENTIALS")?.configured ?? false;
  const telegramConfigured =
    config?.secrets.find((secret) => secret.name === "TELEGRAM_BOT_TOKEN")?.configured ?? false;

  if (loading) {
    return (
      <div className="flex min-h-[40svh] items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
        {t("entries.loading")}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("shell.pages.entries")} subtitle={pageSubtitle("entries")} actions={<>
        <SyncStatus
          isFetching={configQuery.isFetching || statusQuery.isFetching}
          isPlaceholder={configQuery.isPlaceholder || statusQuery.isPlaceholder}
          savedAt={configQuery.savedAt ?? statusQuery.savedAt}
          error={configQuery.data ? (configQuery.error ?? statusQuery.error) : null}
          onRetry={refresh}
        />
</>} />

      <ErrorAlert error={loadError} onRetry={refresh} />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="size-4" aria-hidden />
                {t("common.wechat")}
              </CardTitle>
              {config?.activeChannel === "wechat" ? <Badge variant="outline" data-testid="current-entry-wechat">{t("entries.currentEntry")}</Badge> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {wechatStatus ? <StatusBadge item={wechatStatus} /> : <Badge variant="outline">{t("entries.statusUnknown")}</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{wechatConfigured ? t("entries.wechatConfigured") : t("entries.wechatScanPrompt")}</p>
          {wechatStatus ? <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary><StatusRow item={wechatStatus} /></details> : null}
          {wechatPublished ? (
            <Alert className="mt-3 border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
              <AlertTitle>{t("entries.connectedWaitingTitle")}</AlertTitle>
              <AlertDescription>
                {t("entries.connectedWaitingDescription")}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void startLogin()} disabled={qrOpen}>
              <QrCode aria-hidden />
              {wechatConfigured ? t("entries.rescan") : t("entries.scanToConnect")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Telegram</CardTitle>
              {config?.activeChannel === "telegram" ? <Badge variant="outline">{t("entries.currentEntry")}</Badge> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {telegramStatus ? <StatusBadge item={telegramStatus} /> : <Badge variant="outline">{t("entries.statusUnknown")}</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{telegramConfigured ? t("entries.telegramConfigured") : t("entries.telegramTokenPrompt")}</p>
            {telegramConfigured ? <Button type="button" size="sm" variant="outline" onClick={() => setEditingTelegram((value) => !value)}>{editingTelegram ? t("entries.collapse") : t("entries.replaceToken")}</Button> : null}
          </div>
          {telegramStatus ? <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary><StatusRow item={telegramStatus} /></details> : null}
          {!telegramConfigured || editingTelegram ? <div className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="telegram-token">Bot Token</Label>
              <Input
                id="telegram-token"
                type="password"
                value={telegramToken}
                onChange={(event) => setTelegramToken(event.target.value)}
                placeholder={t("entries.tokenPlaceholder")}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("entries.saveKeepsChannel")}
            </span>
            <Button
              type="button"
              onClick={() => void connectTelegram()}
              disabled={telegramRunning || telegramToken.trim().length === 0}
            >
              {telegramRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {telegramRunning ? t("entries.connecting") : t("entries.saveAndConnect")}
            </Button>
          </div>
          </div> : null}
          {telegramResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("entries.telegramResult")}</span>
                <StateBadge state={telegramResult.state} />
              </div>
              <StepList steps={telegramResult.steps ?? []} />
              {telegramResult.state === "unknown" ? (
                <Button type="button" size="sm" variant="outline" data-testid="telegram-resume" onClick={() => void resumeTelegram()} disabled={telegramRunning}>
                  {t("common.continue")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={telegramError} onRetry={() => void connectTelegram()} retryLabel={t("entries.reconnect")} />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t("common.currentChannel")}</CardTitle>
          <CardDescription>
            {t("entries.currentChannelDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t("entries.currentPrefix")}<span data-testid="current-entry">{config?.activeChannel === "wechat" ? t("common.wechat") : config?.activeChannel === "telegram" ? t("common.telegram") : t("common.notSet")}</span></p>
          <RadioGroup
            value={channel}
            onValueChange={(next) => {
              channelTouched.current = true;
              setChannel(next);
            }}
            disabled={configQuery.isPlaceholder}
            aria-label={t("common.currentChannel")}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border p-4">
              <span className="flex items-center gap-3">
                <RadioGroupItem value="telegram" id="current-telegram" />
                <span>
                  <span className="block font-medium">Telegram</span>
                </span>
              </span>
              {telegramConfigured ? <Badge variant="secondary">{t("entries.configured")}</Badge> : <Badge variant="outline">{t("entries.notConfigured")}</Badge>}
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border p-4">
              <span className="flex items-center gap-3">
                <RadioGroupItem value="wechat" id="current-wechat" />
                <span>
                  <span className="block font-medium">{t("common.wechat")}</span>
                </span>
              </span>
              {wechatConfigured ? <Badge variant="secondary">{t("entries.configured")}</Badge> : <Badge variant="outline">{t("entries.notConfigured")}</Badge>}
            </label>
          </RadioGroup>
          {channel === "wechat" && !wechatConfigured ? (
            <Alert className="mt-3">
              <AlertTitle>{t("entries.notReadyTitle")}</AlertTitle>
              <AlertDescription>{t("entries.wechatNotReadyDescription")}</AlertDescription>
            </Alert>
          ) : null}
          {channel === "telegram" && !telegramConfigured ? (
            <Alert className="mt-3">
              <AlertTitle>{t("entries.notReadyTitle")}</AlertTitle>
              <AlertDescription>{t("entries.telegramNotReadyDescription")}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              onClick={() => void publishChannel()}
              disabled={channelRunning || !channel || channel === config?.activeChannel}
            >
              {channelRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {channelRunning ? t("entries.publishing") : t("entries.saveAndPublish")}
            </Button>
          </div>
          {channelResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("entries.publishResult")}</span>
                <StateBadge state={channelResult.state ?? ""} />
                <Badge variant={channelResult.configured ? "secondary" : "outline"}>
                  {channelResult.configured ? t("entries.configured") : t("entries.notYetConfigured")}
                </Badge>
              </div>
              {channelResult.state === "unchanged" ? (
                <p className="mt-2 text-sm text-muted-foreground">{t("entries.unchanged")}</p>
              ) : null}
              {channelResult.warning ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" data-i18n-ignore>{channelResult.warning}</p>
              ) : null}
              {(channelResult.state === "unknown" || channelResult.state === "partial") &&
              channelResult.operationId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  data-testid="channel-resume"
                  onClick={() => void resumeChannel()}
                  disabled={channelResumeRunning}
                >
                  {channelResumeRunning ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {t("common.continue")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={channelError} onRetry={() => void publishChannel()} retryLabel={t("entries.republish")} />
          <ErrorAlert error={channelResumeError} onRetry={() => void resumeChannel()} retryLabel={t("common.continue")} />
        </CardContent>
      </Card>

      <Dialog
        open={qrOpen}
        onOpenChange={(open) => {
          if (!open) closeLogin();
          else setQrOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{loginTitle(loginState)}</DialogTitle>
            <DialogDescription>{loginDescription(loginState)}</DialogDescription>
          </DialogHeader>

          {qrContent &&
          !["expired", "cancelled", "error", "published", "publish_failed"].includes(loginState) ? (
            <div
              className="mx-auto rounded-lg border border-border bg-white p-3"
              data-testid="wechat-qr"
            >
              <span role="img" aria-label={t("entries.qrAria")}>
                <span data-i18n-ignore>
                  <QRCodeSVG value={qrContent} size={188} marginSize={2} aria-hidden />
                </span>
              </span>
            </div>
          ) : null}
          {!qrContent && ["wait", "idle"].includes(loginState) ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              {t("entries.creatingQr")}
            </div>
          ) : null}
          {loginMessage ? (
            <p className="text-sm text-muted-foreground">
              {"text" in loginMessage ? (
                <span data-i18n-ignore>{loginMessage.text}</span>
              ) : (
                t(loginMessage.key, loginMessage.params)
              )}
            </p>
          ) : null}

          <StepList steps={loginSteps(loginState)} compact />

          {loginState === "published" ? (
            <Alert>
              <Send />
              <AlertTitle>{t("entries.sendRealMessageTitle")}</AlertTitle>
              <AlertDescription>
                {t("entries.sendRealMessageDescription")}
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {t("entries.qrRefreshNote")}
          </p>
          {publishFailure ? (
            <ErrorAlert
              error={
                publishFailure.code
                  ? new Error(`${publishFailure.code}: `)
                  : new Error(
                      publishFailure.message || t("entries.publishFailedFallback"),
                    )
              }
              onRetry={resumePublish}
              retryLabel={t("common.continue")}
            />
          ) : null}
          {loginResumeRunning ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              {t("entries.verifyingRemote")}
            </p>
          ) : null}
          <ErrorAlert error={loginError} onRetry={() => void startLogin()} retryLabel={t("entries.rescan")} />

          <DialogFooter>
            {loginState === "expired" || loginState === "cancelled" || loginState === "error" ? (
              <Button type="button" onClick={() => void startLogin()}>
                {t("entries.rescan")}
              </Button>
            ) : null}
            {loginState === "published" ? (
              <Button type="button" variant="outline" onClick={refresh}>
                <RefreshCw aria-hidden />
                {t("entries.checkStatus")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={closeLogin}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function loginTitle(state: LoginState): string {
  const t = getT();
  switch (state) {
    case "scaned":
      return t("entries.loginTitleScaned");
    case "confirmed":
      return t("entries.loginTitleConfirmed");
    case "published":
      return t("entries.loginTitlePublished");
    case "publish_failed":
      return t("entries.loginTitlePublishFailed");
    case "expired":
      return t("entries.loginTitleExpired");
    case "cancelled":
      return t("entries.loginTitleCancelled");
    case "error":
      return t("entries.loginTitleError");
    default:
      return t("entries.loginTitleDefault");
  }
}

function loginDescription(state: LoginState): string {
  const t = getT();
  switch (state) {
    case "scaned":
      return t("entries.loginDescriptionScaned");
    case "confirmed":
      return t("entries.loginDescriptionConfirmed");
    case "published":
      return t("entries.loginDescriptionPublished");
    case "publish_failed":
      return t("entries.loginDescriptionPublishFailed");
    case "expired":
      return t("entries.loginDescriptionExpired");
    case "cancelled":
      return t("entries.loginDescriptionCancelled");
    case "error":
      return t("entries.loginDescriptionError");
    default:
      return t("entries.loginDescriptionDefault");
  }
}

function loginSteps(state: LoginState): LocalizedStep[] {
  const doneThrough = (() => {
    switch (state) {
      case "scaned":
        return 2;
      case "confirmed":
      case "publish_failed":
        return 3;
      case "published":
        return 4;
      default:
        return 0;
    }
  })();
  const t = getT();
  const labels = [
    t("entries.stepShowQr"),
    t("entries.stepScan"),
    t("entries.stepConfirm"),
    t("entries.stepPublish"),
    t("entries.stepWaitCloud"),
    t("entries.stepVerifyMessage"),
  ];
  return labels.map((label, index) => ({
    id: `wechat-step-${index}`,
    state:
      state === "publish_failed" && index === 3
        ? "failed"
        : index < doneThrough
          ? "completed"
          : "planned",
    message: label,
  }));
}
