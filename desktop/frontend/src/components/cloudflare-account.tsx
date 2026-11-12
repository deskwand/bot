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
 * Signing out revokes this client's authorization and deletes its local
 * credentials; the cloud service, the selected deployment and the published
 * secrets are untouched, so the dialog says all three out loud. An unsaved
 * draft cannot reach the Cloudflare page: navigation asks before discarding it.
 */
export function CloudflareSignOut() {
  const { client, signedOut } = useApp();
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
      signedOut();
    } catch (failure) {
      setError(failure);
      // Go revokes the refresh token before deleting the local keys, so a
      // delete that fails can leave this client signed out already. The page
      // must not keep claiming the account is connected in that case.
      client
        .cloudflareStatus()
        .then((status) => {
          if (status.state !== "connected") signedOut();
        })
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
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

/**
 * The sidebar footer for the container itself: a connection dot and one row
 * that opens the Cloudflare page. Client settings (theme, language, telemetry)
 * stay separate because they belong to this computer, not to the deployment.
 */
export function ContainerFooter() {
  const { navigate } = useApp();
  const t = useT();

  return (
    <div className="mt-2 border-t border-border pt-3">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="w-full justify-start px-1 text-xs text-muted-foreground"
        onClick={() => navigate("cloudflare")}
      >
        <span className="size-1.5 rounded-full bg-emerald-600" aria-hidden />
        {t("shell.containerFooter")}
      </Button>
    </div>
  );
}
