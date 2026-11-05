import type { ProgressPolicy } from "@earendil-works/pi-durable";

// pi commits partial answers and tool output every 100ms by default. Nothing
// reads those intermediate commits, and each one costs billed SQLite rows, so
// commit them once every 30s instead; final messages and tool results are
// unaffected.
export const PI_PROGRESS = {
  partialIntervalMs: 30_000,
  outputIntervalMs: 30_000,
} as const satisfies ProgressPolicy;
