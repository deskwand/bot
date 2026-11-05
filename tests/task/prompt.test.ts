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
    const prompt = taskSystemPrompt(spec("b1"));

    expect(prompt).not.toContain("b1");
    expect(prompt).toContain("propose_rules");
    expect(prompt).toContain("write_doc");
    expect(prompt).toContain("search_runs");
    expect(prompt).toContain("finish_task");
  });

  it("leaves ordinary tasks without bot wording", () => {
    const prompt = taskSystemPrompt(spec());

    expect(prompt).toContain("Instructions from the user:");
    expect(prompt).not.toContain("propose_rules");
  });
});
