import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sweepTemp } from "../container/sandbox/browser.js";
import {
  MAX_ELEMENTS,
  MAX_TEXT_BYTES,
  buildSnapshot,
  collectScript,
  fingerprintOf,
  isRef,
  refTable,
  resolveTarget,
  tagScript,
  type RawElement,
  type RawSnapshot,
} from "../container/sandbox/browser-snapshot.js";

const textbox = (name: string): RawElement => ({ role: "textbox", name, type: "email" });

function raw(over: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    url: "https://example.com/login",
    title: "Login",
    text: "hi",
    elements: [],
    filtered: 0,
    ...over,
  };
}

describe("buildSnapshot", () => {
  it("numbers elements e1..eN in document order", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox("a"), textbox("b"), textbox("c")] }));
    expect(snapshot.elements.map((element) => element.ref)).toEqual(["e1", "e2", "e3"]);
  });

  it("drops elements with no readable name but counts them", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox(""), textbox("登录")] }));
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]!.name).toBe("登录");
    // An icon-only button must not vanish without a trace.
    expect(snapshot.truncated.filtered).toBe(1);
  });

  it("caps elements and flags it", () => {
    const many = Array.from({ length: MAX_ELEMENTS + 3 }, (_, index) => textbox(`b${String(index)}`));
    const snapshot = buildSnapshot(raw({ elements: many }));
    expect(snapshot.elements).toHaveLength(MAX_ELEMENTS);
    expect(snapshot.truncated.elements).toBe(true);
  });

  it("caps text by bytes, not characters", () => {
    const snapshot = buildSnapshot(raw({ text: "王".repeat(4000) }));
    expect(new TextEncoder().encode(snapshot.text).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(snapshot.truncated.text).toBe(true);
  });

  it("keeps the filtered count", () => {
    expect(buildSnapshot(raw({ filtered: 12 })).truncated.filtered).toBe(12);
  });
});

describe("resolveTarget", () => {
  it("finds the live element whose fingerprint matches", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox("密码"), textbox("登录")] }));
    const resolved = resolveTarget(refTable(snapshot), "e2", [textbox("密码"), textbox("登录")]);
    expect(resolved).toEqual({ ok: true, element: textbox("登录") });
  });

  it("still resolves when the element moved position", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox("密码"), textbox("登录")] }));
    const resolved = resolveTarget(refTable(snapshot), "e2", [textbox("登录"), textbox("密码")]);
    expect(resolved.ok).toBe(true);
  });

  it("reports a missing fingerprint", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox("登录")] }));
    expect(resolveTarget(refTable(snapshot), "e1", [textbox("删除")])).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports ambiguity when two elements share the fingerprint", () => {
    const snapshot = buildSnapshot(raw({ elements: [textbox("删除")] }));
    expect(resolveTarget(refTable(snapshot), "e1", [textbox("删除"), textbox("删除")])).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("reports a missing ref for an unknown number", () => {
    expect(resolveTarget(new Map(), "e9", [textbox("a")])).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("isRef", () => {
  it("matches only e followed by digits", () => {
    expect(isRef("e12")).toBe(true);
    expect(isRef("E12")).toBe(false);
    expect(isRef("#submit")).toBe(false);
  });
});

describe("fingerprintOf", () => {
  it("fills missing type and placeholder with empty strings", () => {
    expect(fingerprintOf("textbox", "a")).toBe("textbox|a||");
  });

  it("collapses whitespace and caps the name at 80 characters", () => {
    const long = "x".repeat(200);
    expect(fingerprintOf("button", " a\n  b ")).toBe("button|a b||");
    expect(fingerprintOf("button", long).length).toBeLessThan(100);
  });
});

describe("page scripts", () => {
  it("collect and tag share the same selector and fingerprint helper", () => {
    for (const source of [collectScript(), tagScript("button|ok||")]) {
      expect(source).toContain("a[href],button,input,select,textarea");
      expect(source).toContain("fingerprintOf");
    }
  });

  it("tagScript embeds the wanted fingerprint as a JSON string", () => {
    expect(tagScript('button|say "hi"||')).toContain('"button|say \\"hi\\"||"');
  });
});

import {
  BrowserError,
  createBrowserManager,
  type MirrorEvent,
  type PageLike,
} from "../container/sandbox/browser.js";
import { identityFor, launchOptions } from "../container/sandbox/browser-identity.js";
import { startSandboxd, type Sandboxd } from "../container/sandbox/server.js";

type Recorded = { calls: string[]; cdp?: unknown[][] };

function fakePage(
  record: Recorded,
  options: { url?: string; snapshots?: string[] } = {},
): PageLike {
  let current = options.url ?? "about:blank";
  return {
    async goto(url) {
      record.calls.push(`goto ${url}`);
      current = url;
    },
    async evaluate(source) {
      record.calls.push(
        source.includes("return collect()")
          ? "evaluate collect"
          : source.includes("removeAttribute")
            ? "evaluate untag"
            : "evaluate tag",
      );
      if (source.includes("return collect()")) {
        const queued = options.snapshots?.shift();
        return {
          url: current,
          title: "T",
          text: "hello",
          elements: [{ role: "button", name: queued ?? "Go" }],
          filtered: 0,
        };
      }
      return true;
    },
    async click(selector) {
      record.calls.push(`click ${selector}`);
    },
    async fill(selector, value) {
      record.calls.push(`fill ${selector} ${value}`);
    },
    keyboard: {
      async press(key: string) {
        record.calls.push(`press ${key}`);
      },
      async type(value: string) {
        record.calls.push(`type ${value}`);
      },
    },
    mouse: {
      async move(x: number, y: number) {
        record.calls.push(`mouse move ${x} ${y}`);
      },
      async down(x: number, y: number, button: string) {
        record.calls.push(`mouse down ${x} ${y} ${button}`);
      },
      async up(x: number, y: number, button: string) {
        record.calls.push(`mouse up ${x} ${y} ${button}`);
      },
      async wheel(deltaY: number) {
        record.calls.push(`wheel ${deltaY}`);
      },
    },
    async goBack() {
      record.calls.push("back");
    },
    async screenshot(options) {
      record.calls.push(`shot ${String(options.type)} ${String(options.quality)}`);
      return new Uint8Array(2048).fill(7);
    },
    url: () => current,
    async close() {
      record.calls.push("close");
    },
    async waitForLoadState(state, options) {
      record.calls.push(`waitForLoadState ${state}`);
      if (options.timeout !== 2_000) {
        throw new Error(`unexpected load timeout ${String(options.timeout)}`);
      }
    },
    async setInputFiles(selector, path) {
      record.calls.push(`setInputFiles ${selector} ${path}`);
    },
    async waitForEvent(event, options) {
      record.calls.push(`waitForEvent ${event} ${String(options.timeout)}`);
      throw new Error("Timeout exceeded");
    },
  };
}

function fakeHandle(record: Recorded) {
  const pages: PageLike[] = [];
  return {
    pages,
    handle: {
      async newPage() {
        const page = fakePage(record);
        pages.push(page);
        return page;
      },
      async close() {
        record.calls.push("browser close");
      },
    },
  };
}

describe("createBrowserManager", () => {
  it("reuses one tab per session", async () => {
    const record: Recorded = { calls: [] };
    const { pages, handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    await manager.open("task-1", "https://a.example");
    await manager.open("task-1", "https://b.example");
    expect(pages).toHaveLength(1);
    expect(record.calls.filter((call) => call.startsWith("goto"))).toEqual([
      "goto https://a.example",
      "goto https://b.example",
    ]);
  });

  it("evicts the least recently used tab past the cap", async () => {
    const record: Recorded = { calls: [] };
    const { pages, handle } = fakeHandle(record);
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => handle,
      maxTabs: 2,
    });
    await manager.open("a", "https://a.example");
    await manager.open("b", "https://b.example");
    await manager.open("c", "https://c.example");
    expect(pages).toHaveLength(3);
    expect(record.calls).toContain("close");
  });

  it("clicks the tagged element and clears the tag", async () => {
    const record: Recorded = { calls: [] };
    const { handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    const snapshot = await manager.open("task-1", "https://a.example");
    await manager.act("task-1", "click", { target: snapshot.elements[0]!.ref });
    expect(record.calls).toContain("click [data-dw-hit]");
    expect(record.calls).toContain("evaluate untag");
  });

  it("rejects an unknown ref without touching the page", async () => {
    const record: Recorded = { calls: [] };
    const { handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    await manager.open("task-1", "https://a.example");
    await expect(manager.act("task-1", "click", { target: "e9" })).rejects.toMatchObject({
      code: "STALE_REF",
    });
    expect(record.calls).not.toContain("click [data-dw-hit]");
  });

  it("refuses an action on a session that has no tab", async () => {
    const record: Recorded = { calls: [] };
    const { handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    await expect(manager.act("ghost", "read")).rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("accepts a CSS selector as the target", async () => {
    const record: Recorded = { calls: [] };
    const { handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    await manager.open("task-1", "https://a.example");
    await manager.act("task-1", "click", { target: "button.primary" });
    // The selector path tags the hit and then clicks the tag, same as refs do.
    expect(record.calls).toContain("evaluate tag");
    expect(record.calls).toContain("click [data-dw-hit]");
  });

  it("relaunches once when the page died", async () => {
    const record: Recorded = { calls: [] };
    let launches = 0;
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => {
        launches += 1;
        const page = fakePage(record);
        if (launches === 1) {
          page.goto = async () => {
            throw new Error("Target page, context or browser has been closed");
          };
        }
        return {
          async newPage() {
            return page;
          },
          async close() {
            record.calls.push("browser close");
          },
        };
      },
    });
    await manager.open("task-1", "https://a.example");
    expect(launches).toBe(2);
  });

  it("serializes two calls on the same session", async () => {
    const record: Recorded = { calls: [] };
    const { handle } = fakeHandle(record);
    const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle });
    await manager.open("task-1", "https://a.example");
    const [first, second] = await Promise.all([
      manager.act("task-1", "read"),
      manager.act("task-1", "read"),
    ]);
    expect(first.url).toBe("https://a.example");
    expect(second.url).toBe("https://a.example");
    // Two collects per settled snapshot (open and each read) since settle re-reads
    // once to see the frame stop moving; both calls happened, one after the other.
    expect(record.calls.filter((call) => call === "evaluate collect")).toHaveLength(6);
  });

  it("reclaims idle tabs and then the browser", async () => {
    const record: Recorded = { calls: [] };
    let clock = 0;
    const { pages, handle } = fakeHandle(record);
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => handle,
      idleMs: 1_000,
      now: () => clock,
    });
    await manager.open("task-1", "https://a.example");
    clock = 5_000;
    await manager.sweep();
    expect(pages).toHaveLength(1);
    expect(record.calls).toContain("close");
    expect(record.calls).toContain("browser close");
  });

  it("refuses a screenshot over the size cap", async () => {
    const record: Recorded = { calls: [] };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({
        async newPage() {
          const page = fakePage(record);
          page.screenshot = async () => new Uint8Array(13 * 1024 * 1024);
          return page;
        },
        async close() {
          record.calls.push("browser close");
        },
      }),
    });
    await manager.open("task-1", "https://a.example");
    await expect(manager.shot("task-1")).rejects.toBeInstanceOf(BrowserError);
  });
});

function stubManager(
  over: Partial<Record<"open" | "act" | "shot" | "close", unknown>> = {},
) {
  const calls: string[] = [];
  const empty = { url: "https://a.example", title: "T", text: "hi", elements: [], truncated: { text: false, elements: false, filtered: 0 } };
  const manager = {
    open: async (session: string, url: string) => {
      calls.push(`open ${session} ${url}`);
      return empty;
    },
    act: async (session: string, action: string) => {
      calls.push(`act ${session} ${action}`);
      return empty;
    },
    shot: async (session: string) => {
      calls.push(`shot ${session}`);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1]);
    },
    close: async (session: string) => {
      calls.push(`close ${session}`);
    },
    sweep: async () => {},
    shutdown: async () => {},
    ...over,
  };
  return { manager, calls };
}

async function startBrowserd(manager: unknown): Promise<{ daemon: Sandboxd; base: string }> {
  const daemon = await startSandboxd(
    {
      token: "t",
      sandboxDir: tempDir(),
      version: "test",
      diskLimitBytes: 1024 * 1024,
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 1_000,
      browser: manager as never,
    },
    0,
  );
  return { daemon, base: `http://127.0.0.1:${String(daemon.port)}` };
}

const AUTH = { authorization: "Bearer t", "content-type": "application/json" };

// A real temp directory: the disk probe walks the sandbox dir on every request,
// and pointing it at /tmp makes the health check take minutes.
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskwand-browser-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function startPlain(): Promise<{ daemon: Sandboxd; base: string }> {
  const daemon = await startSandboxd(
    {
      token: "t",
      sandboxDir: tempDir(),
      version: "test",
      diskLimitBytes: 1024,
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 1_000,
    },
    0,
  );
  return { daemon, base: `http://127.0.0.1:${String(daemon.port)}` };
}

describe("browser endpoints", () => {
  it("advertises the feature on healthz", async () => {
    const { manager } = stubManager();
    const { daemon, base } = await startBrowserd(manager);
    try {
      const body = (await (
        await fetch(`${base}/healthz`, { headers: { authorization: "Bearer t" } })
      ).json()) as { features?: string[] };
      expect(body.features).toEqual([
        "browser",
        "browser-mirror",
        "browser-upload",
        "browser-download",
      ]);
    } finally {
      await daemon.close();
    }
  });

  it("omits the feature when no browser is configured", async () => {
    const { daemon, base } = await startPlain();
    try {
      const body = (await (
        await fetch(`${base}/healthz`, { headers: { authorization: "Bearer t" } })
      ).json()) as { features?: string[] };
      expect(body.features).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it("requires the token on browser endpoints", async () => {
    const { manager } = stubManager();
    const { daemon, base } = await startBrowserd(manager);
    try {
      const response = await fetch(`${base}/browser/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "t", url: "https://a.example" }),
      });
      expect(response.status).toBe(401);
    } finally {
      await daemon.close();
    }
  });

  it("opens a page and returns the snapshot", async () => {
    const { manager, calls } = stubManager();
    const { daemon, base } = await startBrowserd(manager);
    try {
      const response = await fetch(`${base}/browser/open`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "task-1", url: "https://a.example" }),
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual(["open task-1 https://a.example"]);
    } finally {
      await daemon.close();
    }
  });

  it("refuses a non-http url", async () => {
    const { manager, calls } = stubManager();
    const { daemon, base } = await startBrowserd(manager);
    try {
      const response = await fetch(`${base}/browser/open`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "t", url: "file:///etc/passwd" }),
      });
      expect(response.status).toBe(400);
      expect(calls).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it("maps a stale ref to 409", async () => {
    const { manager } = stubManager({
      act: async () => {
        throw new BrowserError("STALE_REF", "page moved — read it again");
      },
    });
    const { daemon, base } = await startBrowserd(manager);
    try {
      const response = await fetch(`${base}/browser/act`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "task-1", action: "click", target: "e1" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("STALE_REF");
    } finally {
      await daemon.close();
    }
  });

  it("maps a dead browser to 502 and an oversized shot to 413", async () => {
    const dead = stubManager({
      open: async () => {
        throw new BrowserError("BROWSER_DEAD", "gone");
      },
    });
    const first = await startBrowserd(dead.manager);
    try {
      const response = await fetch(`${first.base}/browser/open`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "t", url: "https://a.example" }),
      });
      expect(response.status).toBe(502);
    } finally {
      await first.daemon.close();
    }

    const big = stubManager({
      shot: async () => {
        throw new BrowserError("TOO_LARGE", "big");
      },
    });
    const second = await startBrowserd(big.manager);
    try {
      const response = await fetch(`${second.base}/browser/shot`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "t" }),
      });
      expect(response.status).toBe(413);
    } finally {
      await second.daemon.close();
    }
  });

  it("returns PNG bytes with an image content type", async () => {
    const { manager } = stubManager();
    const { daemon, base } = await startBrowserd(manager);
    try {
      const response = await fetch(`${base}/browser/shot`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "task-1" }),
      });
      expect(response.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await daemon.close();
    }
  });

  it("rejects a browser call when none is configured", async () => {
    const { daemon, base } = await startPlain();
    try {
      const response = await fetch(`${base}/browser/close`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ session: "t" }),
      });
      expect(response.status).toBe(503);
    } finally {
      await daemon.close();
    }
  });
});

describe("createBrowserManager resilience", () => {
  it("retries the read when a press destroyed the page context", async () => {
    const record: Recorded = { calls: [] };
    let destroys = 0;
    const base = fakePage(record);
    const flaky: PageLike = {
      ...base,
      async evaluate(source) {
        if (source.includes("return collect()") && destroys === 0) {
          destroys += 1;
          throw new Error("Execution context was destroyed, most likely because of a navigation");
        }
        return base.evaluate(source);
      },
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({
        async newPage() {
          return flaky;
        },
        async close() {
          record.calls.push("browser close");
        },
      }),
    });
    await manager.open("task-1", "https://a.example");
    const snapshot = await manager.act("task-1", "press", { key: "Enter" });
    expect(snapshot.url).toBe("https://a.example");
    expect(destroys).toBe(1);
  });

  it("reports a relaunch that fails again as a dead browser, not a closed page", async () => {
    const record: Recorded = { calls: [] };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({
        async newPage() {
          const page = fakePage(record);
          page.goto = async () => {
            throw new Error("Target page, context or browser has been closed");
          };
          return page;
        },
        async close() {
          record.calls.push("browser close");
        },
      }),
    });
    await expect(manager.open("task-1", "https://a.example")).rejects.toMatchObject({
      code: "BROWSER_DEAD",
      message: "browser restarted — open the page again",
    });
  });

  it("does not sweep a tab whose session has work in flight", async () => {
    const record: Recorded = { calls: [] };
    let clock = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakePage(record);
    const slow: PageLike = {
      ...base,
      async evaluate(source) {
        if (!source.includes("return collect()")) return base.evaluate(source);
        await gate;
        return base.evaluate(source);
      },
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({
        async newPage() {
          return slow;
        },
        async close() {
          record.calls.push("browser close");
        },
      }),
      idleMs: 1_000,
      now: () => clock,
    });
    const opening = manager.open("task-1", "https://a.example");
    clock = 5_000;
    await manager.sweep();
    expect(record.calls).not.toContain("close");
    release!();
    await opening;
    expect(record.calls).not.toContain("close");
  });
});

describe("identityFor", () => {
  it("turns the reported chromium version into a linux chrome identity", () => {
    const identity = identityFor("HeadlessChrome/141.0.7390.0", "zh");
    expect(identity.userAgent).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    );
    expect(identity.acceptLanguage).toBe("zh-CN");
    expect(JSON.stringify(identity.metadata.brands)).not.toContain("Headless");
  });

  it("refuses to invent a version", () => {
    expect(() => identityFor("HeadlessChrome", "en")).toThrow(/version/);
  });
});

describe("launchOptions", () => {
  it("drops the automation flag and keeps the container flags", () => {
    const options = launchOptions();
    expect(options.ignoreDefaultArgs).toEqual(["--enable-automation"]);
    expect(options.args).toContain("--disable-blink-features=AutomationControlled");
    expect(options.args).toContain("--no-sandbox");
  });
});

describe("identity applied to every tab", () => {
  it("sends one override per page, with no Headless brand", async () => {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const handle = {
      async newPage() {
        return fakePage(record);
      },
      async close() {
        record.calls.push("browser close");
      },
      async newCDPSession() {
        return cdpThatFrames(record);
      },
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => handle,
      locale: "zh",
    });
    await manager.open("a", "https://a.example");
    await manager.open("b", "https://b.example");
    const overrides = record.cdp!.filter(([method]) => method === "Network.setUserAgentOverride");
    expect(overrides).toHaveLength(2);
    for (const [, params] of overrides) {
      const typed = params as {
        userAgent: string;
        acceptLanguage: string;
        userAgentMetadata: { brands: { brand: string }[] };
      };
      expect(typed.userAgent).not.toContain("Headless");
      expect(typed.acceptLanguage).toBe("zh-CN");
      expect(typed.userAgentMetadata.brands.map((brand) => brand.brand).join()).not.toContain("Headless");
    }
    // One version read is enough for the whole browser.
    expect(record.cdp!.filter(([method]) => method === "Browser.getVersion")).toHaveLength(1);
  });
});

function cdpThatFrames(record: Recorded) {
  const listeners = new Map<string, ((params: Record<string, any>) => void)[]>();
  return {
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      record.cdp?.push([method, params ?? {}]);
      if (method === "Browser.getVersion") {
        return { product: "HeadlessChrome/141.0.7390.0" } as T;
      }
      return {} as T;
    },
    on(event: string, listener: (params: Record<string, any>) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event: string, listener: (params: Record<string, any>) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
    },
    fire(event: string, params: Record<string, any>) {
      for (const listener of listeners.get(event) ?? []) listener(params);
    },
    count(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

function mirrorManager(
  record: Recorded,
  extra: { maxTabs?: number; idleMs?: number; now?: () => number } = {},
) {
  const cdp = cdpThatFrames(record);
  const { handle, pages } = fakeHandle(record);
  (handle as unknown as { newCDPSession?: unknown }).newCDPSession = async () => cdp;
  const manager = createBrowserManager({ userDataDir: "/tmp/x", launch: async () => handle, ...extra });
  return { manager, pages, cdp };
}

describe("mirror endpoints", () => {
  async function sandboxWithMirror() {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager, cdp } = mirrorManager(record);
    const { daemon, base } = await startBrowserd(manager);
    return { sandboxd: daemon, base, cdp };
  }

  it("advertises the feature", async () => {
    const { sandboxd, base } = await sandboxWithMirror();
    const response = await fetch(`${base}/healthz`, { headers: { authorization: "Bearer t" } });
    expect(((await response.json()) as { features: string[] }).features).toContain("browser-mirror");
    await sandboxd.close();
  });

  it("streams a frame over sse and closes", async () => {
    const { sandboxd, base } = await sandboxWithMirror();
    const opened = await fetch(`${base}/browser/mirror/open`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://a.example" }),
    });
    expect(await opened.json()).toMatchObject({ viewport: { width: 1280, height: 800 } });

    const stream = await fetch(`${base}/browser/mirror`, {
      headers: { authorization: "Bearer t" },
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    // The replayed frame is the first body write, which also flushes headers.
    expect(new TextDecoder().decode(first.value)).toContain("event: frame");
    await reader.cancel();

    const closed = await fetch(`${base}/browser/mirror/close`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(await closed.json()).toEqual({ ok: true });
    await sandboxd.close();
  });

  it("attaches to the live tab when the panel sends no url", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    const { daemon, base } = await startBrowserd(manager);
    // Open a page the way a task would, then ask for "whatever is on screen".
    await fetch(`${base}/browser/open`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ session: "task-1", url: "https://a.example" }),
    });
    const opened = await fetch(`${base}/browser/mirror/open`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(await opened.json()).toMatchObject({ url: "https://a.example" });
    await daemon.close();
  });

  it("answers an empty url when nothing is open", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    const { daemon, base } = await startBrowserd(manager);
    const opened = await fetch(`${base}/browser/mirror/open`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(await opened.json()).toMatchObject({ url: "" });
    await daemon.close();
  });

  it("refuses a non-http url and an unknown mirror path", async () => {
    const { sandboxd, base } = await sandboxWithMirror();
    const bad = await fetch(`${base}/browser/mirror/open`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/browser/mirror/nope`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
    await sandboxd.close();
  });
});

describe("mirror attaches to the live tab", () => {
  it("shows the tab a task is using, without asking for a url", async () => {
    const record: Recorded = { calls: [] };
    const { manager, pages } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    expect(await manager.mirror.open()).toMatchObject({ url: "https://a.example" });
    // Borrowed, not created: the pool still holds exactly one page.
    expect(pages).toHaveLength(1);
  });

  it("says nothing is open when no tab is alive", async () => {
    const record: Recorded = { calls: [] };
    const { manager, pages } = mirrorManager(record);
    expect(await manager.mirror.open()).toMatchObject({ url: "" });
    expect(pages).toHaveLength(0);
    expect(await manager.mirror.input(0, [])).toEqual({ ok: false, code: "NO_MIRROR" });
  });

  it("does not open a blank page for a tab that was already swept", async () => {
    const record: Recorded = { calls: [] };
    let clock = 0;
    const { manager, pages } = mirrorManager(record, { idleMs: 600_000, now: () => clock });
    await manager.open("task-1", "https://a.example");
    clock = 700_000;
    await manager.sweep();
    expect(await manager.mirror.open()).toMatchObject({ url: "" });
    expect(pages).toHaveLength(1);
  });

  it("does not close the task page when the panel closes", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.mirror.open();
    await manager.mirror.close();
    expect(record.calls.filter((call) => call === "close")).toHaveLength(0);
    await expect(manager.act("task-1", "read")).resolves.toBeDefined();
  });

  it("follows the agent to a tab it reuses, not just one it creates", async () => {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager, cdp } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.open("task-2", "https://b.example");
    await manager.mirror.open();
    const seen: MirrorEvent[] = [];
    manager.mirror.subscribe((event) => seen.push(event));
    // "task-1" already exists: this is the early-return path in tab().
    await manager.open("task-1", "https://a.example/again");
    // The url reaches the panel with the next painted frame, which is what the
    // real browser sends right after a navigation.
    cdp.fire("Page.screencastFrame", {
      data: "/9j/AAAA",
      sessionId: 3,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    expect(seen.filter((event) => event.type === "state").at(-1)).toEqual({
      type: "state",
      url: "https://a.example/again",
    });
  });

  it("follows the agent when it acts on another tab", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.open("task-2", "https://b.example");
    await manager.mirror.open();
    const seen: MirrorEvent[] = [];
    manager.mirror.subscribe((event) => seen.push(event));
    // need(), not tab(): this is the act path.
    await manager.act("task-1", "read");
    expect(seen.filter((event) => event.type === "state").at(-1)).toEqual({
      type: "state",
      url: "https://a.example",
    });
  });

  it("still opens the url a human types, and owns that tab", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.mirror.open("https://c.example");
    await manager.mirror.close();
    // Only the panel's own tab may be closed; the task page stays.
    expect(record.calls.filter((call) => call === "close")).toHaveLength(1);
    await expect(manager.act("task-1", "read")).resolves.toBeDefined();
  });

  it("keeps one screencast when two switches overlap", async () => {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager, cdp } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.open("task-2", "https://b.example");
    await manager.mirror.open();
    // Two task tabs at once would otherwise run two attaches concurrently and
    // leak the losing CDP session's screencast.
    await Promise.all([
      manager.act("task-1", "read"),
      manager.act("task-2", "read"),
    ]);
    expect(cdp.count("Page.screencastFrame")).toBe(1);
    expect(record.cdp!.filter(([method]) => method === "Page.startScreencast")).toHaveLength(2);
  });

  it("tells the panel when the agent closes the page it is watching", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.mirror.open();
    const seen: MirrorEvent[] = [];
    manager.mirror.subscribe((event) => seen.push(event));
    await manager.close("task-1");
    expect(seen).toContainEqual({ type: "end", reason: "closed" });
    expect(await manager.mirror.input(0, [])).toEqual({ ok: false, code: "NO_MIRROR" });
  });

  it("closes the panel's own page even after the view followed the agent", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.open("task-1", "https://a.example");
    await manager.mirror.open("https://c.example");
    await manager.act("task-1", "read"); // the view follows the task page
    await manager.mirror.close();
    // One close: the panel's page. The task page stays.
    expect(record.calls.filter((call) => call === "close")).toHaveLength(1);
    await expect(manager.act("task-1", "read")).resolves.toBeDefined();
  });

  it("keeps a watched tab out of the idle sweep", async () => {
    const record: Recorded = { calls: [] };
    let clock = 0;
    const { manager } = mirrorManager(record, { idleMs: 600_000, now: () => clock });
    await manager.open("task-1", "https://a.example");
    await manager.mirror.open();
    const off = manager.mirror.subscribe(() => {});
    clock = 900_000;
    await manager.sweep();
    expect(record.calls).not.toContain("close");
    off();
  });
});

describe("mirror lifecycle", () => {
  it("answers NO_MIRROR before anything is open", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    expect(await manager.mirror.input(0, [])).toEqual({ ok: false, code: "NO_MIRROR" });
  });

  it("replays the current frame and url to a subscriber that arrives late", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    const seen: MirrorEvent[] = [];
    const off = manager.mirror.subscribe((event) => seen.push(event));
    off();
    // The stream connects after the POST that opened the page: without a replay
    // the panel would stay black until the page happens to change.
    expect(seen[0]).toMatchObject({ type: "frame", seq: 1, w: 1280, h: 800 });
    expect(seen).toContainEqual({ type: "state", url: "https://a.example" });
  });

  it("replaces the old session and tells it why", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    const seen: MirrorEvent[] = [];
    manager.mirror.subscribe((event) => seen.push(event));
    await manager.mirror.open("https://b.example");
    expect(seen).toContainEqual({ type: "end", reason: "superseded" });
  });

  it("closes the tab immediately on close", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    await manager.mirror.close();
    expect(record.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(await manager.mirror.input(0, [])).toEqual({ ok: false, code: "NO_MIRROR" });
  });

  it("starts the idle window when the stream ends, not at the last click", async () => {
    const record: Recorded = { calls: [] };
    let clock = 0;
    const { manager } = mirrorManager(record, { idleMs: 600_000, now: () => clock });
    await manager.mirror.open("https://a.example");
    const closed = () => record.calls.filter((call) => call === "close").length;
    clock = 400_000;
    const off = manager.mirror.subscribe(() => {});
    off(); // the owner closed the panel at 400s
    clock = 900_000; // 500s later: still inside the window
    await manager.sweep();
    expect(closed()).toBe(0);
    clock = 1_000_001; // 600s + 1ms after the drop
    await manager.sweep();
    expect(closed()).toBe(1);
  });

  it("counts the takeover tab against the cap and evicts the oldest task tab", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record, { maxTabs: 2 });
    await manager.open("a", "https://a.example");
    await manager.open("b", "https://b.example");
    await manager.mirror.open("https://c.example");
    // Equal usedAt means insertion order decides: "a" is the oldest.
    await expect(manager.act("a", "read")).rejects.toMatchObject({ code: "NO_SESSION" });
    await expect(manager.act("b", "read")).resolves.toBeDefined();
  });

  it("forwards a click as a down and an up on the page", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    expect(
      await manager.mirror.input(1, [
        { type: "mouse", kind: "down", x: 100, y: 50, button: "left" },
        { type: "mouse", kind: "up", x: 100, y: 50, button: "left" },
      ]),
    ).toEqual({ ok: true });
    expect(record.calls).toContain("mouse down 100 50 left");
    expect(record.calls).toContain("mouse up 100 50 left");
  });

  it("refuses input from a frame that scrolled out of the window", async () => {
    const record: Recorded = { calls: [] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    // The open snapshot is frame 1, so 60 frames behind is exactly the edge.
    expect(await manager.mirror.input(-100, [])).toEqual({ ok: false, code: "STALE" });
    expect(await manager.mirror.input(1 - 60, [])).toEqual({ ok: true });
    expect(await manager.mirror.input(1 - 61, [])).toEqual({ ok: false, code: "STALE" });
  });
});

describe("mirror frames", () => {
  async function openWithFrames() {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager, pages, cdp } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    const seen: MirrorEvent[] = [];
    manager.mirror.subscribe((event) => seen.push(event));
    return { record, cdp, manager, seen, page: pages[0]! };
  }

  it("starts the screencast and acks every frame", async () => {
    const { record, cdp, seen } = await openWithFrames();
    expect(record.cdp?.some(([method]) => method === "Page.startScreencast")).toBe(true);
    cdp.fire("Page.screencastFrame", {
      data: "/9j/AAAA",
      sessionId: 7,
      metadata: { deviceWidth: 640, deviceHeight: 400 },
    });
    const frames = seen.filter((event) => event.type === "frame");
    expect(frames.at(-1)).toMatchObject({ type: "frame", jpeg: "/9j/AAAA", w: 640, h: 400 });
    expect(record.cdp).toContainEqual(["Page.screencastFrameAck", { sessionId: 7 }]);
  });

  it("drops the screencast listener when the session ends", async () => {
    const { cdp, manager } = await openWithFrames();
    expect(cdp.count("Page.screencastFrame")).toBe(1);
    await manager.mirror.close();
    expect(cdp.count("Page.screencastFrame")).toBe(0);
  });

  it("reports the url once per navigation", async () => {
    const { cdp, seen, page } = await openWithFrames();
    const before = seen.filter((event) => event.type === "state").length;
    await page.goto("https://b.example", { timeout: 1_000, waitUntil: "domcontentloaded" });
    cdp.fire("Page.screencastFrame", {
      data: "/9j/AAAB",
      sessionId: 8,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    cdp.fire("Page.screencastFrame", {
      data: "/9j/AAAC",
      sessionId: 9,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    const states = seen.filter((event) => event.type === "state");
    expect(states).toHaveLength(before + 1);
    expect(states.at(-1)).toEqual({ type: "state", url: "https://b.example" });
  });
});

describe("mirror coordinates", () => {
  async function openFramed() {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager, cdp } = mirrorManager(record);
    await manager.mirror.open("https://a.example");
    // A 640x400 frame for a 1280x800 viewport: the screencast downscaled.
    cdp.fire("Page.screencastFrame", {
      data: "/9j/AAAA",
      sessionId: 1,
      metadata: { deviceWidth: 640, deviceHeight: 400 },
    });
    return { manager, record };
  }

  it("scales frame coordinates back to css pixels", async () => {
    const { manager, record } = await openFramed();
    await manager.mirror.input(2, [
      { type: "mouse", kind: "down", x: 320, y: 200, button: "left" },
      { type: "mouse", kind: "up", x: 320, y: 200, button: "left" },
    ]);
    expect(record.calls).toContain("mouse down 640 400 left");
    expect(record.calls).toContain("mouse up 640 400 left");
  });

  it("clamps a click outside the frame instead of throwing", async () => {
    const { manager, record } = await openFramed();
    await manager.mirror.input(2, [{ type: "mouse", kind: "down", x: 9999, y: -10, button: "left" }]);
    expect(record.calls).toContain("mouse down 1280 0 left");
  });

  it("leaves wheel and keys alone", async () => {
    const { manager, record } = await openFramed();
    await manager.mirror.input(2, [
      { type: "mouse", kind: "wheel", x: 0, y: 0, deltaY: 120 },
      { type: "key", kind: "text", text: "你好" },
      { type: "key", kind: "press", key: "Enter" },
    ]);
    expect(record.calls).toContain("wheel 120");
    expect(record.calls).toContain("type 你好");
    expect(record.calls).toContain("press Enter");
  });
});

function fakeDownload(record: Recorded, size: number) {
  return {
    suggestedFilename: () => "../../evil name.pdf",
    async saveAs(path: string) {
      record.calls.push(`saveAs ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(size));
    },
  };
}

describe("open waits for load", () => {
  it("asks for load after domcontentloaded and before reading the page", async () => {
    const record: Recorded = { calls: [] };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => fakePage(record), close: async () => {} }),
    });
    await manager.open("a", "https://a.example");
    expect(record.calls.slice(0, 3)).toEqual([
      "goto https://a.example",
      "waitForLoadState load",
      "evaluate collect",
    ]);
  });

  it("returns the snapshot even when load times out", async () => {
    const record: Recorded = { calls: [] };
    const page = fakePage(record);
    page.waitForLoadState = async () => {
      throw new Error("Timeout 2000ms exceeded");
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    const snapshot = await manager.open("a", "https://a.example");
    expect(snapshot.url).toBe("https://a.example");
  });
});

describe("collectSettled", () => {
  it("keeps reading until two frames agree", async () => {
    const record: Recorded = { calls: [] };
    const page = fakePage(record, { snapshots: ["one", "two", "two"] });
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    const snapshot = await manager.open("a", "https://a.example");
    expect(snapshot.elements[0]!.name).toBe("two");
    expect(record.calls.filter((call) => call === "evaluate collect")).toHaveLength(3);
  });

  it("returns the last frame when the page never settles", async () => {
    const record: Recorded = { calls: [] };
    const page = fakePage(record, { snapshots: ["one", "two", "three", "four"] });
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    const snapshot = await manager.open("a", "https://a.example");
    expect(snapshot.elements[0]!.name).toBe("three");
    expect(record.calls.filter((call) => call === "evaluate collect")).toHaveLength(3);
  });

  it("keeps the last good frame when a later read throws", async () => {
    const record: Recorded = { calls: [] };
    let reads = 0;
    const page = fakePage(record, { snapshots: ["one", "two"] });
    const original = page.evaluate;
    page.evaluate = async (source) => {
      if (source.includes("return collect()")) {
        reads += 1;
        if (reads >= 3) throw new Error("Execution context was destroyed");
      }
      return original(source);
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    const snapshot = await manager.open("a", "https://a.example");
    expect(snapshot.elements[0]!.name).toBe("two");
  });
});

describe("upload", () => {
  it("tags a file input and hands it the path", async () => {
    const record: Recorded = { calls: [] };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => fakePage(record), close: async () => {} }),
    });
    await manager.open("a", "https://a.example");
    await manager.upload("a", { target: "input[type=file]", path: "/tmp/dw-uploads/x/a.csv" });
    expect(record.calls).toContain("setInputFiles [data-dw-hit] /tmp/dw-uploads/x/a.csv");
    expect(record.calls.filter((call) => call === "evaluate untag")).toHaveLength(1);
  });

  it("refuses when nothing matched the target", async () => {
    const record: Recorded = { calls: [] };
    const page = fakePage(record);
    const original = page.evaluate;
    page.evaluate = async (source) => {
      if (source.includes("data-dw-hit") && source.includes("input[type=file]")) return false;
      return original(source);
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    await manager.open("a", "https://a.example");
    await expect(
      manager.upload("a", { target: "input[type=file]", path: "/tmp/x" }),
    ).rejects.toThrow(/no file input/);
  });
});

describe("download", () => {
  it("arms the wait before clicking, then reports name, size and path", async () => {
    const record: Recorded = { calls: [] };
    const page = fakePage(record);
    page.waitForEvent = async (event) => {
      record.calls.push(`waitForEvent ${event}`);
      return fakeDownload(record, 1234);
    };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => page, close: async () => {} }),
    });
    await manager.open("a", "https://a.example");
    const result = await manager.download("a", "e1");
    const armed = record.calls.indexOf("waitForEvent download");
    const clicked = record.calls.indexOf("click [data-dw-hit]");
    expect(armed).toBeGreaterThanOrEqual(0);
    expect(clicked).toBeGreaterThan(armed);
    expect(result.name).toBe("evil name.pdf");
    expect(result.size).toBe(1234);
    expect(result.path.startsWith("/tmp/dw-downloads/")).toBe(true);
    expect(result.path).not.toContain("..");
  });

  it("turns a timeout into a plain instruction", async () => {
    const record: Recorded = { calls: [] };
    const manager = createBrowserManager({
      userDataDir: "/tmp/x",
      launch: async () => ({ newPage: async () => fakePage(record), close: async () => {} }),
    });
    await manager.open("a", "https://a.example");
    await expect(manager.download("a", "e1")).rejects.toThrow(/did not start a download/);
  });
});

describe("temp sweep", () => {
  it("removes hour-old directories and keeps fresh ones", async () => {
    mkdirSync("/tmp/dw-downloads", { recursive: true });
    const stamp = String(process.pid);
    const stale = `/tmp/dw-downloads/stale-${stamp}`;
    const fresh = `/tmp/dw-downloads/fresh-${stamp}`;
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    await sweepTemp(Date.now());

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("frame budget", () => {
  it("streams at the smaller quality and width, and snapshots at the same quality", async () => {
    const record: Recorded = { calls: [], cdp: [] as unknown[][] };
    const { manager } = mirrorManager(record);
    await manager.mirror.open("https://a.example");

    const start = record.cdp!.find(([method]) => method === "Page.startScreencast");
    expect(start?.[1]).toMatchObject({
      format: "jpeg",
      quality: 50,
      maxWidth: 1024,
      maxHeight: 640,
    });
    // The first frame must not be sharper than the stream that follows it.
    expect(record.calls).toContain("shot jpeg 50");
  });
});
