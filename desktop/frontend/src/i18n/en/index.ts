import type { Messages } from "../types";
import { common } from "./common";
import { errors } from "./errors";
import { locale } from "./locale";
import { shell } from "./shell";
import { states } from "./states";

export const en: Messages = {
  locale,
  common,
  shell,
  states,
  errors,
};
