import { describe, expect, it } from "vitest";
import {
  BIND_PIN_PATH,
  BIND_STATE_PATH,
  createMemberBindRoutes,
  type BindStateReply,
} from "../../src/members/bind-routes";
import { bindPageHtml, renderQrSvg, type BindPageCopy } from "../../src/members/bind-page";
import { zh } from "../../src/i18n/zh";

const COPY = zh.member.bindPage as BindPageCopy;
import type { InviteView } from "../../src/channels/wechat/login";

const TOKEN = "t".repeat(43);

function routes(reply: BindStateReply, seen: { pins: string[]; tokens: string[] } = { pins: [], tokens: [] }) {
  return createMemberBindRoutes({
    channel: {
      async memberBindState(token: string) {
        seen.tokens.push(token);
        return reply;
      },
      async submitMemberBindPin(token: string, pin: string) {
        seen.tokens.push(token);
        seen.pins.push(pin);
        return reply;
      },
    },
    publicBaseUrl: "https://bot.example",
    title: COPY.title,
    page: bindPageHtml(COPY, "https://bot.example"),
    renderQr: (text) => renderQrSvg(text, "<script>alert(1)</script>"),
  });
}

function view(overrides: Partial<InviteView> = {}): InviteView {
  return {
    inviteId: "inv-1",
    stage: "scan",
    expiresAt: Date.now() + 60_000,
    generation: 1,
    scanned: false,
    qrImage: "qr-payload",
    ...overrides,
  };
}

describe("member bind routes", () => {
  it("serves a self-contained page with no external loads", async () => {
    const res = await routes({ ok: true, view: view() }).fetch(
      new Request("https://bot.example/members/bind/"),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/https?:\/\/(?!bot\.example)/);
    expect(html).not.toContain("cdn");
  });

  it("returns state without raw qrcode text and with no-store headers", async () => {
    const res = await routes({ ok: true, view: view() }).fetch(
      new Request(`https://bot.example${BIND_STATE_PATH}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toContain("qrSvg");
    expect(body).not.toContain("qr-payload");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("rejects a query-string token, a bad token and a foreign origin", async () => {
    const handler = await (async () => routes({ ok: true, view: view() }))();
    const query = await handler.fetch(
      new Request(`https://bot.example${BIND_STATE_PATH}?token=${TOKEN}`),
    );
    expect(query.status).toBe(401);
    const missing = await handler.fetch(
      new Request(`https://bot.example${BIND_STATE_PATH}`),
    );
    expect(missing.status).toBe(401);
    const foreign = await handler.fetch(
      new Request(`https://bot.example${BIND_PIN_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ pin: "123456" }),
      }),
    );
    expect(foreign.status).toBe(403);
  });

  it("submits a valid PIN only and maps a dead invite to 410", async () => {
    const seen = { pins: [] as string[], tokens: [] as string[] };
    const handler = routes({ ok: true, view: view({ stage: "pin" }) }, seen);
    const bad = await handler.fetch(
      new Request(`https://bot.example${BIND_PIN_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: "https://bot.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ pin: "12" }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(seen.pins).toEqual([]);

    const ok = await handler.fetch(
      new Request(`https://bot.example${BIND_PIN_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: "https://bot.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ pin: "123456" }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(seen.pins).toEqual(["123456"]);
    expect(await ok.text()).not.toContain("123456");

    const gone = await routes({ ok: false, status: 410 }).fetch(
      new Request(`https://bot.example${BIND_STATE_PATH}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(gone.status).toBe(410);
  });
});
