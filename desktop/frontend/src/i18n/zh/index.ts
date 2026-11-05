import { common } from "./common";
import { locale } from "./locale";

// Baseline dictionary. Every user-facing string the new UI adds lives here;
// the English table is typed against it so a missing key fails `tsc`.
export const zh = {
  locale,
  common,
} as const;
