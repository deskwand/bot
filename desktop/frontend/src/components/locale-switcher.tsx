import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "@/components/feedback";
import { LocaleChoice } from "@/components/locale-choice";
import { useApp } from "@/components/app-context";
import { useLocale, useT } from "@/i18n";
import { useConfigQuery, useInvalidate } from "@/services/queries";

/**
 * Sidebar footer control for the language the UI and the bot use. Go owns the
 * preference; the published config keeps its own copy, so a change only reaches
 * the bot after the next publish.
 */
export function LocaleSwitcher({ dirty = false }: { dirty?: boolean }) {
  const { client } = useApp();
  const { resolved } = useLocale();
  const t = useT();
  const configQuery = useConfigQuery();
  const invalidate = useInvalidate();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<unknown>(null);
  const [syncIncomplete, setSyncIncomplete] = useState(false);

  const config = configQuery.data;
  // Old cached configs predate the locale field; Go's zero value is zh.
  const pending =
    config !== undefined &&
    config.configPresent &&
    (config.locale ?? "zh") !== resolved;

  const sync = async () => {
    if (!config) return;
    setSyncing(true);
    setSyncError(null);
    setSyncIncomplete(false);
    try {
      const result = await client.publishConfig({
        baseFingerprint: config.fingerprint,
      });
      if (result.state !== "published" && result.state !== "unchanged") {
        setSyncIncomplete(true);
      }
      invalidate.config();
    } catch (error) {
      setSyncError(error);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mb-3">
      <LocaleChoice />
      {pending ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t("locale.pendingBot", {
              lang: t(resolved === "en" ? "locale.en" : "locale.zh"),
            })}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={syncing || dirty}
            title={dirty ? t("locale.syncBlockedDirty") : undefined}
            onClick={() => void sync()}
          >
            {syncing ? t("locale.syncing") : t("locale.syncNow")}
          </Button>
          {dirty ? (
            <p className="text-xs text-muted-foreground">
              {t("locale.syncBlockedDirty")}
            </p>
          ) : null}
          {syncIncomplete ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("locale.syncIncomplete")}
            </p>
          ) : null}
        </div>
      ) : null}
      {syncError ? <ErrorAlert error={syncError} /> : null}
    </div>
  );
}
