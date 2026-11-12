/**
 * Exchange routes: one authenticated probe that proves the deployed Worker can
 * read the account, and one snapshot push from the desktop's local sync.
 * Failures are fixed codes, never response bodies.
 */

export type ExchangeProbeResult =
  | { ok: true; venue: string; currencies: number; total?: number }
  | { ok: false; code: string; message: string };

export type ExchangeHandlers = {
  probe: (account: string) => Promise<ExchangeProbeResult>;
  /** Only present when the deployment wires the desktop sync. */
  ingest?: (body: unknown) => Promise<ExchangeProbeResult>;
};

const PROBE_PATH = "/admin/exchange/probe";
const SNAPSHOT_PATH = "/admin/exchange/snapshot";
const MAX_BODY = 2 * 1024 * 1024;

export function createExchangeRoutes(handlers: ExchangeHandlers): {
  fetch(req: Request): Promise<Response>;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST") return notFound();
      if (url.pathname === PROBE_PATH) return probe(handlers.probe, req);
      if (url.pathname === SNAPSHOT_PATH && handlers.ingest !== undefined) {
        return snapshot(handlers.ingest, req);
      }
      return notFound();
    },
  };
}

async function probe(
  handler: ExchangeHandlers["probe"],
  req: Request,
): Promise<Response> {
  let account: unknown;
  try {
    account = ((await req.json()) as { account?: unknown }).account;
  } catch {
    account = undefined;
  }
  if (typeof account !== "string" || account === "") {
    return json(
      { code: "EXCHANGE_INVALID", message: "probe needs { account }" },
      400,
    );
  }
  const result = await handler(account);
  return json(result, result.ok ? 200 : 400);
}

async function snapshot(
  handler: NonNullable<ExchangeHandlers["ingest"]>,
  req: Request,
): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return tooLarge();
  }
  // The cap is in bytes, not UTF-16 code units.
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) return tooLarge();
  const text = new TextDecoder().decode(bytes);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(
      {
        code: "EXCHANGE_INVALID",
        message: "snapshot needs { account, fetchedAt, responses }",
      },
      400,
    );
  }
  const result = await handler(body);
  return json(result, result.ok ? 200 : 400);
}

function tooLarge(): Response {
  return json({ code: "EXCHANGE_INVALID", message: "snapshot too large" }, 400);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
