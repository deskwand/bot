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
    const prompt = taskSystemPrompt("zh", spec("b1"));

    expect(prompt).not.toContain("b1");
    expect(prompt).toContain("propose_rules");
    expect(prompt).toContain("write_doc");
    expect(prompt).toContain("search_runs");
    expect(prompt).toContain("finish_task");
  });

  it("leaves ordinary tasks without bot wording", () => {
    const prompt = taskSystemPrompt("zh", spec());

    expect(prompt).toContain("Instructions from the user:");
    expect(prompt).not.toContain("propose_rules");
  });

  it("lists attachments for the task", () => {
    const prompt = taskSystemPrompt("zh", {
      taskId: "t1",
      title: "x",
      instructions: "i",
      attachments: [{ name: "a.pdf", key: "inbox/tg:1/a.pdf", mimeType: "application/pdf", size: 2048 }],
    });
    expect(prompt).toContain("[附件] a.pdf · application/pdf · 2.0 KB · key: inbox/tg:1/a.pdf");
    expect(prompt).toContain("get_artifact");
  });

  it("says nothing about attachments when there are none", () => {
    expect(taskSystemPrompt("zh", { taskId: "t1", title: "x", instructions: "i" })).not.toContain("[附件]");
  });

  it("task prompt ends with the reply language", () => {
    expect(
      taskSystemPrompt("en", spec()).endsWith(
        "Always reply to the owner in English.",
      ),
    ).toBe(true);
    expect(taskSystemPrompt("zh", spec()).endsWith("始终用中文回复主人。")).toBe(
      true,
    );
  });
});
