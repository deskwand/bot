import { t } from "../i18n";

/** The parts of a bot this module needs to recognise it. */
export type BotRef = { id: string; name: string };

/**
 * What an inbound message addresses. `bot` carries the text with the address
 * stripped; a quoted reply keeps its body unchanged.
 */
export type BotAddress =
  | { kind: "none" }
  | { kind: "bot"; bot: BotRef; text: string }
  | { kind: "ambiguous"; name: string; matches: BotRef[] };

/**
 * Recognises a message that is meant for one bot: either a reply quoting an
 * `【名字】…` notice, or an `@名字` / `@id` address at the start of the text.
 *
 * A quote wins over an `@` address, so `@News 你好` under a quoted `盯盘` reply
 * still goes to `盯盘` with the body untouched.
 */
export function resolveBotAddress(
  input: { text: string | null; quotedText?: string },
  bots: readonly BotRef[],
): BotAddress {
  const quoted = input.quotedText?.trimStart();
  if (quoted !== undefined && quoted !== "") {
    const byQuote = matchQuote(quoted, input.text, bots);
    if (byQuote !== null) return byQuote;
  }
  return matchAddress(input.text, bots);
}

function matchQuote(
  quoted: string,
  text: string | null,
  bots: readonly BotRef[],
): BotAddress | null {
  for (const bot of bots) {
    if (!hasNoticePrefix(quoted, bot.name)) continue;
    const matches = bots.filter((candidate) => candidate.name === bot.name);
    if (matches.length > 1) {
      return { kind: "ambiguous", name: bot.name, matches };
    }
    return { kind: "bot", bot, text: text ?? "" };
  }
  return null;
}

function hasNoticePrefix(quoted: string, name: string): boolean {
  return (
    quoted.startsWith(t("zh", "butler.notice.bot", { name, text: "" })) ||
    quoted.startsWith(t("en", "butler.notice.bot", { name, text: "" })) ||
    // Legacy notices sent before the text prefix replaced the robot emoji.
    // They stay recognisable so replies to older messages still reach the bot.
    quoted.startsWith(`🤖 ${name}：`) ||
    quoted.startsWith(`🤖 ${name}: `)
  );
}

function matchAddress(
  text: string | null,
  bots: readonly BotRef[],
): BotAddress {
  if (text === null) return { kind: "none" };
  const body = text.trimStart();
  if (!body.startsWith("@")) return { kind: "none" };

  const afterAt = body.slice(1);
  const end = afterAt.search(/\s/);
  const token = end === -1 ? afterAt : afterAt.slice(0, end);
  if (token === "") return { kind: "none" };
  const rest = end === -1 ? "" : afterAt.slice(end).trim();

  const byId = bots.find((bot) => bot.id === token);
  if (byId !== undefined) {
    // An id that is also another bot's name is ambiguous: the owner may have
    // meant either. The id match comes first.
    const key = token.toLowerCase();
    const alsoNamed = bots.filter(
      (bot) => bot !== byId && bot.name.trim().toLowerCase() === key,
    );
    if (alsoNamed.length > 0) {
      return {
        kind: "ambiguous",
        name: token,
        matches: [byId, ...alsoNamed],
      };
    }
    return { kind: "bot", bot: byId, text: rest };
  }

  const key = token.toLowerCase();
  const matches = bots.filter((bot) => bot.name.trim().toLowerCase() === key);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    return { kind: "ambiguous", name: matches[0]!.name, matches };
  }
  return { kind: "bot", bot: matches[0]!, text: rest };
}
