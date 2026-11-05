import type { Messages } from "../types";
import { common } from "./common";
import { diagnostics } from "./diagnostics";
import { errors } from "./errors";
import { locale } from "./locale";
import { models } from "./models";
import { overview } from "./overview";
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
};
