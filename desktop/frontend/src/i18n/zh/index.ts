import { backup } from "./backup";
import { common } from "./common";
import { diagnostics } from "./diagnostics";
import { entries } from "./entries";
import { errors } from "./errors";
import { locale } from "./locale";
import { mcp } from "./mcp";
import { models } from "./models";
import { overview } from "./overview";
import { shell } from "./shell";
import { states } from "./states";
import { updates } from "./updates";

// Baseline dictionary. Every user-facing string the new UI adds lives here;
// the English table is typed against it so a missing key fails `tsc`.
export const zh = {
  locale,
  common,
  shell,
  states,
  errors,
  overview,
  diagnostics,
  updates,
  models,
  mcp,
  entries,
  backup,
} as const;
