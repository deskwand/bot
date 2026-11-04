/**
 * Read at most 2 MB from a response. Streaming stops early so a huge body
 * cannot exhaust the Worker's memory; the caller notes the truncation.
 */
export const MAX_TEXT_CHARS = 20_000;

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const TRUNCATION_MARKER = "\n\n[已截断]";

export const BODY_TRUNCATION_MARKER = "\n\n[内容超过 2 MB，已截断]";

export function truncate(text: string): string {
  return text.length <= MAX_TEXT_CHARS
    ? text
    : text.slice(0, MAX_TEXT_CHARS) + TRUNCATION_MARKER;
}

export async function readCapped(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; truncated: boolean }> {
  signal?.throwIfAborted();
  const nullBody =
    response.status === 204 || response.status === 205 || response.status === 304;
  if (!response.body || nullBody) {
    return {
      response: nullBody
        ? new Response(null, { status: response.status, headers: response.headers })
        : response,
      truncated: false,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await withAbort(() => reader.read(), signal);
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > MAX_BODY_BYTES) {
        const remaining = MAX_BODY_BYTES - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (truncated) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return {
    response: new Response(new Blob(chunks), {
      status: response.status,
      headers: response.headers,
    }),
    truncated,
  };
}

/** Race IO against cancellation even when an injected transport ignores signals. */
export async function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
