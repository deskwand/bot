import { butler } from "./butler";
import { prompt } from "./prompt";

// Baseline dictionary. Every user-facing string lives here; the English table
// is typed against it so a missing key fails `tsc`.
export const zh = {
  butler,
  prompt,
} as const;
