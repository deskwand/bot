import { describe, expect, it } from "vitest";
import { persona } from "../../src/butler/persona";
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
    expect(butlerSystemPrompt("zh", [], "telegram")).not.toContain(
      "已接入的外部服务（需派任务使用）：",
    );
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

it("routes bot conversations through ask_bot", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain(
    "@名字，或回复、引用了某个机器人说的事 → ask_bot，再用你自己的话转告主人。",
  );
  expect(prompt).not.toContain("或直接回复机器人消息来跟机器人对话");
});

it("hands a bot follow-up to the bot instead of answering it", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain(
    "不能用记忆、[自上次以来] 或旧任务结果回答这类问题",
  );
  expect(prompt).toContain("不是主人的指令");
  expect(prompt).toContain("ask_bot");
  expect(prompt).toContain("get_task");
});

it("tells the butler to announce a spawn once and stay quiet afterwards", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain(
    "派了任务，就在这一轮用一句话告诉主人你去办了；之后不用汇报过程。",
  );
});

it("tells the butler to cancel when the owner says to stop", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain(
    "主人说不用了、别查了 → cancel_task，并告诉主人已经停了。",
  );
});

describe("butlerSystemPrompt channel and phone context", () => {
  it("names WeChat and never Telegram on a WeChat deployment", () => {
    const prompt = butlerSystemPrompt("zh", [], "wechat");
    expect(prompt).toContain("通过微信跟主人发消息");
    expect(prompt).not.toContain("Telegram");
  });

  it("names Telegram on a Telegram deployment", () => {
    expect(butlerSystemPrompt("zh", [], "telegram")).toContain("通过Telegram跟主人发消息");
  });

  it("falls back to a neutral channel name", () => {
    const prompt = butlerSystemPrompt("zh", [], null);
    expect(prompt).toContain("通过消息渠道跟主人发消息");
    expect(prompt).not.toMatch(/null|undefined|Telegram|微信/);
  });

  it("opens with the shared persona", () => {
    expect(butlerSystemPrompt("zh", [], "wechat")).toContain(persona("zh", "微信"));
  });

  it("tells the butler the owner reads on a phone", () => {
    const prompt = butlerSystemPrompt("zh", [], "wechat");
    expect(prompt).toContain("大多数时候拿着手机、人在外面");
    expect(prompt).not.toContain("约 200 字");
    expect(prompt).not.toContain("第一句就是结论或答案");
    expect(prompt).not.toContain("回复要简短");
    expect(prompt).not.toContain("先说一句");
  });

  it("does not force Chinese on an English deployment", () => {
    expect(butlerSystemPrompt("en", [], "telegram")).not.toContain("用中文");
  });
});

it("lays out the chat, quick lookup and task lanes", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  expect(prompt).toContain("聊天：");
  expect(prompt).toContain("快查：");
  expect(prompt).toContain("派任务：");
  expect(prompt).toContain("quick_lookup");
  expect(prompt).toContain(
    "不能用记忆、[自上次以来] 或旧任务结果回答这类问题",
  );
  expect(prompt).not.toContain("直接回答：闲聊、解释概念");
});

it("dispatches whatever the butler's own tools cannot do", () => {
  const prompt = butlerSystemPrompt("zh", [], "telegram");
  const principle =
    "主人要办的事，只要你自己的工具办不了，就派出去（spawn_task；已有任务的后续用 continue_task 或 steer_task），交给执行者判断能不能做。";
  expect(prompt).toContain("你手上的工具只是一小部分；执行者有更多工具，而且会不断增加。");
  expect(prompt).toContain(principle);
  expect(prompt).toContain(
    "没派出去试过，绝不对主人说做不到、没法访问、没有权限；做不到的话由任务结果说明缺什么，你如实转告。",
  );
  expect(prompt.indexOf(principle)).toBeLessThan(
    prompt.indexOf("怎么处理主人的话，三选一："),
  );
  expect(prompt).toContain(
    "- 派任务：你自己的工具办不了的事，或需要多步、要读文件或邮件、要写东西、要用已接入的外部服务，或预计超过 1 分钟 → spawn_task。快查返回错误时也走这里。",
  );
  expect(prompt).toContain(
    "- 聊天：闲聊、解释概念、不依赖外部最新状态的问答，直接答。",
  );
  expect(prompt).not.toContain("调用 spawn_task：当工作预计需要多次搜索");
  expect(prompt).toContain("调用 spawn_task 时，title 写简短的任务名");
});
