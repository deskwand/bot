import { describe, expect, it, vi } from "vitest";
import { persona } from "../../src/butler/persona";
import {
  fallbackText,
  speak,
  type SpeakComplete,
  type SpeakEvent,
} from "../../src/butler/speaker";

const deps = (complete: SpeakComplete) =>
  ({ complete, locale: "zh" as const, channelName: null, recent: [] });
const done = (body: string): SpeakEvent =>
  ({ kind: "task.completed", title: "查机票", body });

describe("speak", () => {
  it("rewrites a short result", async () => {
    const out = await speak(
      done("最早 7:20 东航 680 元"),
      deps(async () => "查到了，最早 7:20 的东航，680 元。"),
    );
    expect(out).toBe("查到了，最早 7:20 的东航，680 元。");
  });

  it("sends the original when a number is lost", async () => {
    const out = await speak(
      done("最早 7:20 东航 680 元"),
      deps(async () => "查到了，早上有一班东航。"),
    );
    expect(out).toBe("最早 7:20 东航 680 元");
  });

  it("treats a reformatted number as lost", async () => {
    const out = await speak(
      done("茅台 1,500 元"),
      deps(async () => "茅台 1500 元了。"),
    );
    expect(out).toBe("茅台 1,500 元");
  });

  it("sends the original when a link is lost", async () => {
    const src = "订票页 https://example.com/a?b=1";
    expect(await speak(done(src), deps(async () => "订票页找到了。"))).toBe(src);
  });

  it("keeps a long result verbatim behind a lead-in", async () => {
    const long = "航".repeat(601);
    expect(
      await speak(done(long), deps(async () => "机票查到了，比较长：")),
    ).toBe(`机票查到了，比较长：\n\n${long}`);
  });

  it("drops an over-long lead-in", async () => {
    const long = "航".repeat(601);
    expect(await speak(done(long), deps(async () => "引".repeat(41)))).toBe(
      long,
    );
  });

  it("sends the original when the model returns blank", async () => {
    expect(await speak(done("结果 1"), deps(async () => "  \n"))).toBe(
      "结果 1",
    );
  });

  it("sends the original when the model throws", async () => {
    expect(
      await speak(
        done("结果 1"),
        deps(async () => {
          throw new Error("x");
        }),
      ),
    ).toBe("结果 1");
  });

  it("sends the original on timeout", async () => {
    const never: SpeakComplete = () => new Promise(() => {});
    expect(await speak(done("结果 1"), { ...deps(never), timeoutMs: 10 })).toBe(
      "结果 1",
    );
  });

  it("says a task with no summary is done without calling the model", async () => {
    const complete = vi.fn();
    expect(await speak(done(""), deps(complete))).toBe("「查机票」办好了。");
    expect(complete).not.toHaveBeenCalled();
  });

  it("passes recent openings and the persona to the model", async () => {
    let seen = { system: "", user: "" };
    await speak(done("结果 1"), {
      ...deps(async (system, user) => {
        seen = { system, user };
        return "好了，结果 1";
      }),
      recent: ["查到了"],
    });
    expect(seen.system).toContain(persona("zh", null));
    expect(seen.user).toContain("查到了");
  });
});

describe("fallbackText", () => {
  it("adds the retry question to a retryable failure fallback", () => {
    expect(
      fallbackText(
        { kind: "task.failed", title: "查机票", body: "超时", retryable: true },
        "zh",
      ),
    ).toBe("「查机票」没办成：超时\n要我重试吗？");
  });
});

describe("life tier notices", () => {
  const tiers = ["ample", "lean", "critical", "dormant"] as const;

  it("gives every tier its own non-empty notice", () => {
    const texts = tiers.map((tier) =>
      fallbackText(
        { kind: "life.tier", tier, runwayDays: 5, body: "" },
        "zh",
      ),
    );

    for (const text of texts) expect(text.trim()).not.toBe("");
    expect(new Set(texts).size).toBe(tiers.length);
  });

  it("tells the runway in the critical notice", () => {
    expect(
      fallbackText(
        { kind: "life.tier", tier: "critical", runwayDays: 2.5, body: "" },
        "zh",
      ),
    ).toContain("2.5");
  });

  it("does not call the model for a tier change", async () => {
    const complete = vi.fn();
    const event: SpeakEvent = {
      kind: "life.tier",
      tier: "lean",
      runwayDays: 9,
      body: "",
    };

    expect(await speak(event, deps(complete))).toBe(fallbackText(event, "zh"));
    expect(complete).not.toHaveBeenCalled();
  });
});
