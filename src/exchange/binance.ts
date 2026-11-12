import { binanceGet, num, type HttpDeps } from "./http";
import {
  ExchangeError,
  FATAL_BUCKETS,
  type Balance,
  type Bucket,
  type ExchangeAccount,
  type FetchOptions,
  type VenueAdapter,
  type VenuePosition,
  type VenueSnapshot,
} from "./types";

const SUPPORTS: readonly Bucket[] = [
  "spot",
  "funding",
  "margin",
  "futures",
  "earn",
];

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === "object",
      )
    : [];
}

/** Binance mixes object and array payloads; this narrows the object case. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Currency → USDT price; USDT itself is 1, stablecoins need a direct pair. */
function priceMap(value: unknown): Map<string, number> {
  const map = new Map<string, number>([["USDT", 1]]);
  for (const row of rows(value)) {
    const symbol = row.symbol;
    const price = num(row.price);
    if (
      typeof symbol !== "string" ||
      price === undefined ||
      !symbol.endsWith("USDT")
    ) {
      continue;
    }
    map.set(symbol.slice(0, -4), price);
  }
  return map;
}

function valueOf(
  map: Map<string, number>,
  ccy: string,
  amount: number,
): number | undefined {
  const price = map.get(ccy);
  return price === undefined ? undefined : amount * price;
}

function balanceOf(
  map: Map<string, number>,
  bucket: Bucket,
  ccy: string,
  amount: number,
): Balance | null {
  if (amount === 0) return null;
  const value = valueOf(map, ccy, amount);
  return value === undefined
    ? { ccy, amount, bucket }
    : { ccy, amount, value, bucket };
}

function fromFreeLocked(
  map: Map<string, number>,
  bucket: Bucket,
  list: Record<string, unknown>[],
): Balance[] {
  const out: Balance[] = [];
  for (const row of list) {
    const ccy = row.asset;
    const free = num(row.free) ?? 0;
    const locked = num(row.locked) ?? 0;
    if (typeof ccy !== "string" || ccy === "") continue;
    const balance = balanceOf(map, bucket, ccy, free + locked);
    if (balance !== null) out.push(balance);
  }
  return out;
}

function sumValue(list: Balance[]): number | undefined {
  let total = 0;
  let known = false;
  for (const item of list) {
    if (item.value === undefined) continue;
    total += item.value;
    known = true;
  }
  return known ? total : undefined;
}

function positionOf(
  row: Record<string, unknown>,
  kind: VenuePosition["kind"],
): VenuePosition | null {
  const instrument = row.symbol;
  const qty = num(row.positionAmt);
  if (typeof instrument !== "string" || qty === undefined || qty === 0) {
    return null;
  }
  const position: VenuePosition = {
    instrument,
    kind,
    side: row.positionSide === "SHORT" || qty < 0 ? "short" : "long",
    qty: Math.abs(qty),
  };
  const entry = num(row.entryPrice);
  const mark = num(row.markPrice);
  const upl = num(row.unRealizedProfit);
  const liq = num(row.liquidationPrice);
  const leverage = num(row.leverage);
  if (entry !== undefined) position.entry = entry;
  if (mark !== undefined) position.mark = mark;
  if (upl !== undefined) position.upl = upl;
  if (liq !== undefined) position.liq = liq;
  if (leverage !== undefined) position.leverage = leverage;
  return position;
}

export const binanceAdapter: VenueAdapter = {
  id: "binance",
  label: "Binance",
  supports: SUPPORTS,

  async fetch(
    account: ExchangeAccount,
    opts: FetchOptions,
    signal: AbortSignal | undefined,
    deps: HttpDeps = {},
  ): Promise<VenueSnapshot> {
    const want = new Set(opts.include);
    const buckets: VenueSnapshot["buckets"] = [];
    const positions: VenuePosition[] = [];
    const degraded: VenueSnapshot["degraded"] = [];
    const fetchedAt = (deps.now ?? Date.now)();
    let primaryProven = false;

    // -2015 means "no permission for this endpoint" and also "bad key". Only
    // the primary call tells them apart, and the caller may not have asked for
    // spot, so it is issued before a part failure is blamed on the key. It
    // throws when the key really is bad, which ends the account.
    async function proveKey(): Promise<void> {
      if (primaryProven) return;
      await binanceGet(
        deps,
        account,
        "/api/v3/account",
        { omitZeroBalances: "true" },
        signal,
      );
      primaryProven = true;
    }

    async function soft<T>(
      part: VenueSnapshot["degraded"][number]["part"],
      run: () => Promise<T>,
    ): Promise<T | undefined> {
      try {
        return await run();
      } catch (error) {
        let reason = error instanceof ExchangeError ? error.bucket : "network";
        if (reason === "unknownKey") {
          await proveKey();
          // The key just read the primary endpoint, so this part is simply not
          // enabled; saying "not this key" here would blame a working key.
          reason = "refused";
        }
        if (FATAL_BUCKETS.includes(reason)) throw error;
        if (!degraded.some((item) => item.part === part)) {
          degraded.push({ part, reason });
        }
        return undefined;
      }
    }

    const needPrices =
      want.has("spot") ||
      want.has("funding") ||
      want.has("margin") ||
      want.has("earn") ||
      want.has("futures");
    const prices = needPrices
      ? priceMap(
          await soft("valuation", () =>
            binanceGet(deps, account, "/api/v3/ticker/price", {}, signal),
          ),
        )
      : new Map<string, number>([["USDT", 1]]);

    if (want.has("spot")) {
      const body = record(
        await binanceGet(
          deps,
          account,
          "/api/v3/account",
          { omitZeroBalances: "true" },
          signal,
        ),
      );
      primaryProven = true;
      const balances = fromFreeLocked(prices, "spot", rows(body.balances));
      buckets.push({ bucket: "spot", value: sumValue(balances), balances });
    }

    if (want.has("funding")) {
      const list = await soft("funding", () =>
        binanceGet(deps, account, "/sapi/v1/asset/get-funding-asset", {}, signal),
      );
      if (list !== undefined) {
        const balances = fromFreeLocked(prices, "funding", rows(list));
        buckets.push({ bucket: "funding", value: sumValue(balances), balances });
      }
    }

    if (want.has("margin")) {
      const cross = record(
        await soft("margin", () =>
          binanceGet(deps, account, "/sapi/v1/margin/account", {}, signal),
        ),
      );
      const isolated = record(
        await soft("margin", () =>
          binanceGet(
            deps,
            account,
            "/sapi/v1/margin/isolated/account",
            {},
            signal,
          ),
        ),
      );
      const balances: Balance[] = [];
      for (const row of rows(cross.userAssets)) {
        const ccy = row.asset;
        const net = num(row.netAsset);
        if (typeof ccy !== "string" || net === undefined) continue;
        const balance = balanceOf(prices, "margin", ccy, net);
        if (balance !== null) balances.push(balance);
      }
      for (const entry of rows(isolated.assets)) {
        for (const side of ["baseAsset", "quoteAsset"] as const) {
          const leg = entry[side];
          if (leg === null || typeof leg !== "object") continue;
          const legRecord = leg as Record<string, unknown>;
          const ccy = legRecord.asset;
          const net = num(legRecord.netAsset);
          if (typeof ccy !== "string" || net === undefined) continue;
          const balance = balanceOf(prices, "margin", ccy, net);
          if (balance !== null) balances.push(balance);
        }
      }
      buckets.push({ bucket: "margin", value: sumValue(balances), balances });
    }

    if (want.has("futures") || want.has("positions")) {
      const usdM = record(
        await soft("futures", () =>
          binanceGet(deps, account, "/fapi/v3/account", {}, signal),
        ),
      );
      if (Object.keys(usdM).length > 0) {
        const total = num(usdM.totalMarginBalance);
        const balances: Balance[] = [];
        for (const row of rows(usdM.assets)) {
          const ccy = row.asset;
          const amount = num(row.balance);
          if (typeof ccy !== "string" || amount === undefined) continue;
          const balance = balanceOf(prices, "futures", ccy, amount);
          if (balance !== null) balances.push(balance);
        }
        buckets.push(
          total === undefined
            ? { bucket: "futures", balances }
            : { bucket: "futures", value: total, balances },
        );
      }

      const risk = await soft("positions", () =>
        binanceGet(deps, account, "/fapi/v3/positionRisk", {}, signal),
      );
      for (const row of rows(risk)) {
        const position = positionOf(row, "futures");
        if (position !== null) positions.push(position);
      }

      const coinM = record(
        await soft("futures", () =>
          binanceGet(deps, account, "/dapi/v1/account", {}, signal),
        ),
      );
      const btc = num(coinM.totalMarginBalance);
      const btcPrice = prices.get("BTC");
      if (btc !== undefined && btcPrice !== undefined) {
        const existing = buckets.find((bucket) => bucket.bucket === "futures");
        if (existing === undefined) {
          buckets.push({ bucket: "futures", value: btc * btcPrice, balances: [] });
        } else if (existing.value !== undefined) {
          existing.value += btc * btcPrice;
        }
      }
    }

    if (want.has("earn")) {
      const flexible = record(
        await soft("earn", () =>
          binanceGet(
            deps,
            account,
            "/sapi/v1/simple-earn/flexible/position",
            { size: "100" },
            signal,
          ),
        ),
      );
      const locked = record(
        await soft("earn", () =>
          binanceGet(
            deps,
            account,
            "/sapi/v1/simple-earn/locked/position",
            { size: "100" },
            signal,
          ),
        ),
      );
      if (Object.keys(flexible).length > 0 || Object.keys(locked).length > 0) {
        const balances: Balance[] = [];
        for (const row of rows(flexible.rows)) {
          const ccy = row.asset;
          const amount = num(row.totalAmount);
          if (typeof ccy !== "string" || amount === undefined) continue;
          const balance = balanceOf(prices, "earn", ccy, amount);
          if (balance !== null) balances.push(balance);
        }
        for (const row of rows(locked.rows)) {
          const ccy = row.asset;
          const amount = num(row.amount);
          if (typeof ccy !== "string" || amount === undefined) continue;
          const balance = balanceOf(prices, "earn", ccy, amount);
          if (balance !== null) balances.push(balance);
        }
        buckets.push({ bucket: "earn", value: sumValue(balances), balances });
      }
    }

    const total = buckets.reduce<number | undefined>((sum, bucket) => {
      if (bucket.value === undefined) return sum;
      return (sum ?? 0) + bucket.value;
    }, undefined);

    return {
      venue: "binance",
      account: account.id,
      fetchedAt,
      total,
      buckets,
      positions,
      degraded,
    };
  },
};
