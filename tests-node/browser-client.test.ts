import { describe, expect, it } from "vitest";
import { browserClient, type DownloadResult, type Snapshot } from "../src/sandbox/browser-http.js";
import type { ContainerDownloadResult, ContainerSnapshot } from "./helpers/browser-types.js";

const ENV = { SANDBOX_URL: "http://sandbox:8080", SANDBOX_TOKEN: "t" };

/** Compile-time drift guard: the bot's copy must match the container's shape. */
const _shape: Snapshot = null as unknown as ContainerSnapshot;
const _download: DownloadResult = null as unknown as ContainerDownloadResult;

function fakeFetch(routes: Record<string, { status?: number; body?: unknown; bytes?: Uint8Array }>) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, body });
    const route = routes[path];
    if (route === undefined) return new Response("nope", { status: 404 });
    if (route.bytes !== undefined) {
      return new Response(route.bytes as unknown as BodyInit, { status: route.status ?? 200 });
    }
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  };
  return { impl: impl as never, calls };
}

describe("browserClient", () => {
  it("is null without a sandbox", () => {
    expect(browserClient({} as never)).toBeNull();
  });

  it("sends the token and the session on open", async () => {
    const { impl, calls } = fakeFetch({
      "/browser/open": {
        body: {
          url: "https://a.example",
          title: "T",
          text: "",
          elements: [],
          truncated: { text: false, elements: false, filtered: 0 },
        },
      },
    });
    const client = browserClient(ENV as never, impl)!;
    await client.open("task-1", "https://a.example");
    expect(calls[0]!.body).toEqual({ session: "task-1", url: "https://a.example" });
  });

  it("turns a 409 into a SandboxError that carries the server message", async () => {
    const { impl } = fakeFetch({
      "/browser/act": { status: 409, body: { code: "STALE_REF", message: "page moved" } },
    });
    const client = browserClient(ENV as never, impl)!;
    // A 409 is not a transport problem: the model gets the message and re-reads.
    await expect(client.act("task-1", "click", { target: "e1" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "page moved",
    });
  });

  it("returns screenshot bytes as-is", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { impl } = fakeFetch({ "/browser/shot": { bytes: png } });
    const client = browserClient(ENV as never, impl)!;
    expect(await client.shot("task-1", true)).toEqual(png);
  });

  it("reads features from healthz", async () => {
    const { impl } = fakeFetch({
      "/healthz": { body: { ok: true, protocol: 1, features: ["browser"] } },
    });
    const client = browserClient(ENV as never, impl)!;
    expect(await client.features()).toEqual(["browser"]);
  });

  it("throws when healthz is unreachable, so the tool can tell the sandbox is down", async () => {
    const failing = (async () => {
      throw new Error("boom");
    }) as never;
    const client = browserClient(ENV as never, failing)!;
    await expect(client.features()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

void _shape;
void _download;

describe("download", () => {
  it("posts the download target and returns the container's shape", async () => {
    const { impl, calls } = fakeFetch({
      "/browser/download": {
        body: {
          name: "a.csv",
          size: 10,
          path: "/tmp/dw-downloads/x/a.csv",
          snapshot: {
            url: "https://a.example/dl",
            title: "T",
            text: "",
            elements: [],
            truncated: { text: false, elements: false, filtered: 0 },
          },
        },
      },
    });
    const client = browserClient(ENV as never, impl)!;
    const result = await client.download("task-1", "#get");
    expect(calls[0]!.body).toEqual({ session: "task-1", target: "#get" });
    expect(result.name).toBe("a.csv");
    expect(result.snapshot.url).toBe("https://a.example/dl");
  });
});
