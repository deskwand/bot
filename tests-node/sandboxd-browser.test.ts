import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

import { BrowserError, createBrowserManager, type PageLike } from "../container/sandbox/browser.js";
import { startSandboxd, type Sandboxd } from "../container/sandbox/server.js";

type Recorded = { calls: string[] };

function fakePage(record: Recorded, options: { url?: string } = {}): PageLike {
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
        return {
          url: current,
          title: "T",
          text: "hello",
          elements: [{ role: "button", name: "Go" }],
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
    },
    async goBack() {
      record.calls.push("back");
    },
    async screenshot(options) {
      record.calls.push(`shot ${String(options.fullPage)}`);
      return new Uint8Array(2048).fill(7);
    },
    url: () => current,
    async close() {
      record.calls.push("close");
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
    // One collect for open, one per read: both happened, one after the other.
    expect(record.calls.filter((call) => call === "evaluate collect")).toHaveLength(3);
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
      expect(body.features).toEqual(["browser"]);
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
