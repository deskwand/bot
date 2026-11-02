import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";
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
import { ErrorAlert } from "@/components/feedback";
import { useApp } from "@/components/app-context";

/**
 * Sidebar footer for the connected account. Signing out revokes this client's
 * authorization and deletes its local credentials; the cloud service, the
 * selected deployment and the published secrets are untouched, so the dialog
 * says all three out loud.
 */
export function CloudflareAccountCard({
  dirty,
  onSignedOut,
}: {
  dirty: boolean;
  onSignedOut: () => void;
}) {
  const { client } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const change = (next: boolean) => {
    // A close request that arrives mid-request would drop the spinner while the
    // credentials are still being deleted; ignore it instead.
    if (busy) return;
    setOpen(next);
    if (!next) setError(null);
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.disconnectCloudflare();
      setOpen(false);
      onSignedOut();
    } catch (failure) {
      setError(failure);
      // Go revokes the refresh token before deleting the local keys, so a
      // delete that fails can leave this client signed out already. The card
      // must not keep claiming the account is connected in that case.
      client
        .cloudflareStatus()
        .then((status) => {
          if (status.state !== "connected") onSignedOut();
        })
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground md:mt-auto">
      <Badge variant="secondary" className="mb-2">
        Cloudflare 已连接
      </Badge>
      <p>一套服务 · 客户端关闭后云端继续运行</p>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="-ml-2 mt-2"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => change(true)}
      >
        <LogOut aria-hidden />
        退出登录
      </Button>

      <Dialog open={open} onOpenChange={change}>
        <DialogContent showCloseButton={!busy} aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>退出 Cloudflare 账号？</DialogTitle>
            <DialogDescription>
              会撤销这台客户端的授权并清除本机凭据。云端服务不受影响，消息照常收发。已选的部署和密钥留在本机，重新登录后可以继续管理。
            </DialogDescription>
          </DialogHeader>
          {dirty ? (
            <p className="text-sm text-muted-foreground">
              当前页面未发布的更改会丢弃，云端配置不变。
            </p>
          ) : null}
          <ErrorAlert error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={signOut} disabled={busy}>
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              确认退出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
