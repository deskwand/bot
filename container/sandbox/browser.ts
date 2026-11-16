import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  identityFor,
  launchOptions,
  VIEWPORT,
  type Identity,
} from "./browser-identity.js";
import {
  buildSnapshot,
  collectScript,
  fingerprint,
  refTable,
  resolveTarget,
  isRef,
  tagFileInputScript,
  tagFileSelectorScript,
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

export type UploadArgs = { target: string; path: string };

export type DownloadLike = {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
};

export type DownloadResult = {
  name: string;
  size: number;
  path: string;
  snapshot: Snapshot;
};

export type Mouse = {
  move(x: number, y: number): Promise<void>;
  down(x: number, y: number, button: "left" | "right"): Promise<void>;
  up(x: number, y: number, button: "left" | "right"): Promise<void>;
  wheel(deltaY: number): Promise<void>;
};

export type PageLike = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  mouse: Mouse;
  goBack(options: { timeout: number }): Promise<unknown>;
  screenshot(options: {
    type: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
  }): Promise<Uint8Array>;
  url(): string;
  close(): Promise<void>;
  /** Absent in test fakes; a real page always has them. */
  waitForLoadState?(state: "load", options: { timeout: number }): Promise<void>;
  setInputFiles?(selector: string, path: string): Promise<void>;
  waitForEvent?(event: "download", options: { timeout: number }): Promise<DownloadLike>;
};

export type CdpSession = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, listener: (params: Record<string, any>) => void): void;
  off(event: string, listener: (params: Record<string, any>) => void): void;
};

export type BrowserHandle = {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  /** Absent in tests that need neither identity nor a screencast. */
  newCDPSession?(page: PageLike): Promise<CdpSession>;
};

/** The tab the panel owns when a human types a url; task tabs are only borrowed. */
export const PANEL_SESSION = "panel";

/** A frame older than this many frames behind the newest one is not worth clicking. */
const STALE_FRAMES = 60;

/**
 * The first frame and the screencast read the same pair: a snapshot at another
 * quality makes the first paint look different from the stream behind it.
 */
const FRAME_QUALITY = 50;
const FRAME_MAX_WIDTH = 1024;
const FRAME_MAX_HEIGHT = Math.round((FRAME_MAX_WIDTH * VIEWPORT.height) / VIEWPORT.width);

export type MirrorEvent =
  | { type: "frame"; seq: number; jpeg: string; w: number; h: number }
  | { type: "state"; url: string }
  | { type: "end"; reason: "closed" | "superseded" | "timeout" };

export type MirrorInput =
  | {
      type: "mouse";
      kind: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button?: "left" | "right";
      deltaY?: number;
    }
  | { type: "key"; kind: "text" | "press"; text?: string; key?: string };

export type MirrorResult = { ok: true } | { ok: false; code: "STALE" | "NO_MIRROR" };

/**
 * The tab a human drives by hand. Deliberately not a task tab: a task's tab is
 * swept when it ends, and the owner may read the message hours later.
 */
export type Mirror = {
  open(url?: string, timeoutMs?: number): Promise<{ url: string; title: string }>;
  subscribe(emit: (event: MirrorEvent) => void): () => void;
  input(seq: number, events: MirrorInput[]): Promise<MirrorResult>;
  close(): Promise<void>;
};

export type BrowserManager = {
  open(session: string, url: string, timeoutMs?: number): Promise<Snapshot>;
  act(session: string, action: ActAction, args?: ActArgs): Promise<Snapshot>;
  upload(session: string, args: UploadArgs): Promise<Snapshot>;
  download(session: string, target: string, timeoutMs?: number): Promise<DownloadResult>;
  shot(session: string, fullPage?: boolean): Promise<Uint8Array>;
  close(session: string): Promise<void>;
  sweep(at?: number): Promise<void>;
  shutdown(): Promise<void>;
  mirror: Mirror;
};

export type BrowserManagerOptions = {
  userDataDir: string;
  launch?: () => Promise<BrowserHandle>;
  maxTabs?: number;
  idleMs?: number;
  now?: () => number;
  locale?: string;
};

/** Errors Playwright throws when the page or the whole browser went away. */
const CLOSED = /has been closed|browser has disconnected|Target (page|closed)|Connection closed/i;

/** Errors Playwright throws when the page navigated out from under a script. */
const DESTROYED = /Execution context was destroyed|Cannot find context|detached Frame/i;

/** `load` is a bonus, not a requirement: one slow image must not fail the open. */
const LOAD_SETTLE_MS = 2_000;
const SETTLE_READS = 3;
const SETTLE_DELAY_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TEMP_DIRS = ["/tmp/dw-uploads", "/tmp/dw-downloads"];
const TEMP_TTL_MS = 60 * 60 * 1000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForLoad(page: PageLike): Promise<void> {
  try {
    await page.waitForLoadState?.("load", { timeout: LOAD_SETTLE_MS });
  } catch {
    // The snapshot that follows is what the caller actually needs.
  }
}

/** `url` plus element identity: text changes on any clock and proves nothing. */
function frameKey(snapshot: Snapshot): string {
  return `${snapshot.url}\u0000${snapshot.elements.map((element) => fingerprint(element)).join(",")}`;
}

/** Keep the name usable and the path inside its own temp directory. */
export function sanitizeTempName(raw: string): string {
  const base = raw.split("/").pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned === "" ? "download.bin" : cleaned.slice(0, 120);
}

/** Temp files survive longer than this only if something went wrong. */
export async function sweepTemp(now: number): Promise<void> {
  for (const dir of TEMP_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry}`;
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > TEMP_TTL_MS) await rm(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours: nothing to clean.
      }
    }
  }
}

/**
 * `playwright-core` lives in the sandbox image, not in this package: importing
 * it statically would make every test and typecheck need it. The image installs
 * it beside the bundle, so a runtime dynamic import resolves there.
 */
/**
 * Playwright's mouse API is position-less: `down()` presses wherever the pointer
 * happens to be. Driving it without a `move` first sends every click to (0,0),
 * so `PageLike` keeps the coordinates and this adapter does the move.
 */
type RawPage = Omit<PageLike, "mouse"> & {
  mouse: {
    move(x: number, y: number): Promise<void>;
    down(options?: { button?: "left" | "right" }): Promise<void>;
    up(options?: { button?: "left" | "right" }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
};

function adaptPage(page: RawPage): PageLike {
  return {
    goto: (url, options) => page.goto(url, options),
    evaluate: (source) => page.evaluate(source),
    click: (selector, options) => page.click(selector, options),
    fill: (selector, value) => page.fill(selector, value),
    keyboard: {
      press: (key) => page.keyboard.press(key),
      type: (value) => page.keyboard.type(value),
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      down: async (x, y, button) => {
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
      },
      up: async (x, y, button) => {
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
      },
      // Playwright takes (deltaX, deltaY); the panel only ever scrolls vertically.
      wheel: (deltaY) => page.mouse.wheel(0, deltaY),
    },
    goBack: (options) => page.goBack(options),
    screenshot: (options) => page.screenshot(options),
    url: () => page.url(),
    close: () => page.close(),
    waitForLoadState: (state, options) => page.waitForLoadState!(state, options),
    setInputFiles: (selector, path) => page.setInputFiles!(selector, path),
    waitForEvent: (event, options) => page.waitForEvent!(event, options),
  };
}

type PersistentContext = {
  newPage(): Promise<RawPage>;
  close(): Promise<void>;
  newCDPSession(page: PageLike): Promise<{
    send(method: string, params?: unknown): Promise<unknown>;
    on(event: string, listener: (params: unknown) => void): void;
    off(event: string, listener: (params: unknown) => void): void;
  }>;
};
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
      ...launchOptions(),
    });
    return {
      newPage: async () => adaptPage(await context.newPage()),
      close: () => context.close(),
      async newCDPSession(page: PageLike) {
        const session = await context.newCDPSession(page as never);
        return {
          send: <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
            session.send(method as never, params as never) as Promise<T>,
          on: (event, listener) => session.on(event as never, listener as never),
          off: (event, listener) => session.off(event as never, listener as never),
        };
      },
    };
  };
}

type Tab = { page: PageLike; table: RefTable; usedAt: number };

export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  const launch = options.launch ?? launchPersistent(options.userDataDir);
  const maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? (() => Date.now());
  const locale = options.locale ?? "en";

  let handle: BrowserHandle | null = null;
  let lastUse = 0;
  const tabs = new Map<string, Tab>();
  const chains = new Map<string, Promise<unknown>>();
  /** Sessions with work in flight; the sweeper must not close their tabs. */
  const active = new Set<string>();

  type MirrorListener = (event: MirrorEvent) => void;
  type MirrorState = {
    /** Whose tab the view is pointed at right now. */
    session: string;
    tab: Tab;
    /** The panel's own page (a url a human typed), if it ever made one. */
    owned: Tab | null;
    cdp: CdpSession | null;
    onFrame: ((params: Record<string, any>) => void) | null;
    seq: number;
    listeners: Set<MirrorListener>;
    /** Streams attached right now; the sweeper must not close while > 0. */
    attached: number;
    /** The newest frame, kept so a late subscriber is not left staring at black. */
    lastFrame: { seq: number; jpeg: string; w: number; h: number } | null;
    lastUrl: string;
    /** Frame pixel size, which input coordinates are relative to. */
    frame: { w: number; h: number };
  };
  let mirror: MirrorState | null = null;
  /** The task tab the agent touched last; what the panel attaches to. */
  let lastActive: string | null = null;
  /** Serialises view switches; see follow(). */
  let switching: Promise<void> = Promise.resolve();
  /** One version read is enough for the whole browser; the UA never changes. */
  let identity: Identity | null = null;

  /** CDP overrides live on one target, so every new tab needs its own. */
  async function identify(browser: BrowserHandle, page: PageLike): Promise<void> {
    if (browser.newCDPSession === undefined) return;
    const cdp = await browser.newCDPSession(page);
    if (identity === null) {
      const info = await cdp.send<{ product: string }>("Browser.getVersion");
      identity = identityFor(info.product, locale);
    }
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: identity.userAgent,
      acceptLanguage: identity.acceptLanguage,
      platform: "Linux x86_64",
      userAgentMetadata: identity.metadata,
    });
  }

  async function ensureHandle(): Promise<BrowserHandle> {
    if (handle === null) handle = await launch();
    lastUse = now();
    return handle;
  }

  async function dropHandle(): Promise<void> {
    endMirror("closed");
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
  /**
   * A click can start a render that is still painting when we read it. Read until
   * two frames agree, at most three times. A navigation mid-read keeps the last
   * good frame instead of failing the action.
   */
  async function collectSettled(page: PageLike): Promise<Snapshot> {
    let previous: Snapshot | null = null;
    let failure: unknown = null;
    for (let read = 0; read < SETTLE_READS; read += 1) {
      if (read > 0) await pause(SETTLE_DELAY_MS);
      try {
        const snapshot = await collect(page);
        if (previous !== null && frameKey(previous) === frameKey(snapshot)) return snapshot;
        previous = snapshot;
        failure = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A dead page is not a stale frame: let retryOnce relaunch the browser.
        if (!DESTROYED.test(message) && !CLOSED.test(message)) {
          if (previous !== null) return previous;
          throw error;
        }
        failure = error;
      }
    }
    if (previous !== null) return previous;
    throw failure ?? new BrowserError("BAD_REQUEST", "could not read the page");
  }

  async function tab(session: string): Promise<Tab> {
    const existing = tabs.get(session);
    if (existing !== undefined) {
      // Touch on reuse: a slow goto on a cold tab must not look idle to sweep().
      existing.usedAt = now();
      return follow(session, existing);
    }
    if (tabs.size >= maxTabs) {
      const byAge = [...tabs.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
      // Evicting the page a human is watching is the one case worth avoiding.
      const oldest = byAge.find(([, candidate]) => mirror === null || mirror.tab !== candidate) ?? byAge[0];
      if (oldest !== undefined) {
        if (mirror !== null && mirror.tab === oldest[1]) endMirror("closed");
        tabs.delete(oldest[0]);
        await oldest[1].page.close().catch(() => {});
      }
    }
    const browser = await ensureHandle();
    const page = await browser.newPage();
    await identify(browser, page);
    const created: Tab = { page, table: new Map(), usedAt: now() };
    tabs.set(session, created);
    return follow(session, created);
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
    return follow(session, current);
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

  function endMirror(reason: "closed" | "superseded" | "timeout"): void {
    if (mirror === null) return;
    const dying = mirror;
    mirror = null;
    for (const listener of dying.listeners) listener({ type: "end", reason });
    dying.listeners.clear();
    if (dying.cdp !== null && dying.onFrame !== null) {
      dying.cdp.off("Page.screencastFrame", dying.onFrame);
    }
    dying.onFrame = null;
    dying.cdp = null;
  }

  /**
   * Close the page the panel itself opened, if it ever did. Separation of
   * concerns worth the two lines: `endMirror` detaches a view, this closes a
   * page, and callers that already close pages never double-close one.
   */
  function closeOwnedPage(state: MirrorState): void {
    const owned = state.owned;
    state.owned = null;
    if (owned === null) return;
    if (tabs.get(PANEL_SESSION) === owned) tabs.delete(PANEL_SESSION);
    void owned.page.close().catch(() => {});
  }

  /**
   * Remember which tab the agent touched last, and point the view at it. Never
   * awaited by the caller: an agent's tool call must not fail because someone
   * happens to be watching. A failed switch ends the view, and the panel then
   * offers "重新接管", which is honest and cheap.
   */
  function follow(session: string, current: Tab): Tab {
    if (session !== PANEL_SESSION) lastActive = session;
    const watching = mirror;
    // Compare tabs, not session names: a cap eviction can recreate a session's
    // tab, and the old page must not keep the view.
    if (watching !== null && watching.tab !== current) {
      // One switch at a time, or two of them each start a screencast over the
      // other's CDP session and the loser's listener is never removed.
      switching = switching
        .then(() => (mirror === watching ? attach(watching, session, current) : undefined))
        .catch(() => endMirror("closed"));
    }
    return current;
  }

  /** Point the mirror at one tab's page: snapshot, then a fresh screencast. */
  async function attach(state: MirrorState, session: string, current: Tab): Promise<void> {
    if (state.cdp !== null && state.onFrame !== null) {
      state.cdp.off("Page.screencastFrame", state.onFrame);
    }
    state.cdp = null;
    state.onFrame = null;
    state.session = session;
    state.tab = current;
    // `url()` is sync and cannot throw mid-navigation, unlike a DOM collect.
    state.lastUrl = current.page.url();
    // Clicks aimed at the page we just left must not land on this one.
    state.seq += STALE_FRAMES + 1;
    await snapshotFrame(state);
    if (mirror !== state) return;
    broadcast(state, { type: "state", url: state.lastUrl });
    await startScreencast(state);
  }

  /** One screenshot so a panel that connects later still has something to draw. */
  async function snapshotFrame(state: MirrorState): Promise<void> {
    const jpeg = await state.tab.page
      .screenshot({ type: "jpeg", quality: FRAME_QUALITY })
      .then((bytes) => Buffer.from(bytes).toString("base64"))
      .catch(() => "");
    if (jpeg === "") return;
    state.seq += 1;
    state.frame = { w: VIEWPORT.width, h: VIEWPORT.height };
    state.lastFrame = { seq: state.seq, jpeg, w: state.frame.w, h: state.frame.h };
    for (const listener of state.listeners) listener({ type: "frame", ...state.lastFrame });
  }

  function broadcast(state: MirrorState, event: MirrorEvent): void {
    for (const listener of state.listeners) listener(event);
  }

  /** Frame coordinates are relative to whatever the screencast last sent. */
  function toCss(state: MirrorState, x: number, y: number): { x: number; y: number } {
    const scale = state.frame.w === 0 ? 1 : VIEWPORT.width / state.frame.w;
    const clamp = (value: number, max: number): number =>
      Math.max(0, Math.min(max, Math.round(value * scale)));
    return { x: clamp(x, VIEWPORT.width), y: clamp(y, VIEWPORT.height) };
  }

  async function applyInput(state: MirrorState, events: MirrorInput[]): Promise<void> {
    for (const event of events) {
      if (event.type === "mouse") {
        if (event.kind === "wheel") {
          await state.tab.page.mouse.wheel(event.deltaY ?? 0);
          continue;
        }
        const point = toCss(state, event.x, event.y);
        if (event.kind === "move") {
          await state.tab.page.mouse.move(point.x, point.y);
        } else if (event.kind === "down") {
          await state.tab.page.mouse.down(point.x, point.y, event.button ?? "left");
        } else {
          await state.tab.page.mouse.up(point.x, point.y, event.button ?? "left");
        }
        continue;
      }
      if (event.kind === "text") {
        const body = event.text ?? "";
        if (body !== "") await state.tab.page.keyboard.type(body);
      } else if ((event.key ?? "") !== "") {
        await state.tab.page.keyboard.press(event.key!);
      }
    }
  }

  /** The CDP half: start the screencast and keep it acked. */
  async function startScreencast(state: MirrorState): Promise<void> {
    const browser = await ensureHandle();
    if (browser.newCDPSession === undefined) return;
    const cdp = await browser.newCDPSession(state.tab.page);
    state.cdp = cdp;
    state.onFrame = (params) => {
      if (mirror !== state) return; // a newer session owns the tab now
      const data = typeof params.data === "string" ? params.data : "";
      if (data === "") return;
      const metadata = (params.metadata ?? {}) as {
        deviceWidth?: number;
        deviceHeight?: number;
      };
      const sessionId = typeof params.sessionId === "number" ? params.sessionId : 0;
      // Ack first: an unacked stream stalls after a handful of frames.
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      state.seq += 1;
      state.frame = {
        w: metadata.deviceWidth ?? VIEWPORT.width,
        h: metadata.deviceHeight ?? VIEWPORT.height,
      };
      state.lastFrame = { seq: state.seq, jpeg: data, w: state.frame.w, h: state.frame.h };
      broadcast(state, { type: "frame", ...state.lastFrame });
      const url = state.tab.page.url();
      if (url !== state.lastUrl) {
        state.lastUrl = url;
        broadcast(state, { type: "state", url });
      }
    };
    cdp.on("Page.screencastFrame", state.onFrame);
    await cdp.send("Page.enable");
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      maxWidth: FRAME_MAX_WIDTH,
      maxHeight: FRAME_MAX_HEIGHT,
      everyNthFrame: 1,
    });
  }

  return {
    open(session, url, timeoutMs = DEFAULT_GOTO_TIMEOUT_MS) {
      return serial(session, () =>
        retryOnce(async () => {
          const current = await tab(session);
          await current.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
          await waitForLoad(current.page);
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

    upload(session, args) {
      return serial(session, () =>
        retryOnce(async () => {
          const current = need(session);
          const setInputFiles = current.page.setInputFiles;
          if (setInputFiles === undefined) {
            throw new BrowserError("BAD_REQUEST", "this page cannot take files — open it again");
          }
          const live = await collect(current.page);
          let tagged: unknown;
          if (isRef(args.target)) {
            const resolved = resolveTarget(current.table, args.target, live.elements);
            if (!resolved.ok) {
              throw new BrowserError(
                "STALE_REF",
                resolved.reason === "ambiguous"
                  ? "page has several identical elements — pass a CSS selector instead"
                  : "page moved — read it again",
              );
            }
            tagged = await current.page.evaluate(tagFileInputScript(current.table.get(args.target)!));
          } else {
            tagged = await current.page.evaluate(tagFileSelectorScript(args.target));
          }
          if (tagged !== true) {
            throw new BrowserError(
              "BAD_REQUEST",
              "no file input matches that target — pass a CSS selector like input[type=file]",
            );
          }
          try {
            await setInputFiles("[data-dw-hit]", args.path);
          } finally {
            await current.page.evaluate(UNTAG_SOURCE).catch(() => {});
          }
          const snapshot = await collectSettled(current.page);
          current.table = refTable(snapshot);
          current.usedAt = now();
          void sweepTemp(now());
          return snapshot;
        }),
      );
    },

    download(session, target, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
      return serial(session, () =>
        retryOnce(async () => {
          const current = need(session);
          const waitForEvent = current.page.waitForEvent;
          if (waitForEvent === undefined) {
            throw new BrowserError("BAD_REQUEST", "this page cannot download — open it again");
          }
          const live = await collect(current.page);
          let tagged: unknown;
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
            tagged = await current.page.evaluate(tagScript(current.table.get(target)!));
          } else {
            tagged = await current.page.evaluate(tagSelectorScript(target));
          }
          if (tagged !== true) {
            throw new BrowserError("STALE_REF", "no visible element matches that selector");
          }
          let download: DownloadLike;
          try {
            // Arm before clicking: a fast download is gone before we look for it.
            const waiting = waitForEvent("download", { timeout: timeoutMs });
            await current.page.click("[data-dw-hit]", { timeout: ACTION_TIMEOUT_MS });
            download = await waiting;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/Timeout/i.test(message)) {
              throw new BrowserError("BAD_REQUEST", "clicking did not start a download");
            }
            throw error;
          } finally {
            await current.page.evaluate(UNTAG_SOURCE).catch(() => {});
          }
          const dir = `/tmp/dw-downloads/${randomUUID()}`;
          await mkdir(dir, { recursive: true });
          const name = sanitizeTempName(download.suggestedFilename());
          const path = `${dir}/${name}`;
          await download.saveAs(path);
          const size = (await stat(path)).size;
          const snapshot = await collectSettled(current.page);
          current.table = refTable(snapshot);
          current.usedAt = now();
          void sweepTemp(now());
          return { name, size, path, snapshot };
        }),
      );
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
        // Closing the page the panel is watching must tell it, or the view just
        // freezes with no end event and keeps accepting clicks.
        if (mirror !== null && mirror.tab === current) endMirror("closed");
        tabs.delete(session);
        await current.page.close().catch(() => {});
      });
    },

    async sweep(at = now()) {
      for (const [session, current] of [...tabs]) {
        if (active.has(session)) continue;
        // A human is looking at this tab; only a dropped stream ages it.
        if (mirror !== null && mirror.session === session && mirror.attached > 0) continue;
        if (at - current.usedAt < idleMs) continue;
        // endMirror only detaches: the page is this loop's to close, once. An
        // idle panel page that the view has moved away from is just another
        // entry here and gets closed by its own turn.
        if (mirror !== null && mirror.session === session) endMirror("timeout");
        tabs.delete(session);
        await current.page.close().catch(() => {});
      }
      if (tabs.size === 0 && handle !== null && at - lastUse >= idleMs) await dropHandle();
    },

    async shutdown() {
      await dropHandle();
    },

    mirror: {
      async open(url, timeoutMs = DEFAULT_GOTO_TIMEOUT_MS) {
        endMirror("superseded");
        const typed = url !== undefined && url !== "";
        // A swept tab must not be recreated: that would open a blank page under
        // a dead task id and show white where the work used to be. A url the
        // human typed is the one case where creating a page is the point.
        if (!typed && (lastActive === null || !tabs.has(lastActive))) {
          return { url: "", title: "" };
        }
        const session = typed ? PANEL_SESSION : lastActive!;
        const current = await tab(session);
        if (typed) {
          await current.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
          await waitForLoad(current.page);
        }
        const snapshot = await collectSettled(current.page);
        const state: MirrorState = {
          session,
          tab: current,
          owned: typed ? current : null,
          cdp: null,
          onFrame: null,
          seq: 0,
          listeners: new Set(),
          attached: 0,
          lastFrame: null,
          lastUrl: snapshot.url,
          frame: { w: VIEWPORT.width, h: VIEWPORT.height },
        };
        mirror = state;
        await snapshotFrame(state);
        await startScreencast(state);
        return { url: snapshot.url, title: snapshot.title };
      },

      subscribe(emit) {
        if (mirror === null) {
          emit({ type: "end", reason: "closed" });
          return () => {};
        }
        const state = mirror;
        state.listeners.add(emit);
        state.attached += 1;
        // Replay before any new frame can arrive, so the panel paints at once.
        if (state.lastFrame !== null) emit({ type: "frame", ...state.lastFrame });
        emit({ type: "state", url: state.lastUrl });
        return () => {
          state.listeners.delete(emit);
          state.attached = Math.max(0, state.attached - 1);
          // The idle window starts when the stream ends, not at the last click:
          // staring at a still challenge for five minutes must not age the tab.
          if (state.attached === 0) state.tab.usedAt = now();
        };
      },

      async input(seq, events) {
        const state = mirror;
        if (state === null) return { ok: false, code: "NO_MIRROR" };
        if (state.seq - seq > STALE_FRAMES) return { ok: false, code: "STALE" };
        await applyInput(state, events);
        // A sweep or a second open can clear the mirror while the events run.
        state.tab.usedAt = now();
        return { ok: true };
      },

      async close() {
        const ending = mirror;
        endMirror("closed");
        if (ending !== null) closeOwnedPage(ending);
      },
    },
  };
}
