import { describe, expect, it } from "vitest";
import { butlerSystemPrompt } from "../../src/butler/prompt";

describe("butlerSystemPrompt", () => {
  it("lists the services a task can use", () => {
    const prompt = butlerSystemPrompt("zh", [
      { name: "github", description: "GitHub：仓库、issue、PR" },
    ]);
    expect(prompt).toContain("已接入的外部服务（需派任务使用）：");
    expect(prompt).toContain("- github：GitHub：仓库、issue、PR");
  });

  it("falls back to the name when a service has no description", () => {
    const prompt = butlerSystemPrompt("zh", [{ name: "deepwiki" }]);
    expect(prompt).toContain("- deepwiki：deepwiki");
  });

  it("omits the service section when there are no services", () => {
    expect(butlerSystemPrompt("zh", [])).not.toContain("已接入的外部服务");
  });
});

it("tells the butler to spell out endpoint requirements in instructions", () => {
  const prompt = butlerSystemPrompt("zh", []);
  expect(prompt).toContain("端点和 HTTP 方法");
  expect(prompt).toContain("执行者看不到当前对话");
});

it("tells the butler to use display handles and retry without one", () => {
  const prompt = butlerSystemPrompt("zh", []);
  expect(prompt).toContain("对主人提到任务时只用 #N 或标题");
  expect(prompt).toContain("最近失败的那个任务");
  expect(prompt).toContain("或 retry");
});

it("butler prompt ends with the reply language", () => {
  expect(
    butlerSystemPrompt("en", []).endsWith(
      "Always reply to the owner in English.",
    ),
  ).toBe(true);
  expect(butlerSystemPrompt("zh", []).endsWith("始终用中文回复主人。")).toBe(
    true,
  );
});

it("tells the butler that the owner can talk to a bot directly", () => {
  const prompt = butlerSystemPrompt("zh", []);
  expect(prompt).toContain("@名字");
  expect(prompt).toContain("直接回复机器人消息");
});
