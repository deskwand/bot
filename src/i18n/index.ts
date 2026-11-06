import { configLocale } from "../config";
import { readRuntimeConfig } from "../runtime-config";

export type Locale = "zh" | "en";

export { en } from "./en";
export { zh } from "./zh";
export { formatTemplate, t, tryT } from "./messages";
export type { DeepString, MessageKey, Messages } from "./messages";

/**
 * Reads the locale published with the deployment configuration.
 *
 * Configuration errors must never stop a message the bot could otherwise send,
 * so a failed read falls back to Chinese.
 */
export function ownerLocale(env: Env): Locale {
  try {
    return configLocale(readRuntimeConfig(env));
  } catch {
    return "zh";
  }
}
