import type { StreamOptions } from "@earendil-works/pi-ai";

/**
 * Options for a model request that does not run inside a harness conversation:
 * the butler's rewrites and a task's tool reviews. pi-ai sets OpenCode's
 * `x-opencode-session` header only from `sessionId`, and the gateway rejects a
 * request without it with HTTP 400 `missing_session_id`. The scope keeps one
 * caller on one gateway route across calls, so it must stay stable and unique
 * per caller rather than change per request.
 */
export function oneShotOptions(
  scope: string,
  signal: AbortSignal,
): StreamOptions {
  return { sessionId: scope, signal };
}
