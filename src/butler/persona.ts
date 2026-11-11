import { en, t, zh, type Locale } from "../i18n";

/**
 * The single description of who the butler is and how it talks. Both the
 * butler's system prompt and the speaker that rewrites events share it.
 */
export function persona(locale: Locale, channelName: string | null): string {
  const channel =
    channelName ?? t(locale, "prompt.persona.neutralChannel");
  const table = locale === "en" ? en : zh;
  return [
    t(locale, "prompt.persona.intro", { channel }),
    t(locale, "prompt.persona.situation"),
    "",
    t(locale, "prompt.persona.styleTitle"),
    ...table.prompt.persona.style.map((line) => `- ${line}`),
  ].join("\n");
}
