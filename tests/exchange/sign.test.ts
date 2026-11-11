import { describe, expect, it } from "vitest";
import {
  BINANCE_POST_READS,
  binanceSignature,
  okxSignature,
  okxTimestamp,
} from "../../src/exchange/http";

describe("venue signatures", () => {
  it("signs a Binance query string as lowercase hex", async () => {
    const query = "timestamp=1700000000000&recvWindow=5000&omitZeroBalances=true";
    await expect(binanceSignature("test-binance-secret", query)).resolves.toBe(
      "fff769b435ccbb9ec8bdae742a4d817bb94b861bb257e97f5f070b1c896efcce",
    );
  });

  it("signs an OKX prehash as base64 of the raw digest", async () => {
    await expect(
      okxSignature(
        "test-okx-secret",
        "2026-11-11T08:00:00.000Z",
        "/api/v5/account/balance?ccy=USDT",
      ),
    ).resolves.toBe("PFSzYHAgUNmjoVfphCIqx25TPKPQHcVcxCY3FG4cPTw=");
  });

  it("pins the read-only POST allowlist to the funding wallet", () => {
    expect([...BINANCE_POST_READS]).toEqual([
      "/sapi/v1/asset/get-funding-asset",
    ]);
  });

  it("formats the OKX timestamp as ISO 8601 with milliseconds", () => {
    expect(okxTimestamp(1794384000000)).toBe("2026-11-11T08:00:00.000Z");
  });
});
