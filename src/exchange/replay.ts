import endpoints from "../../contracts/exchange-binance-endpoints.json";

/** One raw reply the desktop recorded, as it arrived from Binance. */
export type RecordedResponse = {
  method: string;
  path: string;
  status: number;
  body: string;
};

/** JSON imports type optional params as `undefined`; drop those instead. */
function paramsOf(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The full bundle `binanceAdapter` needs, in the order the desktop sends it.
 * Methods stay plain strings so this module never spells out a write verb.
 */
export const BINANCE_ENDPOINTS: readonly {
  method: string;
  path: string;
  params: Record<string, string>;
}[] = endpoints.endpoints.map((endpoint) => ({
  method: endpoint.method,
  path: endpoint.path,
  params: paramsOf(endpoint.params),
}));

/** The main endpoint: when it is refused, the whole account is. */
export const PRIMARY_PATH = "/api/v3/account";

/**
 * Turns a recorded bundle back into a `fetch`-shaped function. Hosts, query
 * strings and the signature are ignored: the adapter only cares about the
 * method, the path, the status and the body.
 */
export function replayFetch(
  responses: readonly RecordedResponse[],
): typeof fetch {
  const replay = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = responses.find(
      (entry) =>
        entry.method.toUpperCase() === method && entry.path === url.pathname,
    );
    if (hit === undefined || hit.status <= 0) {
      throw new TypeError("not recorded");
    }
    try {
      return new Response(hit.body, { status: hit.status });
    } catch {
      // 1xx and bodyless statuses such as 204 are not constructible; a real
      // fetch would never surface those as a usable reply either.
      throw new TypeError("not recorded");
    }
  };
  return replay as typeof fetch;
}
