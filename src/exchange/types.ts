export const VENUE_IDS = ["okx", "binance"] as const;
export type VenueId = (typeof VENUE_IDS)[number];

export const BUCKETS = ["spot", "funding", "margin", "futures", "earn"] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Include = Bucket | "positions";

export type Balance = {
  ccy: string;
  amount: number;
  value?: number;
  bucket: Bucket;
};

export type VenuePosition = {
  instrument: string;
  kind: "swap" | "futures" | "option" | "margin";
  side: "long" | "short";
  qty: number;
  entry?: number;
  mark?: number;
  notional?: number;
  upl?: number;
  liq?: number;
  leverage?: number;
};

/** Parts that can fail on their own without failing the account. */
export const DEGRADED_PARTS = [
  "funding",
  "margin",
  "futures",
  "earn",
  "positions",
  "valuation",
] as const;
export type DegradedPart = (typeof DEGRADED_PARTS)[number];

export type ErrorBucket =
  | "region"
  | "unknownKey"
  | "wrongDomain"
  | "signature"
  | "timestamp"
  | "passphrase"
  | "rate"
  | "timeout"
  | "network"
  | "parse"
  | "refused"
  | "account";

/** Failures that end the whole account rather than degrading one bucket. */
export const FATAL_BUCKETS: readonly ErrorBucket[] = [
  "region",
  "unknownKey",
  "wrongDomain",
  "signature",
  "timestamp",
  "passphrase",
];

export type Degraded = { part: DegradedPart; reason: ErrorBucket };

/** Never carries a response body: only the classification and the raw status. */
export class ExchangeError extends Error {
  constructor(
    readonly bucket: ErrorBucket,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(
      `exchange ${bucket}` +
        (status === undefined ? "" : ` ${status}`) +
        (code === undefined ? "" : ` ${code}`),
    );
    this.name = "ExchangeError";
  }
}

export type VenueSecret = {
  key: string;
  secret: string;
  passphrase?: string;
};

export type ExchangeAccount = {
  id: string;
  venue: VenueId;
  label: string;
  baseUrl: string;
  secret: VenueSecret;
};

export type VenueSnapshot = {
  venue: VenueId;
  account: string;
  fetchedAt: number;
  total?: number;
  buckets: { bucket: Bucket; value?: number; balances: Balance[] }[];
  positions: VenuePosition[];
  degraded: Degraded[];
};

export type FetchOptions = { include: readonly Include[] };

/** Injected for tests and probes; `http.ts` aliases this as `HttpDeps`. */
export type AdapterDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export interface VenueAdapter {
  readonly id: VenueId;
  readonly label: string;
  readonly supports: readonly Bucket[];
  fetch(
    account: ExchangeAccount,
    opts: FetchOptions,
    signal: AbortSignal | undefined,
    deps?: AdapterDeps,
  ): Promise<VenueSnapshot>;
}
