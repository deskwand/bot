import type { Messages } from "../messages";

export const llm: Messages["llm"] = {
  quotaExhausted:
    "Today's free Cloudflare model allowance is used up (it resets at 00:00 UTC, 08:00 Beijing time). To keep going, switch to your own model key on the Models page of the desktop app.",
  paidPlanRequired:
    "This model requires a paid Cloudflare Workers plan. Switch to a model available on the free plan (such as the default Gemma 4 26B) on the Models page of the desktop app.",
  modelUnavailable:
    "Model {provider}/{id} is unavailable; choose another one on the Models page of the desktop app",
  modelUnavailableShort: "Model {provider}/{id} is unavailable",
  modelKeyMissing:
    "Model {provider} has no key configured ({secret}); add it on the Models page of the desktop app",
  bindingUnavailable:
    "The Workers AI binding is unavailable; redeploy from the desktop app",
};
