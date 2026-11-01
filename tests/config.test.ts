import { describe, expect, it } from "vitest";
import { config, isOwner, needsApproval, type AppConfig } from "../src/config";

const cfg: AppConfig = {
  owner: { telegramUserIds: [111, 222] },
  models: {
    butler: { provider: "anthropic", id: "claude-sonnet-5-5" },
    task: { provider: "anthropic", id: "claude-sonnet-5-5" },
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

describe("default config", () => {
  it("configures both roles with the default model", () => {
    expect(config.models.butler).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(config.models.task).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
  });

  it("starts with no owners and no MCP servers", () => {
    expect(config.owner.telegramUserIds).toEqual([]);
    expect(config.mcpServers).toEqual([]);
  });
});
