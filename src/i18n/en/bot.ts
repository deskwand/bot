import type { Messages } from "../messages";

export const bot: Messages["bot"] = {
  finished: "{name} finished and will not wake again (reason: {reason})",
  finishReasonUnknown: "not given",
  dailyLimit:
    "{name} reached {limit} wakes today; deferred to 00:00 UTC tomorrow",
  failing:
    "{name} failed {failures} times in a row (last reason: {reason}); retrying every {retryEvery}",
  recovered: "{name} is working again",
  runTimeout: "The run exceeded 24 hours and was cancelled",
};
