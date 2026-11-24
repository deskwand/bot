import { describe, expect, it, vi } from "vitest";
import { NO_ANSWER, quickLookup } from "../../src/butler/quick-lookup";

const hit = async (q: string) => ({ ok: true, text: `结果:${q}` });
const base = { locale: "zh" as const };

describe("quickLookup", () => {
  it("answers from the search results", async () => {
    let user = "";
    const out = await quickLookup(
      { question: "上海今天天气", queries: ["上海 天气"] },
      {
        ...base,
        search: hit,
        complete: async (_s, u) => {
          user = u;
          return "晴，18 度。";
        },
      },
    );
    expect(out).toEqual({ ok: true, answer: "晴，18 度。" });
    expect(user).toContain("结果:上海 天气");
    expect(user).toContain("上海今天天气");
  });

  it("uses the question when no queries are given", async () => {
    const search = vi.fn(hit);
    await quickLookup(
      { question: "茅台股价", queries: [] },
      { ...base, search, complete: async () => "1500" },
    );
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe("茅台股价");
  });

  it("runs at most three queries", async () => {
    const search = vi.fn(hit);
    await quickLookup(
      { question: "q", queries: ["a", "b", "c", "d"] },
      { ...base, search, complete: async () => "x" },
    );
    expect(search.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("fails when every search fails, without calling the model", async () => {
    const complete = vi.fn();
    const out = await quickLookup(
      { question: "q", queries: ["a"] },
      { ...base, search: async () => ({ ok: false, text: "搜索失败" }), complete },
    );
    expect(out).toEqual({ ok: false });
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails when the model says NO_ANSWER or returns blank", async () => {
    for (const reply of ["NO_ANSWER", "  "]) {
      expect(
        await quickLookup(
          { question: "q", queries: ["a"] },
          { ...base, search: hit, complete: async () => reply },
        ),
      ).toEqual({ ok: false });
    }
  });

  it("fails when the model throws", async () => {
    expect(
      await quickLookup(
        { question: "q", queries: ["a"] },
        {
          ...base,
          search: hit,
          complete: async () => {
            throw new Error("x");
          },
        },
      ),
    ).toEqual({ ok: false });
  });

  it("fails on timeout", async () => {
    const out = await quickLookup(
      { question: "q", queries: ["a"] },
      {
        ...base,
        search: () => new Promise(() => {}),
        complete: async () => "x",
        timeoutMs: 10,
      },
    );
    expect(out).toEqual({ ok: false });
  });

  it("cuts the answer to the limit", async () => {
    const out = await quickLookup(
      { question: "q", queries: ["a"] },
      { ...base, search: hit, complete: async () => "答".repeat(400) },
    );
    expect(out.ok && [...out.answer].length).toBe(300);
  });
});

describe("quickLookup minor mode", () => {
  it("tells the lookup the asker is a minor", async () => {
    let system = "";
    const out = await quickLookup(
      { question: "查一个不适合未成年人的问题", queries: ["q"] },
      {
        ...base,
        search: hit,
        teen: true,
        complete: async (prompt) => {
          system = prompt;
          return NO_ANSWER;
        },
      },
    );
    expect(out).toEqual({ ok: false });
    expect(system).toContain("提问的人是未成年人");
  });

  it("says nothing about minors by default", async () => {
    let system = "";
    await quickLookup(
      { question: "上海天气", queries: ["q"] },
      {
        ...base,
        search: hit,
        complete: async (prompt) => {
          system = prompt;
          return "晴";
        },
      },
    );
    expect(system).not.toContain("提问的人是未成年人");
  });
});
