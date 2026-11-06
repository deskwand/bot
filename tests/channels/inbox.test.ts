import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifactKeySegments } from "../../src/artifact";
import { inboxKey, inboxStore, isInboxKey } from "../../src/channels/inbox";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("inboxKey", () => {
  it("builds a three-segment key under inbox/", () => {
    expect(inboxKey("tg:42", "报告.pdf")).toBe("inbox/tg:42/报告.pdf");
  });

  it("keeps a hostile file name inside the inbox", () => {
    const key = inboxKey("tg:42", "../../etc/passwd");
    expect(key.startsWith("inbox/tg:42/")).toBe(true);
    expect(artifactKeySegments(key)).not.toBeNull();
    expect(inboxKey("wx:a/b", "x.txt")).toBe("inbox/wx:a_b/x.txt");
  });
});

describe("isInboxKey", () => {
  it.each([
    ["inbox/tg:1/a.pdf", true],
    ["t1/id/a.pdf", false],
    ["inbox/../a", false],
    ["inbox/tg:1", false],
  ])("%s → %s", (key, expected) => expect(isInboxKey(key)).toBe(expected));
});

describe("inboxStore", () => {
  it("stores bytes with their type and returns the reference", async () => {
    const file = await inboxStore(env.ARTIFACTS)(
      "tg:7",
      "a b.pdf",
      new Uint8Array([1, 2]),
      "application/pdf",
    );
    expect(file).toEqual({
      name: "a_b.pdf",
      key: "inbox/tg:7/a_b.pdf",
      mimeType: "application/pdf",
      size: 2,
    });
    expect((await env.ARTIFACTS.head(file.key))?.httpMetadata?.contentType).toBe(
      "application/pdf",
    );
  });
});
