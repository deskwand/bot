import { describe, expect, it, vi } from "vitest";
import { persona } from "../../src/butler/persona";
import { t } from "../../src/i18n";
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

describe("wallet remittance notices", () => {
  const txUrl = "https://basescan.org/tx/0xabc123";

  const remit = (shortUsd: number): SpeakEvent => ({
    kind: "wallet.remit",
    id: "rem-1",
    usdc: 32,
    shortUsd,
    txUrl,
    body: "",
  });

  it.each(["zh", "en"] as const)(
    "gives the remittance fixed copy in %s",
    (locale) => {
      const text = fallbackText(remit(0), locale);

      expect(text.trim()).not.toBe("");
      expect(text).toContain("32.00");
      expect(text).toContain(txUrl);
      expect(text).toContain("rem-1");
      expect(text).not.toMatch(/还差|short/i);
    },
  );

  it("mentions the shortfall only when there is one", () => {
    const text = fallbackText(remit(12), "zh");

    expect(text).toContain("12.00");
    expect(text).toContain("还差");
  });

  it("renders the failing reason from its i18n key", () => {
    const text = fallbackText(
      {
        kind: "wallet.remitFailed",
        usdc: 32,
        reason: "wallet.error.reverted",
        body: "",
      },
      "zh",
    );

    expect(text).toContain("32.00");
    expect(text).toContain(t("zh", "wallet.error.reverted"));
  });

  it("gives a stuck swap its own fixed copy", () => {
    const event: SpeakEvent = {
      kind: "wallet.tradeStuck",
      reason: "wallet.notice.tradeStuck",
      body: "",
    };

    for (const locale of ["zh", "en"] as const) {
      expect(fallbackText(event, locale)).toBe(
        t(locale, "wallet.notice.tradeStuck"),
      );
    }
  });

  it.each(["zh", "en"] as const)(
    "gives the depleted notice the value in %s",
    (locale) => {
      const text = fallbackText(
        { kind: "wallet.depleted", valueUsd: 3.5, body: "" },
        locale,
      );

      expect(text.trim()).not.toBe("");
      expect(text).toContain("3.50");
      expect(text).toContain("5");
    },
  );

  it("does not call the model for a remittance notice", async () => {
    const complete = vi.fn();
    const event = remit(0);

    expect(await speak(event, deps(complete))).toBe(fallbackText(event, "zh"));
    expect(complete).not.toHaveBeenCalled();
  });
});
