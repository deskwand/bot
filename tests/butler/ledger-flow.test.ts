import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { LedgerStore, type LedgerRow } from "../../src/butler/ledger";
import { setChannelOverride } from "../../src/channels/override";
import { t } from "../../src/i18n";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** 真实的 8×8 纯色 PNG。 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

let route: RouteSnapshot;

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function message(evt: {
  text: string | null;
  eventId: string;
  images?: AdmittedMessage["images"];
}): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: evt.text,
    ...(evt.images === undefined ? {} : { images: evt.images }),
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

async function seedBot(
  stub: ReturnType<typeof butler>,
  id: string,
  name: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

function pending(stub: ReturnType<typeof butler>): Promise<{
  rows: LedgerRow[];
  ids: number[];
  omitted: number;
}> {
  return runInDurableObject(stub, (instance) => instance.ledger.pending());
}

/** The last user message the model saw, as plain text. */
function lastUserText(
  context: TranscriptContext | undefined,
): string | undefined {
  const last = context?.messages
    .filter((entry) => entry.role === "user")
    .at(-1);
  if (last === undefined) return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("butler ledger flow", () => {
  it("prefixes the next owner message with unread ledger lines", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。" },
        {
          text: "收到",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const stub = butler("ledger-flow-prefix");
    await seedBot(stub, "b1", "盯盘");
    await stub.notifyFromBot("b1", "价格回落了");

    await stub.handleMessage(
      message({ text: "然后呢", eventId: "ledger-flow:prefix" }),
    );

    const text = lastUserText(seen) ?? "";
    expect(text.startsWith(t("zh", "phone.ledgerHeader"))).toBe(true);
    expect(text).toContain("我对主人说了：价格回落了，跟你说一声。");
    expect(text.endsWith("然后呢")).toBe(true);
  });

  it("consumes the ledger once the message is accepted", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const texts: (string | undefined)[] = [];
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。" },
        {
          text: "第一次",
          observe: (context) => {
            texts.push(lastUserText(context));
          },
        },
        {
          text: "第二次",
          observe: (context) => {
            texts.push(lastUserText(context));
          },
        },
      ]),
    );
    const stub = butler("ledger-flow-consume");
    await seedBot(stub, "b1", "盯盘");
    await stub.notifyFromBot("b1", "价格回落了");

    await stub.handleMessage(
      message({ text: "然后呢", eventId: "ledger-flow:consume-1" }),
    );
    await stub.handleMessage(
      message({ text: "还有吗", eventId: "ledger-flow:consume-2" }),
    );

    expect(texts[0]).toContain("我对主人说了：价格回落了，跟你说一声。");
    expect(texts[1]).toBe("还有吗");
    expect(await pending(stub)).toEqual({ rows: [], ids: [], omitted: 0 });
  });

  it("keeps the ledger when the submit is rejected", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "收到" }, { text: "价格回落了，跟你说一声。" }]),
    );
    const stub = butler("ledger-flow-rejected");
    await seedBot(stub, "b1", "盯盘");

    const evt = message({ text: "你好", eventId: "ledger-flow:rejected" });
    await stub.handleMessage(evt);
    await stub.notifyFromBot("b1", "价格回落了");
    // Telegram redelivers the already accepted update: no second turn.
    await stub.handleMessage(evt);

    const unread = await pending(stub);
    expect(unread.rows).toHaveLength(1);
    expect(unread.rows[0]?.kind).toBe("butler.said");
    expect(unread.ids).toEqual(unread.rows.map((row) => row.id));
  });

  it("prefixes an image-only message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。" },
        {
          text: "看到了",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const stub = butler("ledger-flow-image");
    await seedBot(stub, "b1", "盯盘");
    await stub.notifyFromBot("b1", "价格回落了");

    await stub.handleMessage(
      message({
        text: null,
        images: [{ mimeType: "image/png", data: PNG_B64 }],
        eventId: "ledger-flow:image",
      }),
    );

    const last = seen?.messages
      .filter((entry) => entry.role === "user")
      .at(-1);
    expect(Array.isArray(last?.content)).toBe(true);
    if (!Array.isArray(last?.content)) throw new Error("expected image input");
    expect(last.content[1]).toEqual({
      type: "image",
      data: PNG_B64,
      mimeType: "image/png",
    });
    const textPart = last.content[0];
    expect(textPart.type).toBe("text");
    const text = textPart.type === "text" ? textPart.text : "";
    expect(text.startsWith(t("zh", "phone.ledgerHeader"))).toBe(true);
    expect(text).toContain("我对主人说了：价格回落了，跟你说一声。");
  });

  it("consumes the ledger when the owner addresses a bot", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。" },
        { text: "价格回落了，跟你说一声。" },
      ]),
    );
    const stub = butler("ledger-flow-direct");
    await seedBot(stub, "b1", "盯盘");
    await stub.notifyFromBot("b1", "价格回落了");

    await stub.handleMessage(
      message({ text: "@盯盘 最近怎样", eventId: "ledger-flow:direct" }),
    );

    expect(channel.sent.at(-1)?.text).toBe("价格回落了，跟你说一声。");
    const unread = await pending(stub);
    expect(unread.rows).toHaveLength(0);
  });

  it("ignores a ledger write failure", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "价格回落了，跟你说一声。" }]));
    const stub = butler("ledger-flow-failure");
    await seedBot(stub, "b1", "盯盘");
    vi.spyOn(LedgerStore.prototype, "add").mockImplementation(() => {
      throw new Error("ledger exploded");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const delivered = await stub.notifyFromBot("b1", "价格回落了");

    expect(delivered).toBe(true);
    expect(channel.sent.at(-1)?.text).toBe("价格回落了，跟你说一声。");
  });

  it("writes what the butler said as the ledger line", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "价格回落了，跟你说一声。" }]));
    const stub = butler("ledger-flow-notice");
    await seedBot(stub, "b1", "盯盘");

    await stub.botNotice("b1", "价格回落了");

    const unread = await pending(stub);
    expect(unread.rows).toHaveLength(1);
    expect(unread.rows[0]).toMatchObject({
      kind: "butler.said",
      refId: "b1",
      line: "我对主人说了：价格回落了，跟你说一声。",
    });
  });

  it("does not repeat the ledger across two close messages", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。" },
        { text: "收到" },
      ]),
    );
    const stub = butler("ledger-flow-close");
    await seedBot(stub, "b1", "盯盘");
    await stub.notifyFromBot("b1", "价格回落了");

    const inputs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submits = 0;
    await runInDurableObject(stub, (instance) => {
      const harness = (
        instance as unknown as {
          harness: {
            submit(
              input: string,
              options: { operationId: string },
            ): Promise<{ accepted: boolean }>;
            wait(operationId: string): Promise<{ status: string; text: string }>;
            pending(): Promise<unknown[]>;
          };
        }
      ).harness;
      harness.pending = async () => [];
      harness.submit = async (input) => {
        submits += 1;
        inputs.push(input);
        // Hold the first submit so the second message queues behind it.
        if (submits === 1) await gate;
        return { accepted: true };
      };
      harness.wait = async () => ({ status: "done", text: "" });
    });

    const first = stub.handleMessage(
      message({ text: "然后呢", eventId: "ledger-flow:close-1" }),
    );
    await vi.waitFor(() => expect(submits).toBe(1));
    const second = stub.handleMessage(
      message({ text: "还有吗", eventId: "ledger-flow:close-2" }),
    );
    release();
    await Promise.all([first, second]);

    expect(inputs[0]).toContain("我对主人说了：价格回落了，跟你说一声。");
    expect(inputs[1]).toBe("还有吗");
  });
});
