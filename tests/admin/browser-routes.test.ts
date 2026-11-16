import { describe, expect, it } from "vitest";
import { createBrowserAdminRoutes } from "../../src/admin/browser-routes";
import type { BrowserClient, Snapshot } from "../../src/sandbox/browser-http";

const EMPTY: Snapshot = {
  url: "",
  title: "",
  text: "",
  elements: [],
  truncated: { text: false, elements: false, filtered: 0 },
};

function fakeClient(over: Partial<BrowserClient> = {}): BrowserClient {
  return {
    features: async () => ["browser", "browser-mirror"],
    open: async () => EMPTY,
    act: async () => EMPTY,
    shot: async () => new Uint8Array(),
    close: async () => {},
    openMirror: async () => ({
      url: "https://a.example",
      title: "A",
      viewport: { width: 1280, height: 800 },
    }),
    mirrorStream: async () =>
      new Response("event: idle\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    mirrorInput: async () => ({ ok: true }),
    closeMirror: async () => {},
    ...over,
  };
}

function call(
  routes: ReturnType<typeof createBrowserAdminRoutes>,
  path: string,
  init: RequestInit = {},
) {
  return routes.fetch(new Request(`https://example.com${path}`, init));
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("browser admin routes", () => {
  it("says there is no sandbox", async () => {
    const routes = createBrowserAdminRoutes({ client: null });
    expect(await (await call(routes, "/admin/browser/status")).json()).toEqual({
      available: false,
      reason: "no-sandbox",
    });
  });

  it("says the image is too old", async () => {
    const routes = createBrowserAdminRoutes({ client: fakeClient({ features: async () => ["browser"] }) });
    expect(await (await call(routes, "/admin/browser/status")).json()).toEqual({
      available: false,
      reason: "image-too-old",
    });
  });

  it("says the sandbox is unreachable", async () => {
    const routes = createBrowserAdminRoutes({
      client: fakeClient({
        features: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    });
    expect(await (await call(routes, "/admin/browser/status")).json()).toEqual({
      available: false,
      reason: "sandbox-unreachable",
    });
  });

  it("passes the stream through without rewriting it", async () => {
    const routes = createBrowserAdminRoutes({ client: fakeClient() });
    const response = await call(routes, "/admin/browser/mirror");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("event: idle\ndata: {}\n\n");
  });

  it("forwards open, input and close", async () => {
    const seen: string[] = [];
    const routes = createBrowserAdminRoutes({
      client: fakeClient({
        openMirror: async (url) => {
          seen.push(`open ${url ?? ""}`);
          return { url: url ?? "", title: "", viewport: { width: 1280, height: 800 } };
        },
        mirrorInput: async (seq, events) => {
          seen.push(`input ${String(seq)} ${String(events.length)}`);
          return { ok: true };
        },
        closeMirror: async () => {
          seen.push("close");
        },
      }),
    });
    expect(await (await call(routes, "/admin/browser/open", post({ url: "https://a.example" }))).json()).toMatchObject({
      url: "https://a.example",
    });
    expect(
      await (
        await call(
          routes,
          "/admin/browser/input",
          post({ seq: 4, events: [{ type: "mouse", kind: "down", x: 1, y: 2 }] }),
        )
      ).json(),
    ).toEqual({ ok: true });
    expect(await (await call(routes, "/admin/browser/close", post({}))).json()).toEqual({ ok: true });
    expect(seen).toEqual(["open https://a.example", "input 4 1", "close"]);
  });

  it("answers 502 when the sandbox is gone", async () => {
    const routes = createBrowserAdminRoutes({
      client: fakeClient({
        openMirror: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });
    expect((await call(routes, "/admin/browser/open", post({ url: "https://a.example" }))).status).toBe(502);
  });

  it("answers 404 for an unknown path and 503 for a missing sandbox", async () => {
    const routes = createBrowserAdminRoutes({ client: fakeClient() });
    expect((await call(routes, "/admin/browser/nope")).status).toBe(404);
    const bare = createBrowserAdminRoutes({ client: null });
    expect((await call(bare, "/admin/browser/open", post({ url: "https://a.example" }))).status).toBe(503);
  });
});
