import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app-context";
import { codeCopy, toClientError } from "@/services/errors";
import type { ThemeSource } from "@/services/types";

const OPTIONS: { source: ThemeSource; label: string; icon: typeof Sun }[] = [
  { source: "system", label: "跟随系统", icon: Monitor },
  { source: "light", label: "浅色", icon: Sun },
  { source: "dark", label: "深色", icon: Moon },
];

/**
 * Sidebar footer control for the appearance. Go owns the choice and sets the
 * app's appearance; the page and the native chrome both follow
 * prefers-color-scheme, so nothing here touches a class or a CSS variable.
 */
export function ThemeSwitcher() {
  const { client } = useApp();
  const [source, setSource] = useState<ThemeSource>("system");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .theme()
      .then((value) => {
        if (!cancelled) setSource(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const choose = async (next: ThemeSource) => {
    if (next === source) return;
    const previous = source;
    setSource(next);
    try {
      await client.setTheme(next);
      setError(null);
    } catch (failure) {
      // Go stores before it applies, so a rejected write means the appearance
      // never changed: show the old choice again.
      setSource(previous);
      setError(failure);
    }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">主题</span>
        <div
          role="group"
          aria-label="外观"
          className="flex gap-0.5 rounded-lg border border-border p-0.5"
        >
          {OPTIONS.map(({ source: value, label, icon: Icon }) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={source === value ? "secondary" : "ghost"}
              // The sidebar is 224px wide; icons alone fit where three
              // labels do not. The name stays for screen readers and hover.
              className="h-6 w-[26px] rounded-md px-0"
              title={label}
              aria-label={label}
              aria-pressed={source === value}
              onClick={() => void choose(value)}
            >
              <Icon className="size-[13px]" aria-hidden />
            </Button>
          ))}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {codeCopy(toClientError(error).code).short}
        </p>
      ) : null}
    </div>
  );
}
