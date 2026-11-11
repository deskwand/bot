import { num, okxGet, type HttpDeps } from "./http";
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

/** OKX margin and options live in the trading account; no separate balance endpoint. */
const SUPPORTS: readonly Bucket[] = ["spot", "funding", "futures", "earn"];

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === "object",
      )
    : [];
}

function balancesOf(
  list: Record<string, unknown>[],
  bucket: Bucket,
  amountKey: string,
  valueKey?: string,
): Balance[] {
  const out: Balance[] = [];
  for (const row of list) {
    const ccy = row.ccy;
    const amount = num(row[amountKey]);
    if (typeof ccy !== "string" || ccy === "" || amount === undefined) continue;
    if (amount === 0) continue;
    const value = valueKey === undefined ? undefined : num(row[valueKey]);
    out.push(
      value === undefined ? { ccy, amount, bucket } : { ccy, amount, value, bucket },
    );
  }
  return out;
}

export const okxAdapter: VenueAdapter = {
  id: "okx",
  label: "OKX",
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

    async function soft<T>(
      part: VenueSnapshot["degraded"][number]["part"],
      run: () => Promise<T>,
    ): Promise<T | undefined> {
      try {
        return await run();
      } catch (error) {
        const reason = error instanceof ExchangeError ? error.bucket : "network";
        if (FATAL_BUCKETS.includes(reason)) throw error;
        if (!degraded.some((item) => item.part === part)) {
          degraded.push({ part, reason });
        }
        return undefined;
      }
    }

    if (want.has("spot") || want.has("margin")) {
      const data = await okxGet(
        deps,
        account,
        "/api/v5/account/balance",
        {},
        signal,
      );
      const head = rows(data)[0] ?? {};
      const tradingEq = num(head.totalEq);
      buckets.push({
        bucket: "spot",
        value: tradingEq,
        balances: balancesOf(rows(head.details), "spot", "eq", "eqUsd"),
      });
    }

    if (want.has("funding") || want.has("earn")) {
      const valuation = await soft("valuation", () =>
        okxGet(
          deps,
          account,
          "/api/v5/asset/asset-valuation",
          { ccy: "USD" },
          signal,
        ),
      );
      const totals = (rows(valuation)[0]?.details ?? {}) as Record<string, unknown>;
      const totalOf = (key: string): number | undefined => num(totals[key]);

      if (want.has("funding")) {
        const data = await soft("funding", () =>
          okxGet(deps, account, "/api/v5/asset/balances", {}, signal),
        );
        if (data !== undefined) {
          buckets.push({
            bucket: "funding",
            value: totalOf("funding"),
            balances: balancesOf(rows(data), "funding", "bal"),
          });
        }
      }

      if (want.has("earn")) {
        const savings = await soft("earn", () =>
          okxGet(deps, account, "/api/v5/finance/savings/balance", {}, signal),
        );
        const staking = await soft("earn", () =>
          okxGet(
            deps,
            account,
            "/api/v5/finance/staking-defi/orders-active",
            {},
            signal,
          ),
        );
        if (savings !== undefined || staking !== undefined) {
          buckets.push({
            bucket: "earn",
            value: totalOf("earn"),
            balances: [
              ...balancesOf(rows(savings ?? []), "earn", "amt"),
              ...balancesOf(rows(staking ?? []), "earn", "amt"),
            ],
          });
        }
      }
    }

    if (want.has("positions") || want.has("futures")) {
      const data = await soft("positions", () =>
        okxGet(deps, account, "/api/v5/account/positions", {}, signal),
      );
      for (const row of rows(data ?? [])) {
        const position = positionOf(row);
        if (position !== null) positions.push(position);
      }
    }

    // totalEq covers the trading account only; the owner's number is every
    // bucket we actually fetched, so a funding-only call still has a total.
    const total = buckets.reduce<number | undefined>((sum, bucket) => {
      if (bucket.value === undefined) return sum;
      return (sum ?? 0) + bucket.value;
    }, undefined);

    return {
      venue: "okx",
      account: account.id,
      fetchedAt,
      total,
      buckets,
      positions,
      degraded,
    };
  },
};

function positionOf(row: Record<string, unknown>): VenuePosition | null {
  const instrument = row.instId;
  const qty = num(row.pos);
  if (typeof instrument !== "string" || qty === undefined || qty === 0) {
    return null;
  }
  const kind: VenuePosition["kind"] =
    row.instType === "SWAP"
      ? "swap"
      : row.instType === "OPTION"
        ? "option"
        : row.instType === "MARGIN"
          ? "margin"
          : "futures";
  const position: VenuePosition = {
    instrument,
    kind,
    side: row.posSide === "short" || qty < 0 ? "short" : "long",
    qty: Math.abs(qty),
  };
  const entry = num(row.avgPx);
  const mark = num(row.markPx);
  const notional = num(row.notionalUsd);
  const upl = num(row.upl);
  const liq = num(row.liqPx);
  const leverage = num(row.lever);
  if (entry !== undefined) position.entry = entry;
  if (mark !== undefined) position.mark = mark;
  if (notional !== undefined) position.notional = notional;
  if (upl !== undefined) position.upl = upl;
  if (liq !== undefined) position.liq = liq;
  if (leverage !== undefined) position.leverage = leverage;
  return position;
}
