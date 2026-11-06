import type { Messages } from "../messages";
import { bot } from "./bot";
import { butler } from "./butler";
import { channel } from "./channel";
import { llm } from "./llm";
import { prompt } from "./prompt";
import { task } from "./task";

export const en: Messages = {
  bot,
  butler,
  channel,
  llm,
  prompt,
  task,
};
