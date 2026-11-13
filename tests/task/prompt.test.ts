import { describe, expect, it } from "vitest";
import { phoneRules } from "../../src/phone/style";
import { taskSystemPrompt } from "../../src/task/prompt";

function spec(botId?: string) {
  return {
    taskId: "t1",
    title: "检查价格",
    instructions: "盯着价格",
    ...(botId === undefined ? {} : { botId }),
  };
}

describe("taskSystemPrompt", () => {
  it("teaches bot runs to keep their documents", () => {
    const prompt = taskSystemPrompt("zh", spec("b1"), "telegram");

    expect(prompt).not.toContain("b1");
    expect(prompt).toContain("propose_rules");
    expect(prompt).toContain("write_doc");
    expect(prompt).toContain("search_runs");
    expect(prompt).toContain("finish_task");
  });

  it("explains the workspace", () => {
    const prompt = taskSystemPrompt(
      "zh",
      {
        taskId: "t1",
        title: "x",
        instructions: "i",
      },
      "telegram",
    );
    expect(prompt).toContain("workspace");
    expect(prompt).toContain("save_artifact");
    expect(prompt).toContain(
      'Use read, write, edit and list for drafts in your private workspace (the owner never sees it; files over 1 MB are refused). Build long documents there, then deliver the final file with save_artifact using `draft: "<path>"` instead of pasting its content. Saved artifacts and owner attachments are read with get_artifact.',
    );
  });

  it("leaves ordinary tasks without bot wording", () => {
    const prompt = taskSystemPrompt("zh", spec(), "telegram");

    expect(prompt).toContain("Instructions from the user:");
    expect(prompt).not.toContain("propose_rules");
  });

  it("lists attachments for the task", () => {
    const prompt = taskSystemPrompt(
      "zh",
      {
        taskId: "t1",
        title: "x",
        instructions: "i",
        attachments: [{ name: "a.pdf", key: "inbox/tg:1/a.pdf", mimeType: "application/pdf", size: 2048 }],
      },
      "telegram",
    );
    expect(prompt).toContain("[附件] a.pdf · application/pdf · 2.0 KB · key: inbox/tg:1/a.pdf");
    expect(prompt).toContain("get_artifact");
  });

  it("says nothing about attachments when there are none", () => {
    expect(
      taskSystemPrompt("zh", { taskId: "t1", title: "x", instructions: "i" }, "telegram"),
    ).not.toContain("[附件]");
  });

  it("task prompt ends with the phone rules", () => {
    const prompt = taskSystemPrompt("zh", spec(), "telegram");
    const rules = phoneRules("zh", { conversational: false });

    expect(prompt.endsWith(rules)).toBe(true);
    expect(prompt.indexOf(rules)).toBeGreaterThan(
      prompt.indexOf("Instructions from the user"),
    );
  });
});

describe("taskSystemPrompt channel and phone context", () => {
  it("names WeChat and never Telegram on a WeChat deployment", () => {
    const prompt = taskSystemPrompt("zh", spec(), "wechat");
    expect(prompt).toContain("asynchronous messaging channel (WeChat)");
    expect(prompt).not.toContain("Telegram");
  });

  it("names Telegram on a Telegram deployment", () => {
    expect(taskSystemPrompt("zh", spec(), "telegram")).toContain("asynchronous messaging channel (Telegram)");
  });

  it("drops the channel name when it is unknown", () => {
    const prompt = taskSystemPrompt("zh", spec(), null);
    expect(prompt).toContain("on an asynchronous messaging channel.");
    expect(prompt).not.toMatch(/\(\)|null|undefined/);
  });

  it("asks for a phone-sized summary", () => {
    const prompt = taskSystemPrompt("zh", spec(), "wechat");
    expect(prompt).toContain("usually read it on a phone");
    expect(prompt).toContain(phoneRules("zh", { conversational: false }));
    expect(prompt).not.toContain("one phone screen");
  });

  it("gives bot runs the reason not to notify the owner", () => {
    expect(taskSystemPrompt("zh", spec("b1"), "wechat")).toContain(
      "The owner is on their phone, away from a computer: every message interrupts them.",
    );
    expect(taskSystemPrompt("zh", spec(), "wechat")).not.toContain("every message interrupts them");
  });
});

describe("taskSystemPrompt delivery destination", () => {
  it("tells a bot run its summary stays in the run log", () => {
    const prompt = taskSystemPrompt("zh", spec("b1"), "wechat");
    expect(prompt).toContain("goes to the bot's run log, not to the owner");
    expect(prompt).toContain("(WeChat)");
    expect(prompt).not.toContain("Your summary is delivered to the owner");
    expect(prompt).toContain("Messages you send with `notify_owner` reach the owner");
  });

  it("drops the channel name for a bot run when it is unknown", () => {
    const prompt = taskSystemPrompt("zh", spec("b1"), null);
    expect(prompt).toContain("on an asynchronous messaging channel. They usually read them");
    expect(prompt).not.toContain("()");
  });

  it("places the phone block after the finish_task instructions for ordinary tasks", () => {
    const prompt = taskSystemPrompt("zh", spec(), "wechat");
    expect(prompt.indexOf("Your summary is delivered to the owner")).toBeGreaterThan(
      prompt.indexOf("When the work is done you MUST call"),
    );
  });
});
