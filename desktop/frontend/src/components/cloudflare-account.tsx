import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";
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
import { useT } from "@/i18n";

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
  const t = useT();
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
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5" aria-label={t("shell.accountConnected")}>
        <span className="size-1.5 rounded-full bg-emerald-600" aria-hidden />Cloudflare
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="px-1"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => change(true)}
      >
        <LogOut aria-hidden />
        {t("shell.signOut")}
      </Button>

      <Dialog open={open} onOpenChange={change}>
        <DialogContent showCloseButton={!busy} aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>{t("shell.signOutTitle")}</DialogTitle>
            <DialogDescription>{t("shell.signOutDescription")}</DialogDescription>
          </DialogHeader>
          {dirty ? (
            <p className="text-sm text-muted-foreground">
              {t("shell.unpublishedWillDiscard")}
            </p>
          ) : null}
          <ErrorAlert error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={signOut} disabled={busy}>
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {t("shell.confirmSignOut")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
