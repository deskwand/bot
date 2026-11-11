import type { Messages } from "../messages";
import { bot } from "./bot";
import { butler } from "./butler";
import { channel } from "./channel";
import { life } from "./life";
import { llm } from "./llm";
import { mail } from "./mail";
import { mcp } from "./mcp";
import { phone } from "./phone";
import { prompt } from "./prompt";
import { task } from "./task";

export const en: Messages = {
  bot,
  butler,
  channel,
  life,
  llm,
  mail,
  mcp,
  phone,
  prompt,
  task,
};
