import { backup } from "./backup";
import { bots } from "./bots";
import { common } from "./common";
import { diagnostics } from "./diagnostics";
import { exchange } from "./exchange";
import { entries } from "./entries";
import { errors } from "./errors";
import { locale } from "./locale";
import { mcp } from "./mcp";
import { models } from "./models";
import { overview } from "./overview";
import { search } from "./search";
import { server } from "./server";
import { setup } from "./setup";
import { shell } from "./shell";
import { states } from "./states";
import { updates } from "./updates";
import { wallet } from "./wallet";

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
  search,
  mcp,
  exchange,
  wallet,
  entries,
  backup,
  bots,
  setup,
  server,
} as const;
