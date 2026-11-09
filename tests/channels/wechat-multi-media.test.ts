/**
 * 一条微信消息可以带多个图片或文件：多选发送和合并转发都会这样到达。
 * 每个 item 都要单独下发，否则主人只会被看到第一张。
 */
import { createCipheriv } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { MessageEvent } from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-owner";

const CREDS_A = {
  token: "token-a",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-a",
  userId: OWNER,
};

const KEY_HEX = "00112233445566778899aabbccddeeff";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";
const PLAIN = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

const ENV = env as unknown as Record<string, unknown>;

/** A fresh hub per test: a DO caches its route, so a reused name keeps it. */
let hubName = "wechat-multi-media";
let hubCounter = 0;

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName(hubName));
}

const events: MessageEvent[] = [];

/** Replaces the Butler RPC entry; the prototype patch outlives one instance. */
async function captureButler(): Promise<void> {
  const stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));
  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleMessage(evt: MessageEvent): Promise<void>;
    };
    proto.handleMessage = async (evt) => {
      events.push(evt);
    };
  });
}

async function cancelSchedules(): Promise<void> {
  await runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as {
      listSchedules(): Promise<{ id: string }[]>;
      cancelSchedule(id: string): Promise<boolean>;
    };
    for (const schedule of await target.listSchedules()) {
      await target.cancelSchedule(schedule.id);
    }
  });
}

async function pollOnce(): Promise<void> {
  await runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as { pollWeChat(): Promise<void> };
    await target.pollWeChat();
  });
  await cancelSchedules();
}

function readCursor(): Promise<string | null> {
  return runInDurableObject(channels(), (_instance, state) => {
    return (
      state.storage.sql
        .exec<{ cursor: string | null }>("SELECT cursor FROM wechat_state")
        .toArray()[0]?.cursor ?? null
    );
  });
}

/** Answers getupdates with `msgs` once, then an empty batch; CDN yields a PNG. */
function scriptedBatch(msgs: unknown[], cursor = "cursor-multi"): typeof fetch {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(KEY_HEX, "hex"), null);
  const ciphertext = new Uint8Array(
    Buffer.concat([cipher.update(PLAIN), cipher.final()]),
  );
  let first = true;
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/ilink/bot/getupdates")) {
      return new Response(ciphertext, { status: 200 });
    }
    const body = first ? { get_updates_buf: cursor, msgs } : { get_updates_buf: cursor, msgs: [] };
    first = false;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function imageItem(param: string) {
  return {
    type: 2,
    image_item: {
      media: { encrypt_query_param: param },
      aeskey: KEY_HEX,
    },
  };
}

function fileItem(param: string, name: string) {
  return {
    type: 4,
    file_item: {
      media: { encrypt_query_param: param, aes_key: KEY_HEX },
      file_name: name,
      len: "8",
    },
  };
}

beforeEach(async () => {
  events.length = 0;
  await cancelSchedules();
  hubName = `wechat-multi-media-${++hubCounter}`;
  ENV.ACTIVE_CHANNEL = "wechat";
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM owner_addresses");
    state.storage.sql.exec("DELETE FROM wechat_state");
    state.storage.sql.exec("DELETE FROM wechat_contexts");
  });
  await channels().ensurePolling();
  await cancelSchedules();
  await captureButler();
});

afterEach(() => {
  setILinkFetchOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  vi.restoreAllMocks();
});

describe("pollWeChat with several media in one message", () => {
  it("hands every image of one message to the Butler, in order", async () => {
    setILinkFetchOverride(
      scriptedBatch([
        {
          message_id: "multi",
          from_user_id: OWNER,
          context_token: "ctx",
          message_type: 1,
          item_list: [imageItem("p-1"), imageItem("p-2"), imageItem("p-3")],
        },
      ]),
    );

    await pollOnce();

    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events.map((event) => event.eventId)).toEqual([
      "wx:multi:0",
      "wx:multi:1",
      "wx:multi:2",
    ]);
    for (const event of events) {
      expect(event.images).toHaveLength(1);
      expect(event.images?.[0].mimeType).toBe("image/png");
      expect(event.text).toBeNull();
      expect(event.imageFailed).toBeUndefined();
    }
  });

  it("keeps the caption on the first item only", async () => {
    setILinkFetchOverride(
      scriptedBatch([
        {
          message_id: "caption",
          from_user_id: OWNER,
          context_token: "ctx",
          message_type: 1,
          item_list: [
            { type: 1, text_item: { text: "帮我看看这几张" } },
            imageItem("p-1"),
            fileItem("p-2", "报价单.pdf"),
          ],
        },
      ]),
    );

    await pollOnce();

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0].text).toBe("帮我看看这几张");
    expect(events[0].images).toHaveLength(1);
    expect(events[1].text).toBeNull();
    expect(events[1].files?.[0].name).toBe("报价单.pdf");
  });

  it("downloads one image at a time, even across messages", async () => {
    // 连发三张图会落进同一批或相邻两批。同时下载、同时解码会把 isolate 的
    // 128 MB 用完（Photon 的 wasm 堆不收缩），整个 DO 被杀，三张全丢。
    const batch = scriptedBatch(
      [1, 2, 3].map((n) => ({
        message_id: `m-${n}`,
        from_user_id: OWNER,
        context_token: "ctx",
        message_type: 1,
        item_list: [imageItem(`p-${n}`)],
      })),
    );
    let inFlight = 0;
    let peak = 0;
    setILinkFetchOverride((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/download")) return batch(input, init);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return batch(input, init);
    }) as typeof fetch);

    await pollOnce();

    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(peak).toBe(1);
  });

  it("advances the cursor only after the images are handled", async () => {
    // 处理途中被杀掉时 cursor 必须还没动，这一批才会被 iLink 重发；
    // 先存 cursor 再处理就等于把整批永久标成已读。
    const duringDownload: (string | null)[] = [];
    await runInDurableObject(channels(), async (instance, state) => {
      const batch = scriptedBatch([
        {
          message_id: "cursor-order",
          from_user_id: OWNER,
          context_token: "ctx",
          message_type: 1,
          item_list: [imageItem("p-1")],
        },
      ]);
      setILinkFetchOverride((async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/download")) {
          duringDownload.push(
            state.storage.sql
              .exec<{ cursor: string | null }>("SELECT cursor FROM wechat_state")
              .toArray()[0]?.cursor ?? null,
          );
        }
        return batch(input, init);
      }) as typeof fetch);
      await (
        instance as unknown as { pollWeChat(): Promise<void> }
      ).pollWeChat();
    });
    await cancelSchedules();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(duringDownload).toEqual([null]);
    expect(await readCursor()).toBe("cursor-multi");
  });

  it("keeps one event per update when a batch carries several messages", async () => {
    setILinkFetchOverride(
      scriptedBatch(
        [1, 2].map((n) => ({
          message_id: `m-${n}`,
          from_user_id: OWNER,
          context_token: "ctx",
          message_type: 1,
          item_list: [imageItem(`p-${n}`)],
        })),
      ),
    );

    await pollOnce();

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((event) => event.eventId)).toEqual(["wx:m-1", "wx:m-2"]);
  });

  it("does not let one unusable item hide the others", async () => {
    const fetchImpl = scriptedBatch([
      {
        message_id: "mixed",
        from_user_id: OWNER,
        context_token: "ctx",
        message_type: 1,
        item_list: [
          { type: 2, image_item: { media: { encrypt_query_param: "no-key" } } },
          imageItem("p-2"),
        ],
      },
    ]);
    // The first CDN download answers with bytes that are not a PNG.
    let downloads = 0;
    setILinkFetchOverride((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download")) {
        downloads += 1;
        if (downloads === 1) {
          return new Response(new TextEncoder().encode("not an image"), {
            status: 200,
          });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch);

    await pollOnce();

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0].eventId).toBe("wx:mixed:0");
    expect(events[0].imageFailed).toBe(true);
    expect(events[1].eventId).toBe("wx:mixed:1");
    expect(events[1].images).toHaveLength(1);
  });
});
