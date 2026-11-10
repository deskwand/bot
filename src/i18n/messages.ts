import type { Locale } from "./index";
import { en } from "./en";
import { zh } from "./zh";

/** Recursively widens every dictionary leaf to `string`. */
export type DeepString<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly DeepString<U>[]
    : { readonly [K in keyof T]: DeepString<T[K]> };

export type Messages = DeepString<typeof zh>;

type DotPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends readonly unknown[]
      ? never
      : DotPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = DotPaths<typeof zh>;

function lookup(table: unknown, key: string): string | undefined {
  let node: unknown = table;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function formatTemplate(
  template: string,
  params: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function t(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const table = locale === "en" ? en : zh;
  const template = lookup(table, key) ?? lookup(zh, key) ?? key;
  return formatTemplate(template, params);
}

/** Like `t`, but returns `undefined` instead of the key for unknown paths. */
export function tryT(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string | undefined {
  const table = locale === "en" ? en : zh;
  const template = lookup(table, key) ?? lookup(zh, key);
  if (template === undefined) return undefined;
  return formatTemplate(template, params);
}
