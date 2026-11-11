/**
 * Exchange probe route: one authenticated POST that proves the deployed Worker
 * can read the account. Failures are fixed codes, never response bodies.
 */

export type ExchangeProbeResult =
  | { ok: true; venue: string; currencies: number; total?: number }
  | { ok: false; code: string; message: string };

const PROBE_PATH = "/admin/exchange/probe";

export function createExchangeRoutes(
  probe: (account: string) => Promise<ExchangeProbeResult>,
): { fetch(req: Request): Promise<Response> } {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== PROBE_PATH) {
        return new Response("Not found", { status: 404 });
      }
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
      const result = await probe(account);
      return json(result, result.ok ? 200 : 400);
    },
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
