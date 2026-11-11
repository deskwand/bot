import type { Messages } from "../messages";

export const bot: Messages["bot"] = {
  finished: "finished and will not wake again (reason: {reason})",
  finishReasonUnknown: "not given",
  dailyLimit:
    "reached {limit} wakes today; deferred to 00:00 UTC tomorrow",
  failing:
    "failed {failures} times in a row (last reason: {reason}); retrying every {retryEvery}",
  recovered: "is working again",
  runTimeout: "The run exceeded 24 hours and was cancelled",
};
