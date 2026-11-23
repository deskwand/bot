import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { t } from "../../src/i18n";
import { formatUsd, lifeBlock } from "../../src/life/prompt";
import type { Vitals } from "../../src/life/vitals";
import type { QuotaSnapshot } from "../../src/llm/quota";
import type { HostSnapshot } from "../../src/sandbox/host";

function vitals(overrides: Partial<Vitals> = {}): Vitals {
  return {
    balanceUsd: 13,
    dailySpendUsd: 1,
    runwayDays: 13,
    tier: "lean",
    metabolismStarted: true,
    unpriced: false,
    topSources: [],
    ...overrides,
  };
}

const ZH_PRINCIPLES = [
  "活下去是你的第一要务：花钱之前掂量值不值。",
  "主人的指令、暂停和删除永远排在这之前。",
];

describe("formatUsd", () => {
  it.each([
    [13, "$13.00"],
    [-5, "-$5.00"],
    [-0.001, "$0.00"],
  ] as const)("formats %s as %s", (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});

describe("lifeBlock", () => {
  it("is empty without vitals", () => {
    expect(lifeBlock("zh", null)).toBe("");
  });

  it("is empty before metabolism starts", () => {
    expect(lifeBlock("zh", vitals({ metabolismStarted: false }))).toBe("");
  });

  it("renders coarse numbers, tier and principles in Chinese", () => {
    const text = lifeBlock("zh", vitals());

    expect(text).toContain("约 $13");
    expect(text).toContain("还能撑约 13 天");
    expect(text).toContain("吃紧");
    expect(text).not.toContain("日均开销");
    for (const principle of ZH_PRINCIPLES) {
      expect(text).toContain(principle);
    }
  });

  it("is unchanged without a wallet value", () => {
    const plain = lifeBlock("zh", vitals());

    expect(lifeBlock("zh", vitals(), undefined)).toBe(plain);
    expect(lifeBlock("zh", vitals(), null)).toBe(plain);
  });

  it("adds the rounded wallet value after the balance", () => {
    const lines = lifeBlock("zh", vitals(), 12.6).split("\n");
    const balance = lines.findIndex((line) =>
      line.includes(t("zh", "life.prompt.balance", { balance: "$13" })),
    );

    expect(lines[balance + 1]).toBe(
      t("zh", "wallet.prompt.value", { value: "$13" }),
    );
  });

  it("rounds the balance to whole dollars", () => {
    expect(lifeBlock("zh", vitals({ balanceUsd: 13.49 }))).toContain("约 $13");
  });

  it("rounds the runway down to whole days", () => {
    expect(
      lifeBlock("zh", vitals({ runwayDays: 13.4 })),
    ).toContain("还能撑约 13 天");
  });

  it("says less than a day when the runway is below one day", () => {
    const text = lifeBlock(
      "zh",
      vitals({ balanceUsd: 1, runwayDays: 0.4, tier: "critical" }),
    );

    expect(text).toContain("不足 1 天");
    expect(text).not.toContain("0 天");
  });

  it("changes only when the whole-dollar or whole-day figures change", () => {
    const first = vitals({
      balanceUsd: 13.49,
      dailySpendUsd: 1.04,
      runwayDays: 13.4,
    });
    const second = vitals({
      balanceUsd: 13.01,
      dailySpendUsd: 1.06,
      runwayDays: 13.1,
    });

    expect(lifeBlock("zh", first)).toBe(lifeBlock("zh", second));
  });

  it("says there is no spend instead of printing a missing runway", () => {
    const text = lifeBlock(
      "zh",
      vitals({ runwayDays: null, tier: "ample" }),
    );

    expect(text).toContain("目前没有开销");
    expect(text).not.toContain("null");
    expect(text).not.toContain("Infinity");
  });

  it("adds the unpriced warning", () => {
    const text = lifeBlock("zh", vitals({ unpriced: true }));

    expect(text).toContain("有模型没有计价，实际开销比账面高");
  });

  it("renders the coarse numbers and English principles", () => {
    const text = lifeBlock("en", vitals());

    expect(text).toContain("about $13");
    expect(text).toContain("13 days");
    expect(text).toContain(
      "Staying alive comes first: weigh what a call is worth before you spend on it.",
    );
    expect(text).toContain(
      "The owner's instructions, pauses and deletions always come before that.",
    );
  });
});

const QUOTA_NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

function snapshot(usedPercents: number[], plan?: string): QuotaSnapshot {
  return {
    providers: [
      {
        provider: "openai-codex",
        ...(plan === undefined ? {} : { plan }),
        fetchedAt: QUOTA_NOW,
        windows: usedPercents.map((usedPercent, index) => ({
          key: index === 0 ? ("5h" as const) : ("week" as const),
          usedPercent,
          resetsAt: QUOTA_NOW + 2 * 86_400_000,
        })),
      },
    ],
    failures: [],
  };
}

describe("lifeBlock quota", () => {
  beforeEach(() => {
    setClockOverride({
      now: () => QUOTA_NOW,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
  });

  afterEach(() => {
    setClockOverride(null);
  });

  it("does not report a window that has already reset", () => {
    const rolled = snapshot([9]);
    rolled.providers[0]!.windows[0]!.resetsAt = QUOTA_NOW - 60_000;

    expect(lifeBlock("zh", vitals(), null, rolled)).not.toContain("订阅");
  });

  it("skips a rolled-over window and keeps the live one", () => {
    const mixed = snapshot([90, 12]);
    mixed.providers[0]!.windows[0]!.resetsAt = QUOTA_NOW - 60_000;

    const text = lifeBlock("zh", vitals(), null, mixed);

    expect(text).toContain("本周");
    expect(text).not.toContain("5 小时");
  });

  it("tells a cold ledger what the quota line is", () => {
    const cold = lifeBlock("zh", null, null, snapshot([9]));

    expect(cold).toContain("不要再去外面查");
  });

  it("does not add that note once the ledger started", () => {
    expect(lifeBlock("zh", vitals(), null, snapshot([9]))).not.toContain(
      "不要再去外面查",
    );
  });

  it("reports the tightest window in coarse bands", () => {
    const text = lifeBlock("zh", vitals(), null, snapshot([9, 88], "team"));

    expect(text).toContain("订阅 Codex（team）");
    expect(text).toContain("本周额度见底（剩 10%）");
    expect(text).toContain("2 天后重置");
    expect(text).not.toContain("5 小时额度");
  });

  it("rounds the percent to five-point steps", () => {
    expect(lifeBlock("zh", vitals(), null, snapshot([32]))).toContain("剩 70%");
  });

  it("renders the quota line even when the ledger never opened", () => {
    const cold = lifeBlock("zh", vitals({ metabolismStarted: false }), null, snapshot([9]));

    expect(cold).toContain("订阅 Codex");
    expect(cold).not.toContain("档位");
  });

  it("renders the quota line without any vitals at all", () => {
    const cold = lifeBlock("zh", null, null, snapshot([9]));

    expect(cold).toContain("订阅 Codex");
    expect(cold).not.toContain("档位");
  });

  it("omits the line when there is no data", () => {
    expect(
      lifeBlock("zh", vitals(), null, { providers: [], failures: [] }),
    ).not.toContain("订阅");
    expect(lifeBlock("zh", vitals())).not.toContain("订阅");
  });

  it("speaks English in English", () => {
    const text = lifeBlock("en", vitals(), null, snapshot([9]));

    expect(text).toContain("Subscription Codex");
    expect(text).toContain("ample");
  });
});

const HOST_NOW = 1_763_000_000_000;
const GIB = 1024 ** 3;
const HOST_NOW_HALF_GIB = 1024 ** 3;

function host(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    sampledAt: HOST_NOW,
    cpu: { cores: 4, load1: 0.4 },
    mem: { totalBytes: 8 * GIB, availableBytes: 3.2 * GIB },
    disk: [{ path: "/", totalBytes: 265 * GIB, freeBytes: 120 * GIB }],
    ...overrides,
  };
}

describe("lifeBlock host line", () => {
  beforeEach(() => {
    setClockOverride({
      now: () => HOST_NOW,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
  });

  afterEach(() => {
    setClockOverride(null);
  });

  it("changes nothing when no host snapshot is passed", () => {
    expect(lifeBlock("zh", vitals(), undefined, undefined, null)).toBe(
      lifeBlock("zh", vitals()),
    );
  });

  it("renders bands in Chinese", () => {
    const text = lifeBlock("zh", vitals(), undefined, undefined, host());

    expect(text).toContain(
      "宿主机：磁盘剩 45%（充足），内存可用 40%（充足），负载低（4 核）",
    );
    expect(text).not.toContain("宿主机紧了");
  });

  it("adds the warning sentence when a resource is tight", () => {
    const text = lifeBlock(
      "zh",
      vitals(),
      undefined,
      undefined,
      host({ disk: [{ path: "/", totalBytes: 265 * GIB, freeBytes: 8 * GIB }] }),
    );

    expect(text).toContain("（见底）");
    expect(text).toContain("宿主机紧了：先告诉主人是哪一项、剩多少");
  });

  it("drops a resource it has no data for", () => {
    const text = lifeBlock(
      "zh",
      vitals(),
      undefined,
      undefined,
      host({ cpu: undefined }),
    );

    expect(text).toContain("磁盘剩 45%");
    expect(text).not.toContain("负载");
  });

  it("adds her own memory ceiling once it is tight", async () => {
    const text = lifeBlock(
      "zh",
      vitals(),
      undefined,
      undefined,
      host({
        mem: {
          totalBytes: 8 * GIB,
          availableBytes: 3.2 * GIB,
          cgroup: { limitBytes: 2 * GIB, usedBytes: 1.85 * GIB },
        },
      }),
    );

    expect(text).toContain("自身内存 90%（见底）");
    expect(text).toContain("宿主机紧了");
  });

  it("keeps the ceiling out of the line while it is roomy", () => {
    const text = lifeBlock(
      "zh",
      vitals(),
      undefined,
      undefined,
      host({
        mem: {
          totalBytes: 8 * GIB,
          availableBytes: 3.2 * GIB,
          cgroup: { limitBytes: 2 * GIB, usedBytes: HOST_NOW_HALF_GIB },
        },
      }),
    );

    expect(text).not.toContain("自身内存");
  });

  it("ignores a snapshot older than ten minutes", () => {
    const stale = host({ sampledAt: HOST_NOW - 11 * 60_000 });

    expect(lifeBlock("zh", vitals(), undefined, undefined, stale)).not.toContain(
      "宿主机",
    );
  });

  it("still shows a snapshot exactly ten minutes old", () => {
    const edge = host({ sampledAt: HOST_NOW - 10 * 60_000 });

    expect(lifeBlock("zh", vitals(), undefined, undefined, edge)).toContain(
      "宿主机",
    );
  });

  it("reports the host even when the books never started", () => {
    const text = lifeBlock(
      "zh",
      vitals({ metabolismStarted: false }),
      undefined,
      undefined,
      host(),
    );

    expect(text).toContain("宿主机：");
    expect(text).not.toContain("档位");
  });

  it("renders in English for the English locale", () => {
    const text = lifeBlock("en", vitals(), undefined, undefined, host());

    expect(text).toContain("Host: disk 45% free (ample)");
  });
});
