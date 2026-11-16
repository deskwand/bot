/**
 * The snapshot every browser action returns: what the page says and which
 * elements can be acted on. Refs live only in this process — nothing is
 * written into the page — so a re-render invalidates a ref instead of
 * silently pointing it at something else.
 */

export const MAX_ELEMENTS = 60;
export const MAX_TEXT_BYTES = 8192;
export const MAX_NAME_CHARS = 80;

export const CANDIDATE_SELECTOR =
  "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable]";

export type RawElement = {
  role: string;
  name: string;
  type?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean;
};

export type RawSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: RawElement[];
  filtered: number;
};

export type SnapshotElement = RawElement & { ref: string };

export type Snapshot = {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  truncated: { text: boolean; elements: boolean; filtered: number };
};

export type RefTable = Map<string, string>;

export type TargetResolution =
  | { ok: true; element: RawElement }
  | { ok: false; reason: "missing" | "ambiguous" };

/** Whitespace-collapsed and capped; both sides of the wire must agree. */
export const capElementName = (name: string): string => {
  const single = name.replace(/\s+/g, " ").trim();
  return single.length > MAX_NAME_CHARS ? `${single.slice(0, MAX_NAME_CHARS - 1)}…` : single;
};

/** The identity of an element across snapshots. Value is never part of it. */
export const fingerprintOf = (
  role: string,
  name: string,
  type?: string,
  placeholder?: string,
): string => [role, capElementName(name), type ?? "", placeholder ?? ""].join("|");

export function fingerprint(element: RawElement): string {
  return fingerprintOf(element.role, element.name, element.type, element.placeholder);
}

function capText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).length <= MAX_TEXT_BYTES) {
    return { text: normalized, truncated: false };
  }
  // Bytes >= characters, so slicing MAX_TEXT_BYTES characters is a safe upper
  // bound; the loop below then only ever encodes at most 8 KB per round.
  let out = normalized.slice(0, MAX_TEXT_BYTES);
  while (out.length > 0 && encoder.encode(out).length > MAX_TEXT_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return { text: out, truncated: true };
}

export function buildSnapshot(raw: RawSnapshot): Snapshot {
  const text = capText(raw.text);
  const named = raw.elements.filter((element) => element.name.trim() !== "");
  const kept = named.slice(0, MAX_ELEMENTS);
  return {
    url: raw.url,
    title: raw.title,
    text: text.text,
    elements: kept.map((element, index) => ({
      ...element,
      name: capElementName(element.name),
      ref: `e${String(index + 1)}`,
    })),
    truncated: {
      text: text.truncated,
      elements: named.length > kept.length,
      // Nameless elements are dropped too, and they must be accounted for:
      // an icon-only button that vanishes reads as "this page has no button".
      filtered: raw.filtered + (raw.elements.length - named.length),
    },
  };
}

export function refTable(snapshot: Snapshot): RefTable {
  const table: RefTable = new Map();
  for (const element of snapshot.elements) table.set(element.ref, fingerprint(element));
  return table;
}

export function isRef(target: string): boolean {
  return /^e\d+$/.test(target);
}

export function resolveTarget(
  table: RefTable,
  target: string,
  live: RawElement[],
): TargetResolution {
  const wanted = table.get(target);
  if (wanted === undefined) return { ok: false, reason: "missing" };
  const matches = live.filter((element) => fingerprint(element) === wanted);
  if (matches.length === 0) return { ok: false, reason: "missing" };
  // Ambiguity is not "try again": rereading the page gives the same two rows.
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, element: matches[0]! };
}

/**
 * Everything the two injected scripts share. Kept as one string so the
 * selector, the visibility rule and the fingerprint cannot drift apart.
 */
const PAGE_HELPERS = `
  // INVARIANT: this block may only reference what it defines. Its functions are
  // injected through Function.prototype.toString, so any module-scope free
  // variable survives the injection as a ReferenceError at click time. The
  // compiler cannot check this; tests-node/browser-page-scripts.test.ts runs
  // the generated source in a vm to.
  const MAX_NAME_CHARS = ${JSON.stringify(MAX_NAME_CHARS)};
  const SEL = ${JSON.stringify(CANDIDATE_SELECTOR)};
  const capElementName = ${capElementName.toString()};
  const fingerprintOf = ${fingerprintOf.toString()};
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (el.isContentEditable) return "editable";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return "checkbox";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return tag;
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute && el.getAttribute("aria-label");
    if (labelled && labelled.trim()) return labelled;
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (text) return text;
    if (el.placeholder) return el.placeholder;
    if (el.alt) return el.alt;
    const titled = el.getAttribute && el.getAttribute("title");
    if (titled && titled.trim()) return titled;
    return "";
  };
  const collect = () => {
    const elements = [];
    let filtered = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (el.tagName === "INPUT" && el.type === "hidden") { filtered += 1; continue; }
      if (!visible(el)) { filtered += 1; continue; }
      const role = roleOf(el);
      const name = nameOf(el);
      const type = el.type || undefined;
      const placeholder = el.placeholder || undefined;
      elements.push({
        role,
        name,
        type,
        placeholder,
        href: el.tagName === "A" ? el.getAttribute("href") || undefined : undefined,
        checked: (el.type === "checkbox" || el.type === "radio") ? el.checked === true : undefined,
      });
    }
    return {
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText : "",
      elements,
      filtered,
    };
  };
`;

export function collectScript(): string {
  return `(() => {${PAGE_HELPERS}\n  return collect();\n})()`;
}

export function tagScript(wanted: string): string {
  return `(() => {${PAGE_HELPERS}
  const wanted = ${JSON.stringify(wanted)};
  for (const el of document.querySelectorAll(SEL)) {
    if (el.tagName === "INPUT" && el.type === "hidden") continue;
    if (!visible(el)) continue;
    if (fingerprintOf(roleOf(el), nameOf(el), el.type || undefined, el.placeholder || undefined) !== wanted) continue;
    el.setAttribute("data-dw-hit", "1");
    el.scrollIntoView({ block: "center" });
    return true;
  }
  return false;
})()`;
}

export function tagSelectorScript(selector: string): string {
  return `(() => {${PAGE_HELPERS}
  const wanted = ${JSON.stringify(selector)};
  for (const el of document.querySelectorAll(wanted)) {
    if (!visible(el)) continue;
    el.setAttribute("data-dw-hit", "1");
    el.scrollIntoView({ block: "center" });
    return true;
  }
  return false;
})()`;
}

/**
 * File inputs are almost never visible: sites hide them behind a styled button.
 * These two skip the visibility test tagScript insists on, and refuse anything
 * that is not an `input[type=file]`.
 */
export function tagFileInputScript(wanted: string): string {
  return `(() => {${PAGE_HELPERS}
  const wanted = ${JSON.stringify(wanted)};
  for (const el of document.querySelectorAll("input[type=file]")) {
    if (el.tagName !== "INPUT" || el.type !== "file" || el.disabled) continue;
    if (fingerprintOf(roleOf(el), nameOf(el), el.type || undefined, el.placeholder || undefined) !== wanted) continue;
    el.setAttribute("data-dw-hit", "1");
    return true;
  }
  return false;
})()`;
}

export function tagFileSelectorScript(selector: string): string {
  return `(() => {${PAGE_HELPERS}
  for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
    if (el.tagName !== "INPUT" || el.type !== "file" || el.disabled) continue;
    el.setAttribute("data-dw-hit", "1");
    return true;
  }
  return false;
})()`;
}

export const UNTAG_SOURCE =
  '(() => { for (const el of document.querySelectorAll("[data-dw-hit]")) el.removeAttribute("data-dw-hit"); return true; })()';
