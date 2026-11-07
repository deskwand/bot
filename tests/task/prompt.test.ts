import { describe, expect, it } from "vitest";
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
      'Use read, write, edit and list for drafts in your private workspace (the owner never sees it; files over 1 MB are refused; there is no shell). Build long documents there, then deliver the final file with save_artifact using `draft: "<path>"` instead of pasting its content. Saved artifacts and owner attachments are read with get_artifact.',
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

  it("task prompt ends with the reply language", () => {
    expect(
      taskSystemPrompt("en", spec(), "telegram").endsWith(
        "Always reply to the owner in English.",
      ),
    ).toBe(true);
    expect(taskSystemPrompt("zh", spec(), "telegram").endsWith("始终用中文回复主人。")).toBe(
      true,
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
    expect(prompt).toContain("Lead with the outcome");
    expect(prompt).toContain("one phone screen");
    expect(prompt).toContain("no tables, no multi-level headings");
  });

  it("gives bot runs the reason not to notify the owner", () => {
    expect(taskSystemPrompt("zh", spec("b1"), "wechat")).toContain(
      "The owner is on their phone, away from a computer: every message interrupts them.",
    );
    expect(taskSystemPrompt("zh", spec(), "wechat")).not.toContain("every message interrupts them");
  });
});
