import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  collectScript,
  fingerprintOf,
  tagScript,
  tagSelectorScript,
  UNTAG_SOURCE,
} from "../container/sandbox/browser-snapshot.js";

/**
 * The page scripts are built by injecting function source, so nothing in the
 * type system proves they run. These tests execute the generated source in a vm
 * with a DOM stub: a free variable in an injected helper (the bug that made
 * every ref-based click throw `MAX_NAME_CHARS is not defined`) fails here.
 */
type FakeElement = {
  tagName: string;
  type: string;
  innerText: string;
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getClientRects(): number[];
  scrollIntoView(): void;
  [key: string]: unknown;
};

function element(over: Partial<FakeElement> & { tagName: string; innerText?: string }): FakeElement {
  const attributes: Record<string, string> = {};
  return {
    type: "",
    innerText: "",
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    getClientRects: () => [1],
    scrollIntoView: () => {},
    ...over,
  };
}

function page(elements: FakeElement[], over: Record<string, unknown> = {}) {
  return {
    location: { href: "https://a.example/login" },
    document: {
      title: "Login",
      body: { innerText: "hello" },
      querySelectorAll: (selector: string) =>
        elements.filter((candidate) =>
          selector.includes("data-dw-hit")
            ? candidate.attributes["data-dw-hit"] !== undefined
            : true,
        ),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    ...over,
  };
}

describe("collectScript", () => {
  it("runs and reports the page and its elements", () => {
    const button = element({ tagName: "BUTTON", innerText: "Sign in" });
    const hidden = element({ tagName: "INPUT", type: "hidden" });
    const result = vm.runInNewContext(collectScript(), page([button, hidden])) as {
      url: string;
      elements: { role: string; name: string }[];
      filtered: number;
    };
    expect(result.url).toBe("https://a.example/login");
    expect(result.elements).toEqual([{ role: "button", name: "Sign in", type: undefined, placeholder: undefined, href: undefined, checked: undefined }]);
    expect(result.filtered).toBe(1);
  });

  it("skips elements that are not laid out", () => {
    const invisible = element({ tagName: "BUTTON", innerText: "nope", getClientRects: () => [] });
    const result = vm.runInNewContext(collectScript(), page([invisible])) as {
      elements: unknown[];
      filtered: number;
    };
    expect(result.elements).toHaveLength(0);
    expect(result.filtered).toBe(1);
  });
});

describe("tagScript", () => {
  it("tags exactly the element whose fingerprint matches", () => {
    const wanted = element({ tagName: "BUTTON", innerText: "Sign in" });
    const other = element({ tagName: "BUTTON", innerText: "Delete" });
    const tagged = vm.runInNewContext(
      tagScript(fingerprintOf("button", "Sign in")),
      page([other, wanted]),
    );
    expect(tagged).toBe(true);
    expect(wanted.attributes["data-dw-hit"]).toBe("1");
    expect(other.attributes["data-dw-hit"]).toBeUndefined();
  });

  it("returns false when the fingerprint is gone", () => {
    const other = element({ tagName: "BUTTON", innerText: "Delete" });
    expect(
      vm.runInNewContext(tagScript(fingerprintOf("button", "Sign in")), page([other])),
    ).toBe(false);
  });

  it("keeps the injected name cap identical to the module's", () => {
    const long = "x".repeat(200);
    const tag = element({ tagName: "BUTTON", innerText: long });
    expect(vm.runInNewContext(tagScript(fingerprintOf("button", long)), page([tag]))).toBe(true);
  });
});

describe("tagSelectorScript and UNTAG_SOURCE", () => {
  it("tags the first visible match and untag clears it", () => {
    const button = element({ tagName: "BUTTON", innerText: "Go" });
    const context = page([button]);
    expect(vm.runInNewContext(tagSelectorScript("button"), context)).toBe(true);
    expect(button.attributes["data-dw-hit"]).toBe("1");
    vm.runInNewContext(UNTAG_SOURCE, context);
    expect(button.attributes["data-dw-hit"]).toBeUndefined();
  });
});
