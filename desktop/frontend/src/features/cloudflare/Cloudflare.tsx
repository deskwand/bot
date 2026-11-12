import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { pageSubtitle, useApp } from "@/components/app-context";
import { CloudflareSignOut } from "@/components/cloudflare-account";
import { useT } from "@/i18n";
import { useConfigQuery } from "@/services/queries";

/**
 * The Cloudflare container: the account this client is authorized against and
 * the deployment the living entity runs in. Signing out lives here because it
 * belongs to the container, not to the desktop shell.
 */
export function Cloudflare() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const config = configQuery.data;
  const [accountName, setAccountName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .cloudflareStatus()
      .then((status) => {
        if (!cancelled) setAccountName(status.accountName || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div>
      <PageHeader title={t("shell.pages.cloudflare")} subtitle={pageSubtitle("cloudflare")} />

      <dl className="max-w-2xl divide-y divide-border rounded-lg border border-border bg-card text-sm">
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("shell.cfAccount")}</dt>
          <dd className="min-w-0 break-all">
            {accountName ? <span data-i18n-ignore>{accountName}</span> : t("common.unknown")}
          </dd>
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("shell.cfDeployment")}</dt>
          <dd className="min-w-0 break-all">
            {config?.workerName ? <span data-i18n-ignore>{config.workerName}</span> : t("overview.notRead")}
          </dd>
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          <dt className="w-28 shrink-0 text-muted-foreground">{t("shell.cfRelease")}</dt>
          <dd className="min-w-0 break-all">
            {config?.releaseVersion ? (
              <span data-i18n-ignore>{config.releaseVersion}</span>
            ) : (
              t("common.unknown")
            )}
          </dd>
        </div>
      </dl>

      <CloudflareSignOut />
    </div>
  );
}
