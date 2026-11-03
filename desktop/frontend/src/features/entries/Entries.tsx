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
import { useApp } from "@/components/app-context";
import { ErrorAlert, StateBadge, StatusRow, StepList } from "@/components/feedback";
import { useDirty } from "@/components/use-dirty";
import { describeCode } from "@/services/errors";
import type {
  ConfigDTO,
  EntryResultDTO,
  LoginStatusDTO,
  ResultDTO,
  StatusItemDTO,
  StepDTO,
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

export function Entries() {
  const { client } = useApp();
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [status, setStatus] = useState<StatusItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [channel, setChannel] = useState("");
  const [channelRunning, setChannelRunning] = useState(false);
  const [channelError, setChannelError] = useState<unknown>(null);
  const [channelResult, setChannelResult] = useState<EntryResultDTO | null>(null);
  const [channelResumeRunning, setChannelResumeRunning] = useState(false);
  const [channelResumeError, setChannelResumeError] = useState<unknown>(null);

  const [telegramToken, setTelegramToken] = useState("");
  const [rotate, setRotate] = useState(false);
  const [telegramRunning, setTelegramRunning] = useState(false);
  const [telegramError, setTelegramError] = useState<unknown>(null);
  const [telegramResult, setTelegramResult] = useState<ResultDTO | null>(null);

  const [qrOpen, setQrOpen] = useState(false);
  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [qrContent, setQrContent] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [loginError, setLoginError] = useState<unknown>(null);
  const [publishFailure, setPublishFailure] = useState<PublishFailure | null>(null);
  const [loginResumeRunning, setLoginResumeRunning] = useState(false);
  const opIDRef = useRef("");
  const startingRef = useRef(false);
  const confirmedRef = useRef(false);
  const [wechatPublished, setWechatPublished] = useState(false);

  const dirty = channel !== (config?.activeChannel ?? "") || telegramToken.length > 0 || rotate;
  useDirty(dirty);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextConfig, nextStatus] = await Promise.all([client.getConfig(), client.status()]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setChannel(nextConfig.activeChannel ?? "");
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

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

      setLoginMessage(update.message ?? "");
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
          setLoginState("published");
          setLoginMessage("已发布，等待云端启动。");
          void load();
          break;
        case "publish_failed":
          confirmedRef.current = false;
          setLoginError(null);
          setLoginState("publish_failed");
          setPublishFailure({
            code: update.code ?? "",
            message: update.message ?? "凭据发布失败，可在恢复操作中继续。",
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
              ? new Error(`${code}: ${describeCode(code)}`)
              : new Error(update.message ?? "扫码登录失败，请重试。"),
          );
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [client, load]);

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
    setLoginMessage("");
    setPublishFailure(null);
    setLoginError(null);
  };

  const startLogin = async () => {
    startingRef.current = true;
    confirmedRef.current = false;
    opIDRef.current = "";
    setLoginState("wait");
    setQrContent("");
    setLoginMessage("正在创建二维码…");
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
        setWechatPublished(true);
        setLoginState("published");
        setPublishFailure(null);
        setLoginMessage("已发布，等待云端启动。");
        await load();
      } else {
        setLoginState("publish_failed");
        setLoginMessage(`继续后状态：${result.state || "未知"}。`);
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
      await load();
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
      await load();
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
      const result = await client.connectTelegram(telegramToken, rotate);
      setTelegramResult(result);
      setTelegramToken("");
      setRotate(false);
      await load();
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
      await load();
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
        正在读取消息入口…
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">服务配置</p>
          <h1 className="text-2xl font-semibold tracking-tight">消息入口</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            微信或 Telegram，任选一个。故障时不会自动切换。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw aria-hidden />
          重新检查
        </Button>
      </div>

      <ErrorAlert error={loadError} onRetry={load} />

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="size-4" aria-hidden />
                微信
              </CardTitle>
              <CardDescription>扫码登录你的微信</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {wechatStatus ? <StateBadge state={wechatStatus.state} /> : <Badge variant="outline">状态未知</Badge>}
              {wechatConfigured ? <Badge variant="secondary">凭据已配置</Badge> : <Badge variant="outline">未连接</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {wechatStatus ? <StatusRow item={wechatStatus} /> : null}
          {wechatPublished ? (
            <Alert className="mt-3 border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20">
              <AlertTitle>已连接，等待第一条消息</AlertTitle>
              <AlertDescription>
                给它发条消息，确认能收到回复。
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void startLogin()} disabled={qrOpen}>
              <QrCode aria-hidden />
              {wechatConfigured ? "重新扫码" : "连接微信"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Telegram</CardTitle>
              <CardDescription>验证令牌，发布密钥并设置 webhook。</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {telegramStatus ? <StateBadge state={telegramStatus.state} /> : <Badge variant="outline">状态未知</Badge>}
              {telegramConfigured ? <Badge variant="secondary">已配置</Badge> : <Badge variant="outline">未配置</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {telegramStatus ? <StatusRow item={telegramStatus} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="telegram-token">Bot Token</Label>
              <Input
                id="telegram-token"
                type="password"
                value={telegramToken}
                onChange={(event) => setTelegramToken(event.target.value)}
                placeholder="从 BotFather 获取；提交后清空"
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
            <label className="flex items-start gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={rotate}
                onChange={(event) => setRotate(event.target.checked)}
              />
              <span>
                轮换 webhook secret
                <span className="block text-xs text-muted-foreground">
                  默认保留现有密钥。
                </span>
              </span>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              保存不会切换当前入口。
            </span>
            <Button
              type="button"
              onClick={() => void connectTelegram()}
              disabled={telegramRunning || telegramToken.trim().length === 0}
            >
              {telegramRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {telegramRunning ? "正在连接…" : "保存并连接"}
            </Button>
          </div>
          {telegramResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">配置结果</span>
                <StateBadge state={telegramResult.state} />
              </div>
              <StepList steps={telegramResult.steps ?? []} />
              {telegramResult.state === "unknown" || telegramResult.state === "partial" ? (
                <Button type="button" size="sm" variant="outline" data-testid="telegram-resume" onClick={() => void resumeTelegram()} disabled={telegramRunning}>
                  继续
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={telegramError} onRetry={() => void connectTelegram()} retryLabel="重新连接" />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>当前消息入口</CardTitle>
          <CardDescription>
            没有默认入口，必须手动选。也可以先选尚未配置的入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={channel}
            onValueChange={setChannel}
            aria-label="当前消息入口"
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border p-4">
              <span className="flex items-center gap-3">
                <RadioGroupItem value="telegram" id="current-telegram" />
                <span>
                  <span className="block font-medium">Telegram</span>
                  <span className="text-xs text-muted-foreground">通过 BotFather 创建的机器人收发</span>
                </span>
              </span>
              {telegramConfigured ? <Badge variant="secondary">已配置</Badge> : <Badge variant="outline">未配置</Badge>}
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border p-4">
              <span className="flex items-center gap-3">
                <RadioGroupItem value="wechat" id="current-wechat" />
                <span>
                  <span className="block font-medium">微信</span>
                  <span className="text-xs text-muted-foreground">扫码登录主人微信</span>
                </span>
              </span>
              {wechatConfigured ? <Badge variant="secondary">已配置</Badge> : <Badge variant="outline">未配置</Badge>}
            </label>
          </RadioGroup>
          {!config?.activeChannel ? (
            <p className="mt-2 text-xs text-muted-foreground">
              还没设置入口。
            </p>
          ) : null}
          {channel === "wechat" && !wechatConfigured ? (
            <Alert className="mt-3">
              <AlertTitle>入口未就绪</AlertTitle>
              <AlertDescription>可以发布，但扫码完成前收不到消息。</AlertDescription>
            </Alert>
          ) : null}
          {channel === "telegram" && !telegramConfigured ? (
            <Alert className="mt-3">
              <AlertTitle>入口未就绪</AlertTitle>
              <AlertDescription>可以发布，但缺少令牌前收不到消息。</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              onClick={() => void publishChannel()}
              disabled={channelRunning || !channel || channel === config?.activeChannel}
            >
              {channelRunning ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {channelRunning ? "正在发布…" : "保存并发布"}
            </Button>
          </div>
          {channelResult ? (
            <div className="mt-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">发布结果</span>
                <StateBadge state={channelResult.state ?? ""} />
                <Badge variant={channelResult.configured ? "secondary" : "outline"}>
                  {channelResult.configured ? "已配置" : "尚未配置"}
                </Badge>
              </div>
              {channelResult.state === "unchanged" ? (
                <p className="mt-2 text-sm text-muted-foreground">入口未变化。</p>
              ) : null}
              {channelResult.warning ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{channelResult.warning}</p>
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
                  继续
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={channelError} onRetry={() => void publishChannel()} retryLabel="重新发布" />
          <ErrorAlert error={channelResumeError} onRetry={() => void resumeChannel()} retryLabel="继续" />
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
            <div className="mx-auto rounded-lg border border-border bg-white p-3" data-testid="wechat-qr">
              <QRCodeSVG value={qrContent} size={188} marginSize={2} aria-label="微信登录二维码" />
            </div>
          ) : null}
          {!qrContent && ["wait", "idle"].includes(loginState) ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              正在创建二维码…
            </div>
          ) : null}
          {loginMessage ? <p className="text-sm text-muted-foreground">{loginMessage}</p> : null}

          <StepList steps={loginSteps(loginState)} compact />

          {loginState === "published" ? (
            <Alert>
              <Send />
              <AlertTitle>发送一条真实消息</AlertTitle>
              <AlertDescription>
                收到回复即验证通过。
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-xs text-muted-foreground">
            二维码过期会自动换，最多 3 张。
          </p>
          {publishFailure ? (
            <ErrorAlert
              error={
                publishFailure.code
                  ? new Error(`${publishFailure.code}: ${describeCode(publishFailure.code)}`)
                  : new Error(publishFailure.message)
              }
              onRetry={resumePublish}
              retryLabel="继续"
            />
          ) : null}
          {loginResumeRunning ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              正在核实远端发布状态…
            </p>
          ) : null}
          <ErrorAlert error={loginError} onRetry={() => void startLogin()} retryLabel="重新扫码" />

          <DialogFooter>
            {loginState === "expired" || loginState === "cancelled" || loginState === "error" ? (
              <Button type="button" onClick={() => void startLogin()}>
                重新扫码
              </Button>
            ) : null}
            {loginState === "published" ? (
              <Button type="button" variant="outline" onClick={() => void load()}>
                <RefreshCw aria-hidden />
                检查状态
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={closeLogin}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function loginTitle(state: LoginState): string {
  switch (state) {
    case "scaned":
      return "请在手机上确认";
    case "confirmed":
      return "正在发布密钥";
    case "published":
      return "已连接";
    case "publish_failed":
      return "发布失败";
    case "expired":
      return "二维码已过期";
    case "cancelled":
      return "登录已取消";
    case "error":
      return "登录失败";
    default:
      return "连接微信";
  }
}

function loginDescription(state: LoginState): string {
  switch (state) {
    case "scaned":
      return "已扫码，请在手机上确认。";
    case "confirmed":
      return "确认成功，正在发布密钥。";
    case "published":
      return "已发布，等待云端启动。";
    case "publish_failed":
      return "发布没完成，可以继续。";
    case "expired":
      return "二维码过期，请重新扫码。";
    case "cancelled":
      return "已取消。";
    case "error":
      return "登录失败，请重试。";
    default:
      return "用主人微信扫描下方二维码。";
  }
}

function loginSteps(state: LoginState): StepDTO[] {
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
  const labels = [
    "显示二维码",
    "手机扫码",
    "手机确认",
    "保存并发布密钥",
    "等待云端启动",
    "真实消息验证",
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
