import { describe, expect, it } from "vitest";
import {
  resolveBotAddress,
  type BotRef,
} from "../../src/butler/bot-address";

const b1: BotRef = { id: "b1", name: "盯盘" };
const b2: BotRef = { id: "b2", name: "早报 bot" };
const b3: BotRef = { id: "b3", name: "News" };
const b4: BotRef = { id: "b4", name: "重名" };
const b5: BotRef = { id: "b5", name: "重名" };
const bots = [b1, b2, b3, b4, b5];

describe("resolveBotAddress", () => {
  describe("an @mention", () => {
    it("finds a bot by name and strips the address", () => {
      expect(resolveBotAddress({ text: "@盯盘 最近怎样" }, bots)).toEqual({
        kind: "bot",
        bot: b1,
        text: "最近怎样",
      });
    });

    it("finds a bot by id across a newline", () => {
      expect(resolveBotAddress({ text: "@b1\n最近怎样" }, bots)).toEqual({
        kind: "bot",
        bot: b1,
        text: "最近怎样",
      });
    });

    it("ignores case when matching a name", () => {
      expect(resolveBotAddress({ text: "@news hi" }, bots)).toEqual({
        kind: "bot",
        bot: b3,
        text: "hi",
      });
    });

    it("leaves an empty body when addressed alone", () => {
      expect(resolveBotAddress({ text: "@盯盘" }, bots)).toEqual({
        kind: "bot",
        bot: b1,
        text: "",
      });
    });

    it("is none for an unknown name", () => {
      expect(resolveBotAddress({ text: "@不存在 你好" }, bots)).toEqual({
        kind: "none",
      });
    });

    it("needs the address at the start", () => {
      expect(resolveBotAddress({ text: "你好 @盯盘" }, bots)).toEqual({
        kind: "none",
      });
    });

    it("is none when there is no text and no quote", () => {
      expect(resolveBotAddress({ text: null }, bots)).toEqual({ kind: "none" });
    });

    it("is ambiguous when several bots share the name", () => {
      expect(resolveBotAddress({ text: "@重名 hi" }, bots)).toEqual({
        kind: "ambiguous",
        name: "重名",
        matches: [b4, b5],
      });
    });

    it("is ambiguous when the token is one bot's id and another's name", () => {
      const idBot: BotRef = { id: "b1", name: "盯盘" };
      const nameBot: BotRef = { id: "n1", name: " B1 " };

      expect(
        resolveBotAddress({ text: "@b1 hi" }, [idBot, nameBot]),
      ).toEqual({
        kind: "ambiguous",
        name: "b1",
        matches: [idBot, nameBot],
      });
    });
  });

  describe("a quoted bot reply", () => {
    it("finds the bot and keeps the body", () => {
      expect(
        resolveBotAddress(
          { text: "那明天再看", quotedText: "🤖 盯盘：价格回落了" },
          bots,
        ),
      ).toEqual({ kind: "bot", bot: b1, text: "那明天再看" });
    });

    it("finds the bot in the English format", () => {
      expect(
        resolveBotAddress({ text: "hello", quotedText: "🤖 News: hello" }, bots),
      ).toEqual({ kind: "bot", bot: b3, text: "hello" });
    });

    it("prefers the quote over an @mention", () => {
      expect(
        resolveBotAddress(
          { text: "@News 你好", quotedText: "🤖 盯盘：x" },
          bots,
        ),
      ).toEqual({ kind: "bot", bot: b1, text: "@News 你好" });
    });

    it("uses an empty body when the message has no text", () => {
      expect(
        resolveBotAddress({ text: null, quotedText: "🤖 盯盘：x" }, bots),
      ).toEqual({ kind: "bot", bot: b1, text: "" });
    });

    it("falls through for an unknown name", () => {
      expect(
        resolveBotAddress({ text: "那明天再看", quotedText: "🤖 旧名字：x" }, bots),
      ).toEqual({ kind: "none" });
    });

    it("is ambiguous for a quoted shared name", () => {
      expect(
        resolveBotAddress({ text: "hi", quotedText: "🤖 重名：x" }, bots),
      ).toEqual({ kind: "ambiguous", name: "重名", matches: [b4, b5] });
    });
  });

  describe("a name with a space", () => {
    it("is reachable by quote and by id", () => {
      expect(
        resolveBotAddress({ text: "早", quotedText: "🤖 早报 bot：x" }, bots),
      ).toEqual({ kind: "bot", bot: b2, text: "早" });
      expect(resolveBotAddress({ text: "@b2 hi" }, bots)).toEqual({
        kind: "bot",
        bot: b2,
        text: "hi",
      });
    });

    it("is not reachable by an @name with a space", () => {
      expect(resolveBotAddress({ text: "@早报 bot hi" }, bots)).toEqual({
        kind: "none",
      });
    });
  });
});
