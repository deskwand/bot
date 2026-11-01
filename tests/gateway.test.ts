import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../src/channels/types";
import { createGateway } from "../src/gateway";
import type { ActionEvent, InboundEvent, MessageEvent } from "../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER_ID = 7;

const MESSAGE: MessageEvent = {
  type: "message",
  channel: "telegram",
  chatId: "42",
  userId: String(OWNER_ID),
  text: "hi",
  eventId: "tg:1",
};

const NON_TEXT_MESSAGE: MessageEvent = { ...MESSAGE, text: null, eventId: "tg:2" };

const ACTION: ActionEvent = {
  type: "action",
  channel: "telegram",
  chatId: "42",
  userId: String(OWNER_ID),
  actionId: "cb-1",
  messageId: "9",
  action: "cancel",
  taskId: "t1",
  eventId: "tg:3",
};

function fakeAdapter(inbound: InboundEvent | null) {
  const answered: Array<{ actionId: string; text?: string }> = [];
  const adapter: ChannelAdapter = {
    parseInbound: async () => inbound,
    send: async () => ({ messageId: "1" }),
    edit: async () => {},
    answerAction: async (actionId, text) => {
      answered.push({ actionId, text });
    },
  };
  return { adapter, answered };
}

function fakeContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, drain: () => Promise.all(pending) };
}

function setup(inbound: InboundEvent | null, hold?: Promise<void>) {
  const { adapter, answered } = fakeAdapter(inbound);
  const messages: MessageEvent[] = [];
  const actions: Array<{ taskId: string; event: ActionEvent }> = [];

  const gateway = createGateway({
    adapter,
    isOwner: (userId) => userId === OWNER_ID,
    butler: () => ({
      onMessage: async (event) => {
        messages.push(event);
        if (hold) await hold;
      },
    }),
    task: (taskId) => ({
      handleAction: async (event) => {
        actions.push({ taskId, event });
        return "已处理";
      },
    }),
    artifacts: env.ARTIFACTS,
  });

  const { ctx, drain } = fakeContext();
  return { gateway, ctx, drain, messages, actions, answered };
}

function webhook(): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
  });
}

describe("POST /telegram/webhook", () => {
  it("returns 200 and ignores updates that fail authentication", async () => {
    const h = setup(null);

    const response = await h.gateway.fetch(webhook(), h.ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(h.messages).toHaveLength(0);
    expect(h.actions).toHaveLength(0);
  });

  it("returns 200 and warns for a non-owner user", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = setup({ ...MESSAGE, userId: "999" });

    const response = await h.gateway.fetch(webhook(), h.ctx);

    expect(response.status).toBe(200);
    expect(h.messages).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dispatches a text message through waitUntil without blocking", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup(MESSAGE, hold);

    const response = await h.gateway.fetch(webhook(), h.ctx);

    expect(response.status).toBe(200);
    expect(h.messages).toEqual([MESSAGE]);
    release();
    await h.drain();
  });

  it("dispatches a non-text message with text null", async () => {
    const h = setup(NON_TEXT_MESSAGE);

    const response = await h.gateway.fetch(webhook(), h.ctx);

    expect(response.status).toBe(200);
    expect(h.messages).toEqual([NON_TEXT_MESSAGE]);
    await h.drain();
  });

  it("routes a button to the matching task and answers the callback", async () => {
    const h = setup(ACTION);

    const response = await h.gateway.fetch(webhook(), h.ctx);

    expect(response.status).toBe(200);
    expect(h.actions).toEqual([{ taskId: "t1", event: ACTION }]);
    expect(h.answered).toEqual([{ actionId: "cb-1", text: "已处理" }]);
    expect(h.messages).toHaveLength(0);
  });

  it("returns 200 and answers with an error when handleAction throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answered: Array<{ actionId: string; text?: string }> = [];
    const gateway = createGateway({
      adapter: {
        parseInbound: async () => ACTION,
        send: async () => ({ messageId: "1" }),
        edit: async () => {},
        answerAction: async (actionId, text) => {
          answered.push({ actionId, text });
        },
      },
      isOwner: () => true,
      butler: () => ({ onMessage: async () => {} }),
      task: () => ({
        handleAction: async () => {
          throw new Error("boom");
        },
      }),
      artifacts: env.ARTIFACTS,
    });
    const ctx = fakeContext();

    const response = await gateway.fetch(webhook(), ctx.ctx);

    expect(response.status).toBe(200);
    expect(answered).toEqual([
      { actionId: "cb-1", text: "出错了，稍后再试" },
    ]);
  });

  it("returns 200 even when answering the callback throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gateway = createGateway({
      adapter: {
        parseInbound: async () => ACTION,
        send: async () => ({ messageId: "1" }),
        edit: async () => {},
        answerAction: async () => {
          throw new Error("telegram down");
        },
      },
      isOwner: () => true,
      butler: () => ({ onMessage: async () => {} }),
      task: () => ({ handleAction: async () => "已处理" }),
      artifacts: env.ARTIFACTS,
    });
    const ctx = fakeContext();

    const response = await gateway.fetch(webhook(), ctx.ctx);

    expect(response.status).toBe(200);
  });

  it("returns 200 when parsing the update throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gateway = createGateway({
      adapter: {
        parseInbound: async () => {
          throw new Error("bad json");
        },
        send: async () => ({ messageId: "1" }),
        edit: async () => {},
        answerAction: async () => {},
      },
      isOwner: () => true,
      butler: () => ({ onMessage: async () => {} }),
      task: () => ({ handleAction: async () => "已处理" }),
      artifacts: env.ARTIFACTS,
    });
    const ctx = fakeContext();

    const response = await gateway.fetch(webhook(), ctx.ctx);

    expect(response.status).toBe(200);
  });
});

describe("GET /a/<key>", () => {
  it("returns 404 for a missing artifact", async () => {
    const h = setup(null);

    const response = await h.gateway.fetch(
      new Request("https://example.com/a/missing"),
      h.ctx,
    );

    expect(response.status).toBe(404);
  });

  it("serves an allowlisted artifact inline with hardening headers", async () => {
    await env.ARTIFACTS.put("t1/u/r.md", "hi", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const h = setup(null);

    const response = await h.gateway.fetch(
      new Request("https://example.com/a/t1/u/r.md"),
      h.ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi");
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it.each(["text/html", "image/svg+xml"])(
    "forces a %s artifact to download as octet-stream",
    async (contentType) => {
      const key = `t1/u/${contentType.replace("/", "-")}`;
      await env.ARTIFACTS.put(key, "<script>alert(1)</script>", {
        httpMetadata: { contentType },
      });
      const h = setup(null);

      const response = await h.gateway.fetch(
        new Request(`https://example.com/a/${key}`),
        h.ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
    },
  );
});

describe("worker entry", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/unknown");

    expect(response.status).toBe(404);
  });
});
