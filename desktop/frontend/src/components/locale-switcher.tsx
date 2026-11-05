import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "@/components/feedback";
import { useApp } from "@/components/app-context";
import { useLocale, useT, type MessageKey } from "@/i18n";
import { useConfigQuery, useInvalidate } from "@/services/queries";
import type { LocaleSource } from "@/services/types";

const OPTIONS: { source: LocaleSource; label: MessageKey }[] = [
  { source: "system", label: "locale.system" },
  { source: "zh", label: "locale.zh" },
  { source: "en", label: "locale.en" },
];

/**
 * Sidebar footer control for the language the UI and the bot use. Go owns the
 * preference; the published config keeps its own copy, so a change only reaches
 * the bot after the next publish.
 */
export function LocaleSwitcher() {
  const { client } = useApp();
  const { source, resolved, setSource, saveError } = useLocale();
  const t = useT();
  const configQuery = useConfigQuery();
  const invalidate = useInvalidate();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<unknown>(null);

  const config = configQuery.data;
  const pending =
    config !== undefined && config.configPresent && config.locale !== resolved;

  const sync = async () => {
    if (!config) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await client.publishConfig({ baseFingerprint: config.fingerprint });
      invalidate.config();
    } catch (error) {
      setSyncError(error);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t("locale.label")}</span>
        <div
          role="group"
          aria-label={t("locale.label")}
          className="flex gap-0.5 rounded-lg border border-border p-0.5"
        >
          {OPTIONS.map(({ source: value, label }) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={source === value ? "secondary" : "ghost"}
              className="rounded-md px-1.5"
              aria-pressed={source === value}
              onClick={() => {
                if (value !== source) void setSource(value);
              }}
            >
              {t(label)}
            </Button>
          ))}
        </div>
      </div>
      {pending ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t("locale.pendingBot", {
              lang: resolved === "en" ? "English" : "中文",
            })}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? t("locale.syncing") : t("locale.syncNow")}
          </Button>
        </div>
      ) : null}
      {syncError ? <ErrorAlert error={syncError} /> : null}
      {saveError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("locale.saveFailed")}
        </p>
      ) : null}
    </div>
  );
}
