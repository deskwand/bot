import { describe, expect, it } from "vitest";
import {
  WeChatLogin,
  createLoginGate,
  type LoginSecrets,
  type LoginStage,
  type LoginState,
  type LoginStateStore,
  type LoginSecretStore,
  type LoginSwapExpect,
  type LoginSwapResult,
  type WeChatLoginTransport,
} from "../../src/channels/wechat/login";
import {
  createILinkClient,
  type WeChatCredentials,
} from "../../src/channels/wechat/ilink";

const INVITE_ID = "invite-1";
const GENERATION = 2;
const NOW = 1_000_000_000_000;

type StatusStep = {
  status: string;
  raw?: Record<string, unknown>;
};

type RealnameStep = "wait" | "ok" | "denied" | "refresh";

function matches(row: LoginState, expect: LoginSwapExpect): boolean {
  if (row.generation !== expect.generation) return false;
  if (expect.stage !== undefined && row.stage !== expect.stage) return false;
  if (
    expect.activationStarted !== undefined &&
    row.activationStarted !== expect.activationStarted
  ) {
    return false;
  }
  return true;
}

class MemoryStateStore implements LoginStateStore {
  readonly rows = new Map<string, LoginState>();

  async load(inviteId: string): Promise<LoginState | null> {
    const row = this.rows.get(inviteId);
    return row ? structuredClone(row) : null;
  }

  async create(state: LoginState): Promise<LoginSwapResult> {
    if (this.rows.has(state.inviteId)) {
      return { applied: false, current: await this.load(state.inviteId) };
    }
    this.rows.set(state.inviteId, structuredClone(state));
    return { applied: true, current: structuredClone(state) };
  }

  async swap(
    state: LoginState,
    expect: LoginSwapExpect,
  ): Promise<LoginSwapResult> {
    const current = this.rows.get(state.inviteId);
    if (!current) return { applied: false, current: null };
    if (!matches(current, expect)) {
      return { applied: false, current: structuredClone(current) };
    }
    this.rows.set(state.inviteId, structuredClone(state));
    return { applied: true, current: structuredClone(state) };
  }

  async delete(
    inviteId: string,
    expect: { generation: number },
  ): Promise<LoginSwapResult> {
    const current = this.rows.get(inviteId);
    if (!current) return { applied: false, current: null };
    if (current.generation !== expect.generation) {
      return { applied: false, current: structuredClone(current) };
    }
    this.rows.delete(inviteId);
    return { applied: true, current: null };
  }

  snapshot(): Array<[string, LoginState]> {
    return structuredClone([...this.rows.entries()]);
  }
}

class MemorySecretStore implements LoginSecretStore {
  readonly rows = new Map<string, LoginSecrets>();

  failDeletes = false;

  private key(inviteId: string, generation: number): string {
    return `${inviteId}:${generation}`;
  }

  at(inviteId: string, generation: number): LoginSecrets | undefined {
    const row = this.rows.get(this.key(inviteId, generation));
    return row ? structuredClone(row) : undefined;
  }

  async get(
    inviteId: string,
    generation: number,
  ): Promise<LoginSecrets | undefined> {
    return this.at(inviteId, generation);
  }

  async put(
    inviteId: string,
    generation: number,
    secrets: LoginSecrets,
  ): Promise<void> {
    this.rows.set(this.key(inviteId, generation), structuredClone(secrets));
  }

  async delete(inviteId: string, generation: number): Promise<void> {
    if (this.failDeletes) throw new Error("vault unavailable");
    this.rows.delete(this.key(inviteId, generation));
  }
}

type Recorded = { url: string; method: string };

const QR_IMAGE = "https://weixin.qq.com/qr/example";
const BOT_TOKEN = "secret-bot-token";
const CONFIRMED_RAW: Record<string, unknown> = {
  status: "confirmed",
  bot_token: BOT_TOKEN,
  baseurl: "https://ilinkai.weixin.qq.com",
  ilink_bot_id: "account-1",
  ilink_user_id: "member-1",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets an in-flight call reach its next await without depending on timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function makeHarness(
  options: {
    statuses?: Array<StatusStep | string>;
    realname?: RealnameStep[];
    realnameExpiresInMs?: number;
    inviteLive?: boolean;
    expiresAt?: number;
    localTokens?: string[];
    generation?: number;
    activationStatus?: () => "committed" | "pending";
    state?: MemoryStateStore;
    secrets?: MemorySecretStore;
    onAuthUrl?: (auth: { authUrl: string; expiresAt: number }) => void | Promise<void>;
  } = {},
) {
  const requests: Recorded[] = [];
  const saved: WeChatCredentials[] = [];
  const statuses: StatusStep[] = (options.statuses ?? ["wait"]).map((step) =>
    typeof step === "string" ? { status: step } : step,
  );
  const realname = [...(options.realname ?? ["ok"])];
  const state = options.state ?? new MemoryStateStore();
  const secrets = options.secrets ?? new MemorySecretStore();
  const generation = options.generation ?? GENERATION;
  let clock = NOW;
  let qrSeq = 0;
  let ticketSeq = 0;
  let authSeq = 0;
  let holdStatus: Promise<void> | null = null;
  let holdConfirm: Promise<void> | null = null;
  const defaultBase = "https://ilinkai.weixin.qq.com";

  const transport: WeChatLoginTransport = {
    async getRealnameAuthUrl() {
      authSeq++;
      requests.push({
        url: "https://weixin110.qq.com/security/acct/botrealnameverifycgi?step=get_auth_url&plugin_version=3.0.1/deskwand",
        method: "GET",
      });
      return {
        authUrl: `https://weixin110.qq.com/auth/${authSeq}`,
        ticket: `spam-ticket-${ticketSeq + 1}`,
      };
    },

    async queryRealnameResult(ticket: string) {
      ticketSeq++;
      requests.push({
        url: `https://weixin110.qq.com/security/acct/botrealnameverifycgi?step=query_auth_result&bot_spam_ticket=${encodeURIComponent(ticket)}`,
        method: "GET",
      });
      const next = realname.shift() ?? "wait";
      if (next === "ok") {
        return {
          status: "ok" as const,
          ...(options.realnameExpiresInMs === undefined
            ? {}
            : { expiresAt: clock + options.realnameExpiresInMs }),
        };
      }
      return { status: next };
    },

    async getBotQrCode(
      _signal?: AbortSignal,
      qrOptions?: { localTokens?: readonly string[]; spamTicket?: string },
    ) {
      requests.push({ url: `${defaultBase}/ilink/bot/get_bot_qrcode?bot_type=3`, method: "POST" });
      void qrOptions;
      qrSeq++;
      return { qrcode: `qr-${qrSeq}`, imageContent: `${QR_IMAGE}-${qrSeq}` };
    },

    async getQrStatus(
      qrcode: string,
      _signal?: AbortSignal,
      qrOptions?: { verifyCode?: string; baseUrl?: string },
    ) {
      const base = qrOptions?.baseUrl ?? defaultBase;
      const pin = qrOptions?.verifyCode
        ? `&verify_code=${encodeURIComponent(qrOptions.verifyCode)}`
        : "";
      requests.push({
        url: `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${pin}`,
        method: "GET",
      });
      if (holdStatus) await holdStatus;
      const next = statuses.shift();
      if (!next) throw new Error("unexpected status request");
      const raw: Record<string, unknown> = {
        status: next.status,
        ...(next.status === "confirmed" && !next.raw ? CONFIRMED_RAW : {}),
        ...next.raw,
      };
      return {
        status: next.status as never,
        raw,
        ...(typeof raw.baseurl === "string" && next.status === "scaned_but_redirect"
          ? { redirectBaseUrl: raw.baseurl }
          : {}),
      };
    },
  };

  function make(): WeChatLogin {
    return new WeChatLogin({
      inviteId: INVITE_ID,
      generation,
      expiresAt: options.expiresAt ?? NOW + 15 * 60_000,
      state,
      secrets,
      transport,
      onConfirmed: async (credentials) => {
        saved.push(credentials);
        if (holdConfirm) await holdConfirm;
      },
      activationStatus: async () =>
        options.activationStatus
          ? options.activationStatus()
          : saved.length > 0
            ? "committed"
            : "pending",
      inviteLive: async () => options.inviteLive ?? true,
      localTokens: async () => options.localTokens ?? ["local-token-a"],
      onAuthUrl: options.onAuthUrl,
      now: () => clock,
    });
  }

  return {
    state,
    secrets,
    saved,
    requests,
    statuses,
    transport,
    make,
    generation,
    now: () => clock,
    setNow: (value: number) => {
      clock = value;
    },
    /** Holds the next status poll, so a delayed return can be modelled. */
    holdStatusOnce(): () => void {
      const gate = deferred();
      holdStatus = gate.promise;
      return () => {
        holdStatus = null;
        gate.resolve();
      };
    },
    /** Holds `onConfirmed`, so a concurrent instance can run mid-activation. */
    holdConfirmOnce(): () => void {
      const gate = deferred();
      holdConfirm = gate.promise;
      return () => {
        holdConfirm = null;
        gate.resolve();
      };
    },
  };
}

function qrRequests(requests: Recorded[]): Recorded[] {
  return requests.filter((request) => request.url.includes("get_bot_qrcode"));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class Stall {
  constructor(readonly name: "TimeoutError" | "AbortError" = "TimeoutError") {}
}

/**
 * The real transport over a scripted `fetch`, so failures are the ones the
 * production client actually throws instead of impossible fake statuses.
 */
function makeWireHarness(
  options: {
    responses: Array<Response | Error | Stall | (() => Response)>;
    stepTimeoutMs?: number;
    expiresAt?: number;
  },
) {
  const queue = [...options.responses];
  const calls: string[] = [];
  const state = new MemoryStateStore();
  const secrets = new MemorySecretStore();
  const saved: WeChatCredentials[] = [];
  let clock = NOW;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const next = queue.shift();
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    if (next instanceof Stall) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", next.name));
        });
      });
    }
    if (!next) throw new Error("unexpected request");
    return next;
  }) as typeof fetch;

  const login = new WeChatLogin({
    inviteId: INVITE_ID,
    generation: GENERATION,
    expiresAt: options.expiresAt ?? NOW + 15 * 60_000,
    state,
    secrets,
    transport: createILinkClient({
      fetch: fetchImpl,
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
    onConfirmed: async (credentials) => {
      saved.push(credentials);
    },
    activationStatus: async () => (saved.length > 0 ? "committed" : "pending"),
    inviteLive: async () => true,
    now: () => clock,
    ...(options.stepTimeoutMs === undefined
      ? {}
      : { stepTimeoutMs: options.stepTimeoutMs }),
  });

  return {
    login,
    state,
    secrets,
    saved,
    calls,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

// A Response body can only be read once, so each scripted step is a factory.
const realnameAuth = () =>
  json({
    auth_url: "https://weixin110.qq.com/auth/1",
    bot_spam_ticket: "spam-ticket-1",
  });
const realnameOk = () => json({ status: 1 });
const qrIssued = () =>
  json({
    qrcode: "qr-1",
    qrcode_img_content: "https://weixin.qq.com/qr/1",
  });

describe("WeChatLogin", () => {
  it("需要 PIN 时等待页面输入，不误认为成功", async () => {
    const h = makeHarness({ statuses: ["need_verifycode", "scaned", "confirmed"] });
    const login = h.make();

    await login.startOtherOwner();
    await login.advance();
    expect(login.view().stage).toBe("pin");
    expect(h.saved).toHaveLength(0);

    await login.submitPin("123456");
    // submitPin 本身已经发起携PIN的下一次poll，不能等后续advance再发。
    expect(h.requests.at(-1)?.url).toContain("verify_code=123456");
    expect(login.view().stage).toBe("scan");
    expect(h.saved).toHaveLength(0);

    await login.advance();
    expect(h.saved).toHaveLength(1);
    expect(h.requests.at(-1)?.url).not.toContain("verify_code=");
  });

  it("advance 在 PIN 阶段不轮询也不重发 PIN", async () => {
    const h = makeHarness({ statuses: ["need_verifycode"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    expect(login.view().stage).toBe("pin");

    const before = h.requests.length;
    await login.advance();
    expect(h.requests).toHaveLength(before);
    expect(login.view().stage).toBe("pin");
    expect(JSON.stringify([...h.state.rows.values()])).not.toContain("123456");
  });

  it("未知状态失败关闭且不激活", async () => {
    const h = makeHarness({ statuses: ["need_verifycode", "surprise"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    await login.submitPin("123456");

    expect(login.view().stage).toBe("failed");
    expect(h.saved).toHaveLength(0);
  });

  it("confirmed 缺少凭据时失败关闭", async () => {
    const h = makeHarness({
      statuses: [{ status: "confirmed", raw: { bot_token: "secret-bot-token" } }],
    });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    expect(login.view().stage).toBe("failed");
    expect(h.saved).toHaveLength(0);
  });

  it("拒绝不可信重定向且不带凭据跨源", async () => {
    const h = makeHarness({
      statuses: [
        { status: "scaned_but_redirect", raw: { baseurl: "https://evil.example.com" } },
      ],
    });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    expect(login.view().stage).toBe("failed");
    expect(h.requests.every((request) => !request.url.includes("evil.example.com"))).toBe(true);
    const before = h.requests.length;
    await login.advance();
    expect(h.requests).toHaveLength(before);
  });

  it("扫描重定向只切换到可信微信主机", async () => {
    const h = makeHarness({
      statuses: [
        { status: "scaned_but_redirect", raw: { baseurl: "https://ilinkai.weixin.qq.com" } },
        "confirmed",
      ],
    });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    await login.advance();

    const last = h.requests.at(-1)?.url;
    expect(last).toContain("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status");
    expect(h.saved).toHaveLength(1);
  });

  it("二维码最多请求三次", async () => {
    const h = makeHarness({ statuses: ["expired", "expired", "expired", "expired"] });
    const login = h.make();
    await login.startOtherOwner();
    for (let i = 0; i < 6; i++) await login.advance();

    expect(qrRequests(h.requests)).toHaveLength(3);
    expect(login.view().stage).toBe("expired");
    expect(h.saved).toHaveLength(0);
  });

  it("过期后迟到的 confirmed 不激活", async () => {
    const h = makeHarness({ statuses: ["confirmed"], expiresAt: NOW + 1000 });
    const login = h.make();
    await login.startOtherOwner();
    h.setNow(NOW + 5000);
    await login.advance();

    expect(login.view().stage).toBe("expired");
    expect(h.saved).toHaveLength(0);
  });

  it("取消后不再发请求也不激活", async () => {
    const h = makeHarness({ statuses: ["confirmed"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.cancel();
    const before = h.requests.length;
    await login.advance();

    expect(h.requests).toHaveLength(before);
    expect(h.saved).toHaveLength(0);
    expect(login.view().stage).toBe("cancelled");
  });

  it("实名拒绝时不取绑定码", async () => {
    const h = makeHarness({ realname: ["denied"] });
    const login = h.make();
    await login.startOtherOwner();

    expect(login.view().stage).toBe("denied");
    expect(qrRequests(h.requests)).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it("实名 ticket 只刷新一次", async () => {
    const h = makeHarness({ realname: ["refresh", "refresh"] });
    const login = h.make();
    await login.startOtherOwner();
    // 一次 advance 只发一个请求：先取新授权链接，再查询结果。
    await login.advance();
    await login.advance();

    expect(login.view().stage).toBe("failed");
    expect(login.view().failure).toBe("ticket_refresh_exhausted");
    expect(qrRequests(h.requests)).toHaveLength(0);
    const realnameCalls = h.requests.filter((request) => request.url.includes("step=get_auth_url"));
    expect(realnameCalls).toHaveLength(2);
  });

  it("取到实名链接后立即交给操作者，且同一 ticket 不重复投递", async () => {
    const delivered: Array<{ authUrl: string; expiresAt: number }> = [];
    const h = makeHarness({
      realname: ["wait", "wait"],
      onAuthUrl: (auth) => {
        delivered.push(auth);
      },
    });
    const login = h.make();
    await login.startOtherOwner();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.authUrl).toBe("https://weixin110.qq.com/auth/1");
    expect(delivered[0]?.expiresAt).toBeGreaterThan(NOW);

    // 同一个 ticket 的后续轮询不再重发链接。
    await h.make().advance();
    expect(delivered).toHaveLength(1);
  });

  it("刷新后取到的新实名链接再次投递", async () => {
    const delivered: string[] = [];
    const h = makeHarness({
      realname: ["refresh", "wait"],
      onAuthUrl: (auth) => {
        delivered.push(auth.authUrl);
      },
    });
    const login = h.make();
    await login.startOtherOwner();
    expect(delivered).toEqual(["https://weixin110.qq.com/auth/1"]);

    await login.advance(); // 服务端要求刷新：丢掉旧 ticket
    await login.advance(); // 重新取授权链接
    expect(delivered).toEqual([
      "https://weixin110.qq.com/auth/1",
      "https://weixin110.qq.com/auth/2",
    ]);
  });

  it("投递失败不影响邀请推进", async () => {
    const h = makeHarness({
      realname: ["wait"],
      onAuthUrl: () => {
        throw new Error("send failed");
      },
    });
    const login = h.make();
    await login.startOtherOwner();
    expect(login.view().stage).toBe("realname");
    expect(login.view().failure).toBeUndefined();
  });

  it("实名等待最长 480 秒", async () => {
    const h = makeHarness({ realname: ["wait", "wait"] });
    const login = h.make();
    await login.startOtherOwner();
    expect(h.state.rows.get(INVITE_ID)?.realnameDeadline).toBe(NOW + 480_000);

    h.setNow(NOW + 480_001);
    await login.advance();
    expect(login.view().stage).toBe("expired");
  });

  it("ticket 剩余不足 60 秒时终止", async () => {
    const h = makeHarness({ realname: ["ok"], realnameExpiresInMs: 30_000 });
    const login = h.make();
    await login.startOtherOwner();

    expect(login.view().stage).toBe("failed");
    expect(qrRequests(h.requests)).toHaveLength(0);
  });

  it("PIN 被封锁或过期时清除 PIN 并失败关闭", async () => {
    const h = makeHarness({
      statuses: ["need_verifycode", "verify_code_blocked", "scaned"],
    });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    await login.submitPin("123456");

    expect(login.view().stage).toBe("failed");
    // blocked 之后的 status 不应再被消费。
    expect(h.requests.at(-1)?.url).toContain("verify_code=123456");
    expect(h.statuses).toHaveLength(1);
  });

  it("非法 PIN 直接拒绝且不落库", async () => {
    const h = makeHarness({ statuses: ["need_verifycode"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    const before = h.requests.length;

    await expect(login.submitPin("abc")).rejects.toThrow(/WECHAT_LOGIN_PIN_INVALID/);
    expect(h.requests).toHaveLength(before);
    expect(JSON.stringify([...h.state.rows.values()])).not.toContain("abc");
  });

  it("binded_redirect 没有新凭据时不能新增成员", async () => {
    const h = makeHarness({ statuses: ["binded_redirect"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    expect(login.view().stage).toBe("failed");
    expect(h.saved).toHaveLength(0);
  });

  it("view 与错误不泄漏 qrcode、ticket 或页面令牌", async () => {
    const h = makeHarness({ statuses: ["need_verifycode"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    const view = JSON.stringify(login.view());
    expect(view).not.toContain("qr-1");
    expect(view).not.toContain("spam-ticket");
    expect(view).not.toContain("local-token-a");
    expect(view).not.toContain(BOT_TOKEN);
    const blob = JSON.stringify([...h.secrets.rows.values()]);
    expect(blob).toContain("qr-1");
    expect(view).not.toContain(JSON.parse(blob)[0].inviteeToken);
  });

  it("邀请失效或 generation 过期时不激活", async () => {
    const h = makeHarness({ statuses: ["confirmed"], inviteLive: false });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    expect(h.saved).toHaveLength(0);
    expect(login.view().stage).toBe("failed");
  });

  it("在每个阶段重建实例都能恢复且不重复激活", async () => {
    const h = makeHarness({
      realname: ["wait", "ok"],
      statuses: ["need_verifycode", "scaned", "confirmed"],
    });

    // realname
    const first = h.make();
    await first.startOtherOwner();
    expect(first.view().stage).toBe("realname");

    // 重建后继续实名：本次只做一次实名查询，下一次才取码
    const second = h.make();
    await second.advance();
    expect(second.view().stage).toBe("scan");
    await second.advance();
    expect(second.view().stage).toBe("scan");
    await second.advance();
    expect(second.view().stage).toBe("pin");

    // 重建后仍停在 pin，advance 不发请求
    const third = h.make();
    const before = h.requests.length;
    await third.advance();
    expect(h.requests).toHaveLength(before);
    expect(third.view().stage).toBe("pin");

    // 重建后提交 PIN 并完成
    const fourth = h.make();
    await fourth.submitPin("123456");
    expect(fourth.view().stage).toBe("scan");
    const fifth = h.make();
    await fifth.advance();
    expect(fifth.view().stage).toBe("confirmed");
    expect(h.saved).toHaveLength(1);

    // confirmed 后重建不重复激活
    const sixth = h.make();
    await sixth.advance();
    expect(h.saved).toHaveLength(1);
    expect(sixth.view().stage).toBe("confirmed");
  });

  it("confirmed 保存中断后不重复调用 onConfirmed", async () => {
    const h = makeHarness({ statuses: ["confirmed"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    expect(h.saved).toHaveLength(1);

    // 模拟持久化 saving 后进程崩溃：回调已提交，但 stage 未推进。
    const row = h.state.rows.get(INVITE_ID)!;
    row.stage = "saving";
    row.activationStarted = true;
    row.activationAt = NOW - 120_000;
    h.state.rows.set(INVITE_ID, row);
    const rebuilt = h.make();
    await rebuilt.advance();

    expect(h.saved).toHaveLength(1);
    expect(rebuilt.view().stage).toBe("confirmed");
  });

  it("恢复时 PIN 永不从存储读回", async () => {
    const h = makeHarness({ statuses: ["need_verifycode", "scaned"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();

    const stored = JSON.stringify([
      ...h.state.rows.values(),
      ...h.secrets.rows.values(),
    ]);
    expect(stored).not.toMatch(/"(pin|verifyCode|verify_code)"\s*:/);
    expect(stored).not.toContain("123456");
  });

  it("并发实例只激活一次，且不依赖共享 gate", async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecretStore();
    const h = makeHarness({
      statuses: ["confirmed", "confirmed"],
      state,
      secrets,
    });
    const seed = h.make();
    await seed.startOtherOwner();
    expect(seed.view().stage).toBe("scan");

    // 两个实例各自持有自己的 gate，只共享存储。
    const first = h.make();
    const second = h.make();
    const release = h.holdConfirmOnce();
    const winner = first.advance();
    await settle();
    expect(state.rows.get(INVITE_ID)?.stage).toBe("saving");

    const loser = second.advance();
    await settle();
    // 输家不得重复回调，也不得把在途激活判死。
    expect(h.saved).toHaveLength(1);
    expect(state.rows.get(INVITE_ID)?.stage).toBe("saving");
    await second.advance();
    expect(state.rows.get(INVITE_ID)?.stage).toBe("saving");

    release();
    await winner;
    await loser;
    expect(h.saved).toHaveLength(1);
    expect(state.rows.get(INVITE_ID)?.stage).toBe("confirmed");
    // The loser only learns the outcome by re-reading durable state.
    await second.load();
    expect(second.view().stage).toBe("confirmed");
  });

  it("迟到的旧 generation 回调不写不删当前流程", async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecretStore();
    const h = makeHarness({ statuses: ["confirmed"], state, secrets });
    const stale = h.make();
    await stale.startOtherOwner();
    expect(stale.view().stage).toBe("scan");

    const release = h.holdStatusOnce();
    const delayed = stale.advance();
    await settle();

    // 更年轻的 generation 接管了这一条邀请。
    const newer = structuredClone(state.rows.get(INVITE_ID)!);
    newer.generation = GENERATION + 1;
    newer.stage = "scan";
    state.rows.set(INVITE_ID, newer);
    await secrets.put(INVITE_ID, GENERATION + 1, {
      inviteeToken: "new-invitee",
      operatorToken: "new-operator",
      qrcode: "qr-new",
    });
    const rowsBefore = state.snapshot();
    const secretsBefore = secrets.at(INVITE_ID, GENERATION + 1);

    release();
    await delayed;

    expect(state.snapshot()).toEqual(rowsBefore);
    expect(secrets.at(INVITE_ID, GENERATION + 1)).toEqual(secretsBefore);
    expect(h.saved).toHaveLength(0);
  });

  it("激活声明后、回调提交前崩溃按未知失败关闭且不重放", async () => {
    const h = makeHarness({ statuses: ["confirmed"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    expect(h.saved).toHaveLength(1);

    // 回滚成"已声明激活、但没有提交证据"的崩溃现场。
    h.saved.length = 0;
    const row = h.state.rows.get(INVITE_ID)!;
    row.stage = "saving";
    row.activationStarted = true;
    row.activationAt = NOW - 120_000;
    h.state.rows.set(INVITE_ID, row);

    const rebuilt = h.make();
    await rebuilt.advance();
    expect(rebuilt.view().stage).toBe("failed");
    expect(rebuilt.view().failure).toBe("interrupted");
    expect(h.saved).toHaveLength(0);

    const before = h.requests.length;
    await rebuilt.advance();
    expect(h.requests).toHaveLength(before);
    expect(h.saved).toHaveLength(0);
  });

  it("激活凭证回调本身失败时终止且不留 saving", async () => {
    const h = makeHarness({ statuses: ["confirmed"] });
    const login = new WeChatLogin({
      inviteId: INVITE_ID,
      generation: GENERATION,
      expiresAt: NOW + 15 * 60_000,
      state: h.state,
      secrets: h.secrets,
      transport: h.transport,
      onConfirmed: async () => {
        throw new Error("member store down");
      },
      activationStatus: async () => "pending",
      now: h.now,
    });
    await login.startOtherOwner();
    await login.advance();

    expect(h.state.rows.get(INVITE_ID)?.stage).toBe("failed");
    expect(h.state.rows.get(INVITE_ID)?.failure).toBe("activation_failed");
    expect(login.view().stage).toBe("failed");
  });

  it("权威激活回执不可用时不把 saving 当成成功", async () => {
    const h = makeHarness({
      statuses: ["confirmed"],
      activationStatus: () => {
        throw new Error("member store down");
      },
    });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    const row = h.state.rows.get(INVITE_ID)!;
    row.stage = "saving";
    row.activationStarted = true;
    row.activationAt = NOW - 120_000;
    h.state.rows.set(INVITE_ID, row);

    const rebuilt = h.make();
    await rebuilt.advance();
    expect(rebuilt.view().stage).toBe("failed");
    expect(rebuilt.view().failure).toBe("interrupted");
  });

  it("终态落库后清理失败仍是终态", async () => {
    const h = makeHarness({ statuses: ["need_verifycode", "verify_code_blocked"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.advance();
    expect(login.view().stage).toBe("pin");

    h.secrets.failDeletes = true;
    await login.submitPin("123456");
    expect(h.state.rows.get(INVITE_ID)?.stage).toBe("failed");
    expect(h.state.rows.get(INVITE_ID)?.failure).toBe("pin_blocked");
    expect(login.view().stage).toBe("failed");

    await login.advance();
    expect(login.view().stage).toBe("failed");
    expect(h.saved).toHaveLength(0);

    // cancel 同理：清理失败不复活。
    const other = makeHarness({ statuses: ["wait"] });
    const cancelled = other.make();
    await cancelled.startOtherOwner();
    other.secrets.failDeletes = true;
    await cancelled.cancel();
    expect(other.state.rows.get(INVITE_ID)?.stage).toBe("cancelled");
    expect(cancelled.view().stage).toBe("cancelled");
  });

  it("已过期或已取消的邀请不发实名与取码请求", async () => {
    const expired = makeHarness({ expiresAt: NOW - 1 });
    const never = expired.make();
    await never.startOtherOwner();
    expect(expired.requests).toHaveLength(0);
    expect(expired.state.rows.size).toBe(0);
    expect(never.view().stage).toBe("idle");

    const h = makeHarness({ statuses: ["wait"] });
    const login = h.make();
    await login.startOtherOwner();
    await login.cancel();
    const before = h.requests.length;
    const rebuilt = h.make();
    await rebuilt.startOtherOwner();
    expect(h.requests).toHaveLength(before);
    expect(rebuilt.view().stage).toBe("cancelled");
  });

  it("换代必须显式 reset，旧实例不能隐式接管", async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecretStore();
    const current = makeHarness({ statuses: ["wait"], state, secrets });
    const currentLogin = current.make();
    await currentLogin.startOtherOwner();
    await currentLogin.cancel();

    // 更旧的 generation：不发请求、不写行、不删当前 generation。
    const stale = makeHarness({ statuses: ["wait"], state, secrets, generation: GENERATION - 1 });
    const staleLogin = stale.make();
    const rowsBefore = state.snapshot();
    const secretsBefore = secrets.at(INVITE_ID, GENERATION);
    await staleLogin.advance();
    await staleLogin.startOtherOwner();
    await staleLogin.reset();
    expect(state.snapshot()).toEqual(rowsBefore);
    expect(secrets.at(INVITE_ID, GENERATION)).toEqual(secretsBefore);
    expect(stale.requests).toHaveLength(0);

    // 更新的 generation 显式 reset 后才能接管。
    const fresh = makeHarness({ statuses: ["wait"], state, secrets, generation: GENERATION + 1 });
    const freshLogin = fresh.make();
    await freshLogin.reset();
    expect(state.rows.has(INVITE_ID)).toBe(false);
    expect(secrets.at(INVITE_ID, GENERATION)).toBeUndefined();
    await freshLogin.startOtherOwner();
    expect(state.rows.get(INVITE_ID)?.generation).toBe(GENERATION + 1);
    expect(fresh.requests.length).toBeGreaterThan(0);
  });

  it("共享 gate 时两个实例仍然只激活一次", async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecretStore();
    const gate = createLoginGate();
    const h = makeHarness({ statuses: ["confirmed", "confirmed"], state, secrets });
    const options = {
      inviteId: INVITE_ID,
      generation: GENERATION,
      expiresAt: NOW + 15 * 60_000,
      state,
      secrets,
      transport: h.transport,
      onConfirmed: async (credentials: WeChatCredentials) => {
        h.saved.push(credentials);
      },
      activationStatus: async () => (h.saved.length > 0 ? "committed" : "pending"),
      now: h.now,
      gate,
    };
    const seed = new WeChatLogin(options);
    await seed.startOtherOwner();
    const a = new WeChatLogin(options);
    const b = new WeChatLogin(options);
    await Promise.all([a.advance(), b.advance()]);
    expect(h.saved).toHaveLength(1);
    expect(state.rows.get(INVITE_ID)?.stage).toBe("confirmed");
  });
});

describe("WeChatLogin over the real iLink client", () => {
  it("网络故障可重试，不落终态", async () => {
    const h = makeWireHarness({
      responses: [
        realnameAuth(),
        realnameOk(),
        qrIssued(),
        json({ errmsg: "server down" }, 500),
        json({ status: "wait" }),
      ],
    });
    await h.login.startOtherOwner();
    expect(h.login.view().stage).toBe("scan");

    await h.login.advance();
    expect(h.login.view().stage).toBe("scan");
    expect(h.login.view().failure).toBeUndefined();

    await h.login.advance();
    expect(h.login.view().stage).toBe("scan");
    expect(h.secrets.at(INVITE_ID, GENERATION)?.qrcode).toBe("qr-1");
  });

  it("协议错误直接终止且不重试", async () => {
    const h = makeWireHarness({
      responses: [
        realnameAuth(),
        realnameOk(),
        qrIssued(),
        new Response("not json", { status: 200 }),
      ],
    });
    await h.login.startOtherOwner();
    await h.login.advance();

    expect(h.login.view().stage).toBe("failed");
    expect(h.login.view().failure).toBe("protocol");
    const calls = h.calls.length;
    await h.login.advance();
    expect(h.calls).toHaveLength(calls);
  });

  it("真实客户端的不可信重定向终止且不外发凭据", async () => {
    const h = makeWireHarness({
      responses: [
        realnameAuth(),
        realnameOk(),
        qrIssued(),
        json({ status: "scaned_but_redirect", baseurl: "https://evil.example.com" }),
      ],
    });
    await h.login.startOtherOwner();
    await h.login.advance();

    expect(h.login.view().stage).toBe("failed");
    expect(h.login.view().failure).toBe("untrusted_redirect");
    expect(h.calls.every((url) => !url.includes("evil.example.com"))).toBe(true);
  });

  it("上游 errmsg 回显 PIN 时不泄漏到页面状态", async () => {
    const h = makeWireHarness({
      responses: [
        realnameAuth(),
        realnameOk(),
        qrIssued(),
        json({ status: "need_verifycode" }),
        json({
          errcode: 7,
          errmsg: "verify_code 424242 spam-ticket-1 qr-1 secret-bot-token",
        }),
      ],
    });
    await h.login.startOtherOwner();
    await h.login.advance();
    expect(h.login.view().stage).toBe("pin");

    await h.login.submitPin("424242");
    expect(h.login.view().stage).toBe("failed");
    expect(h.login.view().failure).toBe("protocol");

    const view = JSON.stringify(h.login.view());
    const row = JSON.stringify([...h.state.rows.values()]);
    for (const secret of ["424242", "spam-ticket-1", "qr-1", "secret-bot-token"]) {
      expect(view).not.toContain(secret);
      expect(row).not.toContain(secret);
    }
  });

  it("请求超时中止后 PIN 不重放", async () => {
    const h = makeWireHarness({
      stepTimeoutMs: 25,
      responses: [
        realnameAuth(),
        realnameOk(),
        qrIssued(),
        json({ status: "need_verifycode" }),
        new Stall("TimeoutError"),
        json({ status: "wait" }),
      ],
    });
    await h.login.startOtherOwner();
    await h.login.advance();
    expect(h.login.view().stage).toBe("pin");

    await h.login.submitPin("424242");
    // 中止不是终态：回到 scan，且 PIN 不再出现在任何后续请求里。
    expect(h.login.view().stage).toBe("scan");
    expect(h.calls.at(-1)).toContain("verify_code=424242");

    await h.login.advance();
    expect(h.login.view().stage).toBe("scan");
    expect(h.calls.at(-1)).not.toContain("verify_code");
    expect(JSON.stringify([...h.state.rows.values()])).not.toContain("424242");
  });
});
