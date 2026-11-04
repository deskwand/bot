import { ChannelError } from "./types";

const API_BASE = "https://api.telegram.org";
const GET_UPDATES_TIMEOUT_S = 25;

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: unknown;
};

export type TelegramUpdateBatch = {
  updates: Array<{ update_id: number } & Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The two Bot API calls the polling chain needs. Every failure is a
 * `ChannelError` carrying the HTTP status, so the caller can tell a 409
 * (webhook still registered) from an invalid token.
 */
export function createTelegramPollClient(opts: {
  token: string;
  fetch?: typeof fetch;
}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetchImpl(
      `${API_BASE}/bot${opts.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );

    let json: TelegramApiResponse | null = null;
    try {
      json = (await response.json()) as TelegramApiResponse;
    } catch {
      json = null;
    }

    if (!response.ok || json === null || json.ok !== true) {
      throw new ChannelError(
        json?.description ?? `Telegram ${method} failed (${response.status})`,
        response.status,
      );
    }
    return json.result;
  }

  return {
    async getUpdates(
      offset: number,
      signal: AbortSignal,
    ): Promise<TelegramUpdateBatch> {
      const result = await call(
        "getUpdates",
        {
          offset,
          timeout: GET_UPDATES_TIMEOUT_S,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      const updates = Array.isArray(result) ? result : [];
      return {
        updates: updates.filter(
          (update): update is { update_id: number } & Record<string, unknown> =>
            isRecord(update) && typeof update.update_id === "number",
        ),
      };
    },

    async deleteWebhook(): Promise<void> {
      await call("deleteWebhook", {});
    },
  };
}
