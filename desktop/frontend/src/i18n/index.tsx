import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ClientService, Locale, LocaleSource } from "@/services/types";
import { en } from "./en";
import { zh, type MessageKey, type Messages } from "./zh";

export type { MessageKey, Messages } from "./zh";

const TABLES: Record<Locale, Messages> = { zh, en };

// React-free callers (error copy, helpers) read the same language the provider
// last rendered with.
let currentLocale: Locale = "zh";

const warned = new Set<string>();

function lookup(table: Messages, key: string): string | undefined {
  let value: unknown = table;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, part)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

function format(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const primary = lookup(TABLES[locale], key);
  if (primary === undefined && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] missing ${locale} message for "${key}"`);
  }
  const text = primary ?? lookup(zh, key);
  if (text === undefined) return key;
  return format(text, params);
}

export function getT(): (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string {
  return (key, params) => translate(currentLocale, key, params);
}

interface LocaleContextValue {
  source: LocaleSource;
  resolved: Locale;
  setSource: (next: LocaleSource) => Promise<void>;
  saveError: unknown;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  client,
  children,
}: {
  client: ClientService;
  children: ReactNode;
}) {
  const [source, setSourceState] = useState<LocaleSource>("system");
  const [resolved, setResolved] = useState<Locale>("zh");
  const [saveError, setSaveError] = useState<unknown>(null);
  // Render with the new language immediately; getT() must agree with the
  // tree that is being rendered, not the one before the state update.
  currentLocale = resolved;

  useEffect(() => {
    let cancelled = false;
    client
      .locale()
      .then((value) => {
        if (cancelled) return;
        setSourceState(value.source);
        setResolved(value.resolved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const setSource = useCallback(
    async (next: LocaleSource) => {
      // Go switches in memory even when the write fails, so show the choice
      // at once and keep it if the save is rejected.
      setSourceState(next);
      setResolved((current) => (next === "system" ? current : next));
      setSaveError(null);
      try {
        const value = await client.setLocale(next);
        setSourceState(value.source);
        setResolved(value.resolved);
      } catch (error) {
        setSaveError(error);
      }
    },
    [client],
  );

  const value = useMemo(
    () => ({ source, resolved, setSource, saveError }),
    [source, resolved, setSource, saveError],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("LocaleProvider is missing");
  return value;
}

export function useT(): (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string {
  const { resolved } = useLocale();
  return useCallback(
    (key: MessageKey, params?: Record<string, string | number>) =>
      translate(resolved, key, params),
    [resolved],
  );
}
