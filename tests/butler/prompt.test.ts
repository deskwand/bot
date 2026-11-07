import { describe, expect, it } from "vitest";
import { butlerSystemPrompt } from "../../src/butler/prompt";

describe("butlerSystemPrompt", () => {
  it("lists the services a task can use", () => {
    const prompt = butlerSystemPrompt("zh", [
      { name: "github", description: "GitHub：仓库、issue、PR" },
    ], "telegram");
    expect(prompt).toContain("已接入的外部服务（需派任务使用）：");
    expect(prompt).toContain("- github：GitHub：仓库、issue、PR");
  });

  it("falls back to the name when a service has no description", () => {
    const prompt = butlerSystemPrompt("zh", [{ name: "deepwiki" }], "telegram");
    expect(prompt).toContain("- deepwiki：deepwiki");
  });

  it("omits the service section when there are no services", () => {
    expect(butlerSystemPrompt("zh", [], "telegram")).not.toContain("已接入的外部服务");
  });
});

it("tells the butler to spell out endpoint requirements in instructions", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain("端点和 HTTP 方法");
  expect(prompt).toContain("执行者看不到当前对话");
});

it("tells the butler to use display handles and retry without one", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain("对主人提到任务时只用 #N 或标题");
  expect(prompt).toContain("最近失败的那个任务");
  expect(prompt).toContain("或 retry");
});

it("butler prompt ends with the reply language", () => {
  expect(
    butlerSystemPrompt("en", [], "telegram").endsWith(
      "Always reply to the owner in English.",
    ),
  ).toBe(true);
  expect(butlerSystemPrompt("zh", [], "telegram").endsWith("始终用中文回复主人。")).toBe(
    true,
  );
});

it("tells the butler that the owner can talk to a bot directly", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain("@名字");
  expect(prompt).toContain("直接回复机器人消息");
});

describe("butlerSystemPrompt channel and phone context", () => {
  it("names WeChat and never Telegram on a WeChat deployment", () => {
    const prompt = butlerSystemPrompt("zh", [], "wechat");
    expect(prompt).toContain("通过 微信 与主人交流");
    expect(prompt).not.toContain("Telegram");
  });

  it("names Telegram on a Telegram deployment", () => {
    expect(butlerSystemPrompt("zh", [], "telegram")).toContain("通过 Telegram 与主人交流");
  });

  it("falls back to a neutral channel name", () => {
    const prompt = butlerSystemPrompt("zh", [], null);
    expect(prompt).toContain("通过消息渠道与主人交流");
    expect(prompt).not.toMatch(/null|undefined|Telegram|微信/);
  });

  it("tells the butler the owner reads on a phone", () => {
    const prompt = butlerSystemPrompt("zh", [], "wechat");
    expect(prompt).toContain("大多数时候拿着手机、人在外面");
    expect(prompt).toContain("第一句就是结论或答案");
    expect(prompt).toContain("约 200 字");
    expect(prompt).toContain("不用表格、不用多级标题");
    expect(prompt).not.toContain("回复要简短");
    expect(prompt).not.toContain("先说一句");
  });

  it("does not force Chinese on an English deployment", () => {
    expect(butlerSystemPrompt("en", [], "telegram")).not.toContain("用中文");
  });
});
