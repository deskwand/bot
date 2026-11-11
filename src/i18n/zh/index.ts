import { bot } from "./bot";
import { butler } from "./butler";
import { channel } from "./channel";
import { llm } from "./llm";
import { exchange } from "./exchange";
import { mail } from "./mail";
import { mcp } from "./mcp";
import { phone } from "./phone";
import { prompt } from "./prompt";
import { task } from "./task";

// Baseline dictionary. Every user-facing string lives here; the English table
// is typed against it so a missing key fails `tsc`.
export const zh = {
  bot,
  butler,
  channel,
  llm,
  exchange,
  mail,
  mcp,
  phone,
  prompt,
  task,
} as const;
