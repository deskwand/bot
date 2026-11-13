import { readRuntimeConfig } from "../runtime-config";

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/** A broken config must not decide whether the sandbox tools exist. */
function section(env: Env): { enabled?: boolean; commandTimeoutMs?: number } {
  try {
    return readRuntimeConfig(env).sandbox ?? {};
  } catch {
    return {};
  }
}

export function sandboxEnabled(env: Env): boolean {
  return section(env).enabled !== false;
}

export function readSandboxTimeoutMs(env: Env): number {
  const value = section(env).commandTimeoutMs;
  // The schema already bounds the value; anything that still looks wrong here
  // (or a document the schema rejected) falls back to the default.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return value;
}
