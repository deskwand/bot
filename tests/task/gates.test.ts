import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import type { ApprovalGateLike } from "../../src/task/approvals";
import { taskApprovalMode, taskGates } from "../../src/task/gates";

const cfg: AppConfig = {
  owner: { telegramUserIds: [111] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function fakeGate(name: string): ApprovalGateLike {
  return {
    async request() {
      return "approved";
    },
    async resolve() {
      return { ok: true, message: name };
    },
  };
}

const approval = fakeGate("approval");
const reviewed = fakeGate("reviewed");
const auto = fakeGate("auto");

describe("taskGates", () => {
  it("autonomous runs writes directly but keeps forced approvals", () => {
    const g = taskGates("autonomous", { approval, reviewed, auto });
    expect(g.write).toBe(auto);
    expect(g.mcp).toEqual({ approval, destructive: auto, review: auto });
  });
  it("reviewed keeps the previous wiring", () => {
    const g = taskGates("reviewed", { approval, reviewed, auto });
    expect(g.write).toBe(reviewed);
    expect(g.mcp).toEqual({ approval, destructive: approval, review: reviewed });
  });
});

describe("taskApprovalMode", () => {
  it("falls back to autonomous when the config cannot be read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        taskApprovalMode(() => {
          throw new Error("CONFIG_MISSING");
        }),
      ).toBe("autonomous");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("reads the configured mode", () => {
    expect(taskApprovalMode(() => ({ ...cfg, approvalMode: "reviewed" }))).toBe(
      "reviewed",
    );
  });
});
