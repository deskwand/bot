import { butler } from "./butler";
import { channel } from "./channel";
import { prompt } from "./prompt";

// Baseline dictionary. Every user-facing string lives here; the English table
// is typed against it so a missing key fails `tsc`.
export const zh = {
  butler,
  channel,
  prompt,
} as const;
