import { describe, expect, it, vi } from "vitest";
import { transcribeVoice } from "../../src/channels/voice";

/** 记录收到的 audio 字段，其余原样返回。 */
function fakeAi(result: { text?: string } | Error = { text: "好的" }) {
  const calls: { model: string; audio: string }[] = [];
  return {
    calls,
    ai: {
      async run(model: string, inputs: { audio: string }) {
        calls.push({ model, audio: inputs.audio });
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

const BYTES = new Uint8Array([0, 1, 2, 253, 254, 255]);

/** 跨过 8192 的分块边界，尾块故意不整除。 */
const LONG_BYTES = Uint8Array.from({ length: 3 * 8192 + 5 }, (_, i) => 255 - (i % 256));

describe("transcribeVoice", () => {
  it("sends the audio as chunked base64 and returns trimmed text", async () => {
    const { ai, calls } = fakeAi({ text: "  提醒我开会 \n" });

    const text = await transcribeVoice(BYTES, ai);

    expect(text).toBe("提醒我开会");
    expect(calls).toEqual([
      {
        model: "@cf/openai/whisper-large-v3-turbo",
        audio: btoa("\x00\x01\x02\xfd\xfe\xff"),
      },
    ]);
  });

  it("concatenates chunks without losing a partial tail", async () => {
    const { ai, calls } = fakeAi({ text: "好" });

    await transcribeVoice(LONG_BYTES, ai);

    const expected = btoa(
      Array.from(LONG_BYTES, (byte) => String.fromCharCode(byte)).join(""),
    );
    expect(calls[0]?.audio).toBe(expected);
  });

  it("returns undefined for an empty transcript", async () => {
    const { ai } = fakeAi({ text: "   " });
    expect(await transcribeVoice(BYTES, ai)).toBeUndefined();
  });

  it("returns undefined when the model throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ai } = fakeAi(new Error("boom"));
    expect(await transcribeVoice(BYTES, ai)).toBeUndefined();
  });

  it("logs when the binding is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await transcribeVoice(BYTES, undefined)).toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("AI binding is missing"),
    );
  });
});
