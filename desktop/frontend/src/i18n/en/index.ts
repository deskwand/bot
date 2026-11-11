import type { Messages } from "../types";
import { backup } from "./backup";
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
import { setup } from "./setup";
import { shell } from "./shell";
import { states } from "./states";
import { updates } from "./updates";

export const en: Messages = {
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
  entries,
  backup,
  setup,
};
