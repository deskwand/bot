import { expect, type Page } from "@playwright/test";

/** Opens `url` with the fixture system locale set to English. */
export async function useEnglish(page: Page, url: string): Promise<void> {
  const target = new URL(url, "http://127.0.0.1:5173");
  target.searchParams.set("locale", "en");
  await page.goto(`${target.pathname}${target.search}`);
}

/**
 * Asserts that `root` renders no Han characters outside `[data-i18n-ignore]`
 * subtrees, including the accessible labels of visible elements.
 */
export async function expectNoChinese(
  page: Page,
  root = "body",
): Promise<void> {
  const found = await page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) throw new Error(`expectNoChinese: ${selector} not found`);

    const han = /\p{Script=Han}/u;
    const samples: string[] = [];
    const record = (source: string, value: string) => {
      const text = value.replace(/\s+/g, " ").trim();
      if (!text || !han.test(text)) return;
      samples.push(`${source}: ${text.slice(0, 80)}`);
    };

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script, style, noscript")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest("[data-i18n-ignore]")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      record("text", walker.currentNode.textContent ?? "");
    }

    for (const element of scope.querySelectorAll(
      "[aria-label], [title], [placeholder]",
    )) {
      if (element.closest("[data-i18n-ignore]")) continue;
      if (!(element as HTMLElement).getClientRects().length) continue;
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = element.getAttribute(name);
        if (value) record(name, value);
      }
    }

    return samples;
  }, root);

  expect(
    found.slice(0, 10),
    `Found Chinese text under ${root}:\n${found.slice(0, 10).join("\n")}`,
  ).toEqual([]);
}
