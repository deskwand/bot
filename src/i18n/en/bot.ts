import type { Messages } from "../messages";

export const bot: Messages["bot"] = {
  finished: "🏁 {name} finished and will not wake again (reason: {reason})",
  finishReasonUnknown: "not given",
  dailyLimit:
    "⏸ {name} reached {limit} wakes today; deferred to 00:00 UTC tomorrow",
  paused:
    "⚠️ {name} paused: {failures} failures in a row (last reason: {reason})",
  runTimeout: "The run exceeded 24 hours and was cancelled",
};
