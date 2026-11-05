import { common } from "./common";
import { errors } from "./errors";
import { locale } from "./locale";
import { shell } from "./shell";
import { states } from "./states";

// Baseline dictionary. Every user-facing string the new UI adds lives here;
// the English table is typed against it so a missing key fails `tsc`.
export const zh = {
  locale,
  common,
  shell,
  states,
  errors,
} as const;
