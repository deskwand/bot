import type { Messages } from "../messages";

export const channel: Messages["channel"] = {
  disabled: "This channel is not enabled",
  error: "Something went wrong, try again later",
  hint: 'Reply "{hint}"',
  owner: {
    claimed:
      "You are now the owner ({id}). Only you can use me from here on; hand over or revoke from the desktop app's Voice page.",
  },
};
