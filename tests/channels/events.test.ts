import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_ERROR_CODES,
  CHANNEL_EVENT_KEYS,
  CHANNEL_EVENTS,
  emitChannelEvent,
} from "../../src/channels/events";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const testEnv = env as unknown as Env;

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitChannelEvent", () => {
  it("writes one structured event with only allowlisted keys", () => {
    const lines = captureLogs();

    emitChannelEvent(testEnv, {
      channel: "wechat",
      event: "poll_ok",
    });

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(
      [...CHANNEL_EVENT_KEYS].filter((key) => key in event).sort(),
    );
    for (const key of Object.keys(event)) {
      expect(CHANNEL_EVENT_KEYS).toContain(key);
    }
    expect(event).toMatchObject({
      deskwand: "channel_event",
      v: 1,
      channel: "wechat",
      event: "poll_ok",
    });
    expect(event.versionId).toBe(testEnv.CF_VERSION_METADATA.id);
    expect(typeof event.at).toBe("string");
    expect(Number.isNaN(Date.parse(String(event.at)))).toBe(false);
  });

  it("emits every documented event name", () => {
    const lines = captureLogs();
    for (const event of CHANNEL_EVENTS) {
      emitChannelEvent(testEnv, { channel: "telegram", event });
    }

    expect(lines).toHaveLength(CHANNEL_EVENTS.length);
    expect(
      lines.map((line) => (JSON.parse(line) as { event: string }).event),
    ).toEqual([...CHANNEL_EVENTS]);
  });

  it("keeps only allowlisted error codes and drops unknown runtime fields", () => {
    const lines = captureLogs();
    const sentinel = "SENTINEL-raw-provider-error-message";
    const input = {
      channel: "wechat",
      event: "poll_error",
      errorCode: sentinel,
      message: sentinel,
      text: sentinel,
      token: sentinel,
      userId: sentinel,
    };

    emitChannelEvent(testEnv, input as never);

    const line = lines[0]!;
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(line).not.toContain(sentinel);
    expect(event.errorCode).toBe("unknown");
    expect(event).not.toHaveProperty("message");
    expect(event).not.toHaveProperty("text");
    expect(event).not.toHaveProperty("token");
    expect(event).not.toHaveProperty("userId");
  });

  it("never logs sentinel credential values from the input", () => {
    const lines = captureLogs();
    const sentinel = "123456:AAAAAAAAA-sentinel-bot-token";

    emitChannelEvent(testEnv, {
      channel: "telegram",
      event: "webhook_rejected",
      errorCode: sentinel,
    });

    expect(lines[0]).not.toContain(sentinel);
    expect(lines[0]).not.toContain("bot-token");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      errorCode: "unknown",
      event: "webhook_rejected",
    });
  });

  it("rejects an out-of-enum channel without leaking it", () => {
    const lines = captureLogs();
    const sentinel = "SENTINEL-channel";

    emitChannelEvent(testEnv, {
      channel: sentinel,
      event: "send_ok",
    } as never);

    expect(lines[0]).not.toContain(sentinel);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      channel: "unknown",
      event: "send_ok",
    });
  });

  it("accepts fixed error codes unchanged", () => {
    const lines = captureLogs();

    emitChannelEvent(testEnv, {
      channel: "wechat",
      event: "poll_expired",
      errorCode: CHANNEL_ERROR_CODES[0],
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      errorCode: "session_expired",
    });
  });
});
