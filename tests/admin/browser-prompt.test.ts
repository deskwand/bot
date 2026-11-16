import { describe, expect, it } from "vitest";
import { browserSectionText } from "../../src/sandbox/browser-install";

describe("browser prompt", () => {
  // The node pool cannot load this module: `browser-install` reaches
  // `artifact-store`, which pulls a wasm image encoder the node pool has no
  // loader for. The workerd pool is where the tool extension already runs.
  it("sends the owner to the takeover page instead of handing over a url", () => {
    const text = browserSectionText();
    expect(text).toContain("prove they are not a robot");
    expect(text).toContain("takeover page");
    expect(text).not.toContain("give them the URL");
  });

  it("still asks for secrets instead of guessing them", () => {
    expect(browserSectionText()).toContain("Do not guess them");
  });
});
