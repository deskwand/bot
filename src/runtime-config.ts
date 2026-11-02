import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../contracts/deployment-config.schema.json";
import type { AppConfig } from "./config";
import { modelsConfigValid } from "./llm/providers";

export type RuntimeConfigErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_INVALID_SHAPE"
  | "CONFIG_SCHEMA_INVALID"
  | "CONFIG_MODELS_INVALID";

const MESSAGES: Record<RuntimeConfigErrorCode, string> = {
  CONFIG_MISSING: "DESKWAND_CONFIG is not set",
  CONFIG_INVALID_JSON: "DESKWAND_CONFIG is not valid JSON",
  CONFIG_INVALID_SHAPE:
    "DESKWAND_CONFIG must be a JSON object or a string containing one",
  CONFIG_SCHEMA_INVALID:
    "DESKWAND_CONFIG does not match the deployment configuration schema",
  CONFIG_MODELS_INVALID:
    "DESKWAND_CONFIG models reference an unknown or conflicting provider",
};

/** Fixed, sanitized configuration error: never carries raw binding values. */
export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;

  constructor(code: RuntimeConfigErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "RuntimeConfigError";
    this.code = code;
  }
}

const validator = new Validator(schema as Schema, "2020-12");

/**
 * Reads the deployment configuration from the Worker environment.
 *
 * Cloudflare turns JSON vars into objects; CLI and local dev may still expose
 * the same value as a JSON string, so both forms are accepted. There is no
 * built-in owner, model or MCP fallback: a missing document stops business
 * processing instead of reviving a repository default.
 */
export function readRuntimeConfig(env: Env): AppConfig {
  const raw = env.DESKWAND_CONFIG;
  if (raw === undefined) throw new RuntimeConfigError("CONFIG_MISSING");

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new RuntimeConfigError("CONFIG_INVALID_JSON");
    }
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeConfigError("CONFIG_INVALID_SHAPE");
  }

  if (!validator.validate(value).valid) {
    throw new RuntimeConfigError("CONFIG_SCHEMA_INVALID");
  }

  const config = value as AppConfig;
  if (!modelsConfigValid(config.models)) {
    throw new RuntimeConfigError("CONFIG_MODELS_INVALID");
  }

  return config;
}
