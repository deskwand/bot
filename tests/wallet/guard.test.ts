import { describe, expect, it } from "vitest";
import type { Token } from "../../src/wallet/chain";
import {
  breakerTripped,
  checkRemit,
  checkSwap,
  GAS_RESERVE_WEI,
  lossWindowStart,
  minOut,
  parseTokenAmount,
  remitAmountUsd,
  type Holdings,
  type SwapCheck,
} from "../../src/wallet/guard";

describe("checkRemit", () => {
  it("rejects a zero amount", () => {
    expect(checkRemit(0n, 100_000_000n)).toBe("bad_amount");
  });

  it("rejects an amount below the five-dollar minimum", () => {
    expect(checkRemit(4_990_000n, 100_000_000n)).toBe("below_min");
  });

  it("accepts exactly the minimum when the balance covers it", () => {
    expect(checkRemit(5_000_000n, 5_000_000n)).toBeNull();
  });

  it("rejects an amount one unit larger than the balance", () => {
    expect(checkRemit(5_000_001n, 5_000_000n)).toBe("insufficient");
  });
});

function holdings(over: Partial<Holdings> = {}): Holdings {
  return {
    ethWei: GAS_RESERVE_WEI,
    tokens: { USDC: 100_000_000n, WETH: 0n, cbBTC: 0n },
    valueUsd: 100,
    ...over,
  };
}

function swapCheck(over: Partial<SwapCheck> = {}): SwapCheck {
  return {
    sell: "USDC" as Token,
    buy: "WETH" as Token,
    amountIn: 10_000_000n,
    amountInUsd: 10,
    holdings: holdings(),
    realizedLossUsd: 0,
    feeTier: 3000,
    whitelisted: true,
    ...over,
  };
}

describe("checkSwap", () => {
  it("accepts a trade that satisfies every rule", () => {
    expect(checkSwap(swapCheck())).toBeNull();
  });

  it("rejects a token outside the whitelist", () => {
    expect(checkSwap(swapCheck({ whitelisted: false }))).toBe(
      "not_whitelisted",
    );
  });

  it("rejects selling and buying the same token", () => {
    expect(checkSwap(swapCheck({ buy: "USDC" }))).toBe("same_token");
  });

  it("rejects a pair without a fee tier", () => {
    expect(checkSwap(swapCheck({ feeTier: undefined }))).toBe("no_pool");
  });

  it("rejects a non-positive amount", () => {
    expect(checkSwap(swapCheck({ amountIn: 0n }))).toBe("bad_amount");
    expect(checkSwap(swapCheck({ amountIn: -1n }))).toBe("bad_amount");
  });

  it("rejects trading below five dollars of value", () => {
    expect(
      checkSwap(
        swapCheck({
          amountInUsd: 1,
          holdings: holdings({ valueUsd: 4.99 }),
        }),
      ),
    ).toBe("depleted");
  });

  it("rejects a loss at exactly ten percent of the value", () => {
    expect(
      checkSwap(
        swapCheck({
          amountInUsd: 1,
          realizedLossUsd: 3,
          holdings: holdings({ valueUsd: 30 }),
        }),
      ),
    ).toBe("breaker");
  });

  it("rejects when the ETH balance is one wei short of the gas reserve", () => {
    expect(
      checkSwap(
        swapCheck({ holdings: holdings({ ethWei: GAS_RESERVE_WEI - 1n }) }),
      ),
    ).toBe("gas_low");
  });

  it("rejects more than the wallet holds", () => {
    expect(
      checkSwap(
        swapCheck({
          amountIn: 100_000_001n,
          amountInUsd: 1,
          holdings: holdings({ tokens: { USDC: 100_000_000n, WETH: 0n, cbBTC: 0n } }),
        }),
      ),
    ).toBe("insufficient");
  });

  it("rejects a trade larger than a quarter of the value", () => {
    expect(
      checkSwap(swapCheck({ amountInUsd: 25.01 })),
    ).toBe("too_large");
  });

  it("checks depletion before the trade size", () => {
    expect(
      checkSwap(
        swapCheck({
          amountInUsd: 10,
          holdings: holdings({ valueUsd: 4.99 }),
        }),
      ),
    ).toBe("depleted");
  });

  describe("boundaries", () => {
    it("accepts exactly a quarter of the value", () => {
      expect(checkSwap(swapCheck({ amountInUsd: 25 }))).toBeNull();
    });

    it("accepts exactly the gas reserve", () => {
      expect(
        checkSwap(swapCheck({ holdings: holdings({ ethWei: GAS_RESERVE_WEI }) })),
      ).toBeNull();
    });

    it("accepts exactly five dollars of value", () => {
      expect(
        checkSwap(
          swapCheck({
            amountInUsd: 1,
            holdings: holdings({ valueUsd: 5 }),
          }),
        ),
      ).toBeNull();
    });

    it("accepts a loss just below ten percent", () => {
      expect(
        checkSwap(
          swapCheck({
            amountInUsd: 1,
            realizedLossUsd: 2.99,
            holdings: holdings({ valueUsd: 30 }),
          }),
        ),
      ).toBeNull();
    });
  });
});

describe("breakerTripped", () => {
  it("trips at exactly ten percent and holds below it", () => {
    expect(breakerTripped(3, 30)).toBe(true);
    expect(breakerTripped(2.99, 30)).toBe(false);
    expect(breakerTripped(0, 0)).toBe(false);
    expect(breakerTripped(0.01, 0)).toBe(true);
  });
});

describe("minOut", () => {
  it("keeps ninety-nine percent, rounding down", () => {
    expect(minOut(1000n)).toBe(990n);
    expect(minOut(1n)).toBe(0n);
  });
});

describe("lossWindowStart", () => {
  it("starts at UTC midnight when nothing resumed today", () => {
    const now = Date.UTC(2030, 0, 1, 3, 0, 0);
    expect(lossWindowStart(now, null)).toBe(Date.UTC(2030, 0, 1));
  });

  it("starts at the last resume when it is later", () => {
    const now = Date.UTC(2030, 0, 1, 3, 0, 0);
    expect(lossWindowStart(now, Date.UTC(2030, 0, 1, 2, 0, 0))).toBe(
      Date.UTC(2030, 0, 1, 2, 0, 0),
    );
  });
});

describe("parseTokenAmount", () => {
  it("parses a decimal amount into base units", () => {
    expect(parseTokenAmount("0.5", 18)).toBe(500_000_000_000_000_000n);
    expect(parseTokenAmount("12", 6)).toBe(12_000_000n);
  });

  it("rejects more decimals than the token has", () => {
    expect(parseTokenAmount("1.1234567", 6)).toBeNull();
  });

  it("rejects negative, empty and non-numeric input", () => {
    expect(parseTokenAmount("-1", 6)).toBeNull();
    expect(parseTokenAmount("", 6)).toBeNull();
    expect(parseTokenAmount("abc", 6)).toBeNull();
  });
});

describe("remitAmountUsd", () => {
  it("tops the balance up to 21 days of spending", () => {
    expect(remitAmountUsd(2, 10)).toBe(32);
  });

  it("never remits when the balance already covers 21 days", () => {
    expect(remitAmountUsd(1, 30)).toBe(0);
  });

  it("rounds a fractional need up and clamps a negative balance", () => {
    expect(remitAmountUsd(0.5, -3)).toBe(14);
  });
});
