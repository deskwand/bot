import { describe, expect, it } from "vitest";
import { isRetryableSend, withRetry } from "../../src/channels/retry";
import { ChannelError } from "../../src/channels/types";
import { ILinkError } from "../../src/channels/wechat/ilink";

describe("isRetryableSend", () => {
  it("retries network and 5xx failures", () => {
    expect(isRetryableSend(new Error("fetch failed"))).toBe(true);
    expect(isRetryableSend(new ChannelError("network", 0))).toBe(true);
    expect(isRetryableSend(new ChannelError("upstream", 503))).toBe(true);
  });

  it("does not retry a 4xx", () => {
    expect(isRetryableSend(new ChannelError("bad request", 400))).toBe(false);
    expect(isRetryableSend(new ChannelError("too large", 413))).toBe(false);
  });

  it("treats iLink failures by their HTTP status, not as opaque errors", () => {
    // iLink rejects an upload with a 4xx; re-encrypting 15 MB three times to
    // get the same rejection wastes the isolate's CPU budget.
    expect(isRetryableSend(new ILinkError("rejected", -2, 403))).toBe(false);
    expect(isRetryableSend(new ILinkError("untrusted", undefined, 0))).toBe(true);
    expect(isRetryableSend(new ILinkError("upstream", undefined, 502))).toBe(true);
  });
});

describe("withRetry", () => {
  it("gives up after three attempts and replays the last error", async () => {
    const delays: number[] = [];
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ChannelError("upstream", 503);
        },
        { sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toBeInstanceOf(ChannelError);

    expect(calls).toBe(3);
    expect(delays).toEqual([200, 600]);
  });

  it("returns the first success and stops", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new ChannelError("upstream", 500);
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms) },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([200]);
  });

  it("stops immediately on a 4xx", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ChannelError("bad request", 400);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(calls).toBe(1);
  });
});
