import { t, type Locale } from "../i18n";
import type { SelfStore } from "./self-store";
import { boundedSelfData, escapeSelfData } from "./self-sources";
export function renderSelfSection(store: SelfStore, locale: Locale): string {
  const docs = ["identity", "situation"] as const;
  const lines = docs.map((kind) => {
    const doc = store.doc(kind);
    return `${kind} v${doc.version}: ${escapeSelfData(doc.content)}`;
  });
  for (const e of store.recentExperiences(3)) {
    // Keep facts and interpretation labelled even when the combined text is cut.
    lines.push(
      `${e.id} v${e.version} (${e.source.kind}, ${escapeSelfData(e.source.ref ?? "")}, ${e.occurredAt}): ${boundedSelfData(JSON.stringify({ facts: e.facts, interpretation: e.interpretation }), 300)}`,
    );
  }
  return [
    t(locale, "butler.self.guidance"),
    t(locale, "butler.self.dataWarning"),
    "<<<",
    ...lines,
    ">>>",
  ].join("\n");
}
export function renderSelfVoice(store: SelfStore, locale: Locale): string {
  const content = store.doc("identity").content;
  const points = [...escapeSelfData(content)];
  const voice =
    points.slice(0, 400).join("") + (points.length > 400 ? "…" : "");
  return content === ""
    ? ""
    : [t(locale, "butler.self.dataWarning"), "<<<", voice, ">>>"].join("\n");
}
