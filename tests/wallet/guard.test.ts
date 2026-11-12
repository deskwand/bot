import { describe, expect, it } from "vitest";
import { checkRemit, remitAmountUsd } from "../../src/wallet/guard";

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
