import { Button } from "@/components/ui/button";
import { useLocale, useT, type MessageKey } from "@/i18n";
import type { LocaleSource } from "@/services/types";

const OPTIONS: { source: LocaleSource; label: MessageKey }[] = [
  { source: "system", label: "locale.system" },
  { source: "zh", label: "locale.zh" },
  { source: "en", label: "locale.en" },
];

/** Language picker shown in the sidebar and before the first connection. */
export function LocaleChoice() {
  const { source, setSource, saveError } = useLocale();
  const t = useT();

  return (
    <>
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
              data-i18n-ignore={value === "zh" ? "" : undefined}
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
      {saveError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("locale.saveFailed")}
        </p>
      ) : null}
    </>
  );
}
