import type { Provider } from "@earendil-works/pi-ai/models";

/**
 * API-key auth that reads only the provider's `MODEL_KEY_*` secret. Stored
 * credentials are ignored: the desktop app publishes keys as Worker secrets.
 */
export function modelKeyAuth(
  name: string,
  secretName: string,
): NonNullable<Provider["auth"]["apiKey"]> {
  return {
    name,
    async resolve({ ctx }) {
      const value = await ctx.env(secretName);
      const apiKey = value?.trim();
      if (!apiKey) return undefined;
      return { auth: { apiKey }, source: secretName };
    },
  };
}
