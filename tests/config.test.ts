import { describe, expect, it } from "vitest";
import {
  configApprovalMode,
  isOwner,
  needsApproval,
  type AppConfig,
} from "../src/config";

const cfg: AppConfig = {
  owner: { telegramUserIds: [111, 222] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [
    { name: "notion", url: "https://mcp.example.com/notion", requireApproval: ["create_page"] },
  ],
};

describe("isOwner", () => {
  it("accepts ids in the allowlist", () => {
    expect(isOwner(cfg, 111)).toBe(true);
    expect(isOwner(cfg, 222)).toBe(true);
  });

  it("rejects ids outside the allowlist", () => {
    expect(isOwner(cfg, 333)).toBe(false);
  });

  it("rejects every id for an empty allowlist", () => {
    expect(isOwner({ ...cfg, owner: { telegramUserIds: [] } }, 111)).toBe(false);
  });
});

describe("configApprovalMode", () => {
  it("defaults to autonomous", () => {
    expect(configApprovalMode(cfg)).toBe("autonomous");
  });
  it("returns an explicit mode", () => {
    expect(configApprovalMode({ ...cfg, approvalMode: "reviewed" })).toBe("reviewed");
    expect(configApprovalMode({ ...cfg, approvalMode: "autonomous" })).toBe("autonomous");
  });
});

describe("needsApproval", () => {
  it("is true for a tool listed on the server", () => {
    expect(needsApproval(cfg, "notion", "create_page")).toBe(true);
  });

  it("is false for an unlisted tool", () => {
    expect(needsApproval(cfg, "notion", "search")).toBe(false);
  });

  it("is false for an unknown server", () => {
    expect(needsApproval(cfg, "github", "create_page")).toBe(false);
  });
});
