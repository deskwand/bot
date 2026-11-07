import type { Messages } from "../messages";

export const llm: Messages["llm"] = {
  windowDowngrade: "Cannot switch the Butler model: {source} has a {from}-token context window, but {target} has only {to} tokens. The target is less than one quarter of the current window. The current session model and conversation are preserved. Choose a model with at least one quarter of the current window.",
  windowUnknown: "Cannot verify the context windows for this Butler model switch. Update the model catalog and check custom model window settings.",
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
