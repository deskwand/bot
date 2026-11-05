import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ClientService, Locale, LocaleSource } from "@/services/types";
import { en } from "./en";
import type { MessageKey, Messages } from "./types";
import { zh } from "./zh";

export type { MessageKey, Messages } from "./types";

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

export function tryT(
  key: string,
  params?: Record<string, string | number>,
): string | undefined {
  const text = lookup(TABLES[currentLocale], key) ?? lookup(zh, key);
  if (text === undefined) return undefined;
  return format(text, params);
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(currentLocale === "en" ? "en-US" : "zh-CN", {
    hour12: false,
  });
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
  // Only the newest setSource call may apply its response; an older save can
  // resolve (or fail and re-read) after a later click.
  const requestSeq = useRef(0);
  // getT()/formatDateTime() must agree with the tree React is rendering.
  currentLocale = resolved;
  useLayoutEffect(() => {
    document.documentElement.lang = resolved === "en" ? "en" : "zh-CN";
  }, [resolved]);

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
      const seq = ++requestSeq.current;
      // Go switches in memory even when the write fails, so show the choice
      // at once and keep it if the save is rejected.
      setSourceState(next);
      setResolved((current) => (next === "system" ? current : next));
      setSaveError(null);
      try {
        const value = await client.setLocale(next);
        if (seq !== requestSeq.current) return;
        setSourceState(value.source);
        setResolved(value.resolved);
      } catch (error) {
        if (seq !== requestSeq.current) return;
        setSaveError(error);
        // The bridge threw, so its DTO never arrived. Go may have switched in
        // memory anyway; re-read so the UI does not keep a stale resolution.
        try {
          const value = await client.locale();
          if (seq !== requestSeq.current) return;
          setSourceState(value.source);
          setResolved(value.resolved);
        } catch {
          // Keep the optimistic choice when even the re-read fails.
        }
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
