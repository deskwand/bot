import {
  buildSnapshot,
  collectScript,
  refTable,
  resolveTarget,
  isRef,
  tagScript,
  tagSelectorScript,
  UNTAG_SOURCE,
  type RawSnapshot,
  type RefTable,
  type Snapshot,
} from "./browser-snapshot.js";

export const DEFAULT_MAX_TABS = 3;
export const DEFAULT_IDLE_MS = 600_000;
const ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_GOTO_TIMEOUT_MS = 30_000;
const MAX_SHOT_BYTES = 12 * 1024 * 1024;

export type BrowserErrorCode =
  | "STALE_REF"
  | "NO_SESSION"
  | "BROWSER_DEAD"
  | "TOO_LARGE"
  | "BAD_REQUEST";

export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
  }
}

export type ActAction = "click" | "fill" | "press" | "back" | "read";

export type ActArgs = { target?: string; text?: string; key?: string };

export type PageLike = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  goBack(options: { timeout: number }): Promise<unknown>;
  screenshot(options: { type: "png"; fullPage: boolean }): Promise<Uint8Array>;
  url(): string;
  close(): Promise<void>;
};

export type BrowserHandle = { newPage(): Promise<PageLike>; close(): Promise<void> };

export type BrowserManager = {
  open(session: string, url: string, timeoutMs?: number): Promise<Snapshot>;
  act(session: string, action: ActAction, args?: ActArgs): Promise<Snapshot>;
  shot(session: string, fullPage?: boolean): Promise<Uint8Array>;
  close(session: string): Promise<void>;
  sweep(at?: number): Promise<void>;
  shutdown(): Promise<void>;
};

export type BrowserManagerOptions = {
  userDataDir: string;
  launch?: () => Promise<BrowserHandle>;
  maxTabs?: number;
  idleMs?: number;
  now?: () => number;
};

/** Errors Playwright throws when the page or the whole browser went away. */
const CLOSED = /has been closed|browser has disconnected|Target (page|closed)|Connection closed/i;

/** Errors Playwright throws when the page navigated out from under a script. */
const DESTROYED = /Execution context was destroyed|Cannot find context|detached Frame/i;

/**
 * `playwright-core` lives in the sandbox image, not in this package: importing
 * it statically would make every test and typecheck need it. The image installs
 * it beside the bundle, so a runtime dynamic import resolves there.
 */
type PersistentContext = { newPage(): Promise<PageLike>; close(): Promise<void> };
type Chromium = {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<PersistentContext>;
};

async function loadChromium(): Promise<Chromium> {
  const specifier = "playwright-core";
  // Node's CJS interop may put the named export on the module or behind
  // `default`; guessing one of them fails only inside the image.
  const loaded = (await import(specifier)) as {
    chromium?: Chromium;
    default?: { chromium: Chromium };
  };
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (chromium === undefined) {
    throw new Error("playwright-core did not export chromium — the sandbox image is out of date");
  }
  return chromium;
}

function launchPersistent(userDataDir: string): () => Promise<BrowserHandle> {
  return async () => {
    const chromium = await loadChromium();
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
      ],
    });
    return {
      newPage: () => context.newPage(),
      close: () => context.close(),
    };
  };
}

type Tab = { page: PageLike; table: RefTable; usedAt: number };

export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  const launch = options.launch ?? launchPersistent(options.userDataDir);
  const maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? (() => Date.now());

  let handle: BrowserHandle | null = null;
  let lastUse = 0;
  const tabs = new Map<string, Tab>();
  const chains = new Map<string, Promise<unknown>>();
  /** Sessions with work in flight; the sweeper must not close their tabs. */
  const active = new Set<string>();

  async function ensureHandle(): Promise<BrowserHandle> {
    if (handle === null) handle = await launch();
    lastUse = now();
    return handle;
  }

  async function dropHandle(): Promise<void> {
    const dying = handle;
    handle = null;
    tabs.clear();
    if (dying !== null) await dying.close().catch(() => {});
  }

  /** One silent relaunch per call; a browser that dies twice is not coming back. */
  async function retryOnce<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!CLOSED.test(error instanceof Error ? error.message : String(error))) throw error;
      await dropHandle();
      try {
        return await run();
      } catch (again) {
        const message = again instanceof Error ? again.message : String(again);
        // Either the relaunch died the same way, or the cleared tabs turned the
        // retry into "no session". Both mean the browser is gone; anything else
        // (a timeout, a bad url) keeps its own error.
        const lostPage =
          again instanceof BrowserError ? again.code === "NO_SESSION" : CLOSED.test(message);
        if (!lostPage) throw again;
        throw new BrowserError("BROWSER_DEAD", "browser restarted — open the page again");
      }
    }
  }

  async function collect(page: PageLike): Promise<Snapshot> {
    const raw = (await page.evaluate(collectScript())) as RawSnapshot;
    return buildSnapshot(raw);
  }

  /**
   * A `press` or `click` can start a navigation that is still tearing down the
   * document when we read it. One short retry covers that; anything else is a
   * real failure.
   */
  async function collectSettled(page: PageLike): Promise<Snapshot> {
    try {
      return await collect(page);
    } catch (error) {
      if (!DESTROYED.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return collect(page);
    }
  }

  async function tab(session: string): Promise<Tab> {
    const existing = tabs.get(session);
    if (existing !== undefined) {
      // Touch on reuse: a slow goto on a cold tab must not look idle to sweep().
      existing.usedAt = now();
      return existing;
    }
    if (tabs.size >= maxTabs) {
      const oldest = [...tabs.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (oldest !== undefined) {
        tabs.delete(oldest[0]);
        await oldest[1].page.close().catch(() => {});
      }
    }
    const browser = await ensureHandle();
    const page = await browser.newPage();
    const created: Tab = { page, table: new Map(), usedAt: now() };
    tabs.set(session, created);
    return created;
  }

  /** One promise chain per session: two tools must not drive one page at once. */
  function serial<T>(session: string, run: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      active.add(session);
      try {
        return await run();
      } finally {
        active.delete(session);
      }
    };
    const previous = chains.get(session) ?? Promise.resolve();
    const next = previous.then(guarded, guarded);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(session, settled);
    // Self-pruning: one entry per task would otherwise live as long as the
    // container does.
    void settled.then(() => {
      if (chains.get(session) === settled) chains.delete(session);
    });
    return next;
  }

  function need(session: string): Tab {
    const current = tabs.get(session);
    if (current === undefined) {
      throw new BrowserError("NO_SESSION", "page was closed — open it again");
    }
    current.usedAt = now();
    lastUse = current.usedAt;
    return current;
  }

  async function actOn(current: Tab, action: ActAction, args: ActArgs): Promise<Snapshot> {
    if (action === "back") {
      await current.page.goBack({ timeout: ACTION_TIMEOUT_MS });
    } else if (action === "press") {
      if (args.key === undefined || args.key === "") {
        throw new BrowserError("BAD_REQUEST", "press needs a key");
      }
      await current.page.keyboard.press(args.key);
    } else if (action !== "read") {
      const target = args.target ?? "";
      if (target === "") throw new BrowserError("BAD_REQUEST", `${action} needs a target`);
      const live = await collect(current.page);
      if (isRef(target)) {
        const resolved = resolveTarget(current.table, target, live.elements);
        if (!resolved.ok) {
          throw new BrowserError(
            "STALE_REF",
            resolved.reason === "ambiguous"
              ? "page has several identical elements — pass a CSS selector instead"
              : "page moved — read it again",
          );
        }
        const wanted = current.table.get(target)!;
        if ((await current.page.evaluate(tagScript(wanted))) !== true) {
          throw new BrowserError("STALE_REF", "page moved — read it again");
        }
      } else if ((await current.page.evaluate(tagSelectorScript(target))) !== true) {
        throw new BrowserError("STALE_REF", "no visible element matches that selector");
      }
      try {
        if (action === "click") {
          await current.page.click("[data-dw-hit]", { timeout: ACTION_TIMEOUT_MS });
        } else {
          await current.page.fill("[data-dw-hit]", args.text ?? "");
        }
      } finally {
        await current.page.evaluate(UNTAG_SOURCE).catch(() => {});
      }
    }
    const snapshot = await collectSettled(current.page);
    current.table = refTable(snapshot);
    return snapshot;
  }

  return {
    open(session, url, timeoutMs = DEFAULT_GOTO_TIMEOUT_MS) {
      return serial(session, () =>
        retryOnce(async () => {
          const current = await tab(session);
          await current.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
          const snapshot = await collectSettled(current.page);
          current.table = refTable(snapshot);
          current.usedAt = now();
          return snapshot;
        }),
      );
    },

    act(session, action, args = {}) {
      return serial(session, () => retryOnce(async () => actOn(need(session), action, args)));
    },

    shot(session, fullPage = false) {
      return serial(session, () =>
        retryOnce(async () => {
          const current = need(session);
          const bytes = await current.page.screenshot({ type: "png", fullPage });
          if (bytes.byteLength > MAX_SHOT_BYTES) {
            throw new BrowserError("TOO_LARGE", "screenshot is over 12 MB — turn fullPage off");
          }
          return bytes;
        }),
      );
    },

    close(session) {
      return serial(session, async () => {
        const current = tabs.get(session);
        if (current === undefined) return;
        tabs.delete(session);
        await current.page.close().catch(() => {});
      });
    },

    async sweep(at = now()) {
      for (const [session, current] of [...tabs]) {
        if (active.has(session)) continue;
        if (at - current.usedAt < idleMs) continue;
        tabs.delete(session);
        await current.page.close().catch(() => {});
      }
      if (tabs.size === 0 && handle !== null && at - lastUse >= idleMs) await dropHandle();
    },

    async shutdown() {
      await dropHandle();
    },
  };
}
