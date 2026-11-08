import { describe, expect, it, vi } from "vitest";
import { withFirstToken } from "../../src/llm/first-token";

const final = { type: "done", message: { content: [] } };

const start = { type: "start", partial: { content: [] } };
const thinking = { type: "thinking_delta", partial: { content: [{ type: "thinking" }] } };
const text = {
  type: "text_delta",
  partial: { content: [{ type: "thinking" }, { type: "text" }] },
};
const done = { type: "done", partial: { content: [{ type: "text" }] } };

function fakeModels(events: unknown[], result: unknown = final) {
  return {
    streamSimple: vi.fn((..._args: unknown[]) => ({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      result: async () => result,
    })),
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const forwarded: unknown[] = [];
  for await (const event of stream) forwarded.push(event);
  return forwarded;
}

describe("withFirstToken", () => {
  it("calls back once on the first event with content", async () => {
    const models = fakeModels([start, thinking, text, done]);
    const onFirstToken = vi.fn();
    const stream = withFirstToken(models, onFirstToken).streamSimple();

    const forwarded = await collect(stream);

    expect(onFirstToken).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveLength(4);
    [start, thinking, text, done].forEach((event, index) => {
      expect(forwarded[index]).toBe(event);
    });
    await expect(stream.result()).resolves.toBe(final);
  });

  it("does not call back when no event has content", async () => {
    const models = fakeModels([start, done]);
    const onFirstToken = vi.fn();

    await collect(withFirstToken(models, onFirstToken).streamSimple());

    expect(onFirstToken).not.toHaveBeenCalled();
  });

  it("calls back once per streamSimple call", async () => {
    const models = fakeModels([start, thinking, done]);
    const onFirstToken = vi.fn();
    const wrapped = withFirstToken(models, onFirstToken);

    await collect(wrapped.streamSimple());
    await collect(wrapped.streamSimple());

    expect(onFirstToken).toHaveBeenCalledTimes(2);
  });

  it("calls streamSimple with the collection as this", async () => {
    const models = fakeModels([start, text]);
    await collect(withFirstToken(models, () => {}).streamSimple());

    expect(models.streamSimple.mock.contexts[0]).toBe(models);
  });

  it("passes other members through bound to the target", () => {
    const models = {
      x: "value",
      getModel(this: { x: string }) {
        return this.x;
      },
      streamSimple: vi.fn(),
    };

    const wrapped = withFirstToken(models, () => {});

    expect(wrapped.getModel()).toBe("value");
  });

  it("propagates a stream error without calling back", async () => {
    const error = new Error("upstream exploded");
    const onFirstToken = vi.fn();
    const models = {
      streamSimple: vi.fn((..._args: unknown[]) => ({
        async *[Symbol.asyncIterator]() {
          throw error;
        },
        result: async () => final,
      })),
    };

    await expect(collect(withFirstToken(models, onFirstToken).streamSimple())).rejects.toBe(
      error,
    );
    expect(onFirstToken).not.toHaveBeenCalled();
  });

  it("keeps streaming when the callback throws", async () => {
    const models = fakeModels([start, thinking, text, done]);
    const onFirstToken = vi.fn(() => {
      throw new Error("callback broke");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const forwarded = await collect(withFirstToken(models, onFirstToken).streamSimple());

    expect(forwarded).toHaveLength(4);
    [start, thinking, text, done].forEach((event, index) => {
      expect(forwarded[index]).toBe(event);
    });
    expect(onFirstToken).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
