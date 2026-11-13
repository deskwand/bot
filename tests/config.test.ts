import { describe, expect, it } from "vitest";
import {
  configApprovalMode,
  isOwner,
  needsApproval,
  type AppConfig,
} from "../src/config";
import { readSandboxTimeoutMs, sandboxEnabled } from "../src/sandbox/config";

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

describe("sandbox settings", () => {
  const base = {
    schemaVersion: 1,
    owner: { telegramUserIds: [1] },
    models: {
      butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    },
    mcpServers: [],
  };

  const envWith = (sandbox?: Record<string, unknown>) =>
    ({ DESKWAND_CONFIG: { ...base, ...(sandbox ? { sandbox } : {}) } }) as unknown as Env;

  it("defaults to a ten minute command timeout", () => {
    expect(readSandboxTimeoutMs(envWith())).toBe(600_000);
  });

  it("reads commandTimeoutMs from the sandbox section", () => {
    expect(readSandboxTimeoutMs(envWith({ commandTimeoutMs: 30_000 }))).toBe(30_000);
  });

  it("falls back to the default when the value fails the schema", () => {
    expect(readSandboxTimeoutMs(envWith({ commandTimeoutMs: 99_000_000 }))).toBe(600_000);
  });

  it("is enabled unless the section says otherwise", () => {
    expect(sandboxEnabled(envWith())).toBe(true);
    expect(sandboxEnabled(envWith({ enabled: true }))).toBe(true);
    expect(sandboxEnabled(envWith({ enabled: false }))).toBe(false);
  });

  it("keeps the tools enabled when the document is unreadable", () => {
    expect(sandboxEnabled({} as unknown as Env)).toBe(true);
  });
});
