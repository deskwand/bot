import { en, t, zh, type Locale } from "../i18n";

/**
 * One set of phone-reading rules for every role that writes to the owner.
 * Conversational roles also get the fragment rule: several messages in a row
 * are one thought, so an unfinished-looking one should not spawn work yet.
 */
export function phoneRules(
  locale: Locale,
  opts: { conversational: boolean },
): string {
  const rules = [...(locale === "en" ? en : zh).phone.rules];
  if (opts.conversational) {
    rules.push(t(locale, "phone.fragmentRule"));
  }
  return [
    t(locale, "phone.rulesTitle"),
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}
