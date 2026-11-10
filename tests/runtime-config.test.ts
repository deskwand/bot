import { describe, expect, it } from "vitest";
import cases from "../contracts/fixtures/config-cases.json";
import validConfig from "../contracts/fixtures/config-valid.json";
import { configLocale } from "../src/config";
import { RuntimeConfigError, readRuntimeConfig } from "../src/runtime-config";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type ConfigCase = { name: string; input: unknown; valid: boolean };

function envWith(config: unknown): Env {
  return { DESKWAND_CONFIG: config } as unknown as Env;
}

describe("readRuntimeConfig", () => {
  it("never falls back to a repository owner", () => {
    expect(() =>
      readRuntimeConfig({ DESKWAND_CONFIG: undefined } as Env),
    ).toThrow(RuntimeConfigError);
  });

  it("accepts a configured empty owner list", () => {
    const cfg = readRuntimeConfig(
      { DESKWAND_CONFIG: validConfig } as unknown as Env,
    );
    expect(cfg.owner.telegramUserIds).toEqual([]);
  });

  it("accepts the JSON-string binding form used by CLI and dev", () => {
    const parsed = readRuntimeConfig(envWith(JSON.stringify(validConfig)));
    expect(parsed).toEqual(validConfig);
  });

  it("reports a fixed code instead of the raw configuration", () => {
    const secretish = "SK_do_not_echo";
    const invalid = {
      ...validConfig,
      models: {
        ...validConfig.models,
        butler: { provider: secretish, id: secretish },
      },
    };

    let caught: unknown;
    try {
      readRuntimeConfig(envWith(invalid));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigError);
    const error = caught as RuntimeConfigError;
    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).not.toContain(secretish);
    expect(error.message).toContain("CONFIG_SCHEMA_INVALID");
  });

  it("rejects a role that references an unknown provider", () => {
    const invalid = {
      ...validConfig,
      models: {
        ...validConfig.models,
        butler: { provider: "ghost", id: "ghost-model" },
      },
    };

    let caught: unknown;
    try {
      readRuntimeConfig(envWith(invalid));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigError);
    const error = caught as RuntimeConfigError;
    expect(error.code).toBe("CONFIG_MODELS_INVALID");
    expect(error.message).not.toContain("ghost");
    expect(error.message).not.toContain("ghost-model");
  });

  for (const testCase of cases as ConfigCase[]) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.name}`, () => {
      const env = envWith(testCase.input);
      if (testCase.valid) {
        expect(() => readRuntimeConfig(env)).not.toThrow();
      } else {
        expect(() => readRuntimeConfig(env)).toThrow(RuntimeConfigError);
      }
    });
  }

  it("defaults the locale to Chinese when it is absent", () => {
    expect(configLocale(readRuntimeConfig(envWith(validConfig)))).toBe("zh");
  });

  it("reads the published English locale", () => {
    const cfg = readRuntimeConfig(envWith({ ...validConfig, locale: "en" }));
    expect(configLocale(cfg)).toBe("en");
  });

  it("rejects an unsupported locale", () => {
    let caught: unknown;
    try {
      readRuntimeConfig(envWith({ ...validConfig, locale: "fr" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigError);
    expect((caught as RuntimeConfigError).code).toBe("CONFIG_SCHEMA_INVALID");
  });

  it("accepts approvalMode reviewed", () => {
    const cfg = readRuntimeConfig(
      envWith({ ...validConfig, approvalMode: "reviewed" }),
    );
    expect(cfg.approvalMode).toBe("reviewed");
  });

  it("rejects an unknown approvalMode", () => {
    let caught: unknown;
    try {
      readRuntimeConfig(envWith({ ...validConfig, approvalMode: "off" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigError);
    expect((caught as RuntimeConfigError).code).toBe("CONFIG_SCHEMA_INVALID");
  });

  it("accepts a known search provider", () => {
    const cfg = readRuntimeConfig(
      envWith({ ...validConfig, search: { provider: "tavily" } }),
    );
    expect(cfg.search?.provider).toBe("tavily");
  });

  it("rejects an unknown search provider", () => {
    let caught: unknown;
    try {
      readRuntimeConfig(
        envWith({ ...validConfig, search: { provider: "bing" } }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigError);
    expect((caught as RuntimeConfigError).code).toBe("CONFIG_SCHEMA_INVALID");
  });

  it("preserves env:NAME MCP header references and literals", () => {
    const testCase = (cases as ConfigCase[]).find(
      (entry) => entry.name === "MCP env:NAME header preserved",
    );
    expect(testCase).toBeDefined();

    const cfg = readRuntimeConfig(envWith(testCase?.input));
    expect(cfg.mcpServers[0]?.headers).toEqual({
      Authorization: "env:MCP_TOKEN",
      "X-Trace": "abc-123",
    });
  });

  it("preserves MCP catalog fields", () => {
    const testCase = (cases as ConfigCase[]).find(
      (entry) => entry.name === "MCP catalog fields preserved",
    );
    expect(testCase).toBeDefined();

    const cfg = readRuntimeConfig(envWith(testCase?.input));
    expect(cfg.mcpServers[0]).toEqual({
      name: "notion",
      description: "Notion：页面与数据库",
      catalogId: "notion",
      url: "https://mcp.example.com/notion",
      headers: { Authorization: "env:MCP_NOTION_TOKEN" },
      oauth: true,
      enabled: false,
      approvalPolicy: "writes",
      requireApproval: ["create_page"],
      autoApprove: ["search"],
      disabledTools: ["delete_page"],
    });
  });

  it("preserves advanced fields for round-trip", () => {
    const testCase = (cases as ConfigCase[]).find(
      (entry) => entry.name === "extra advanced field",
    );
    expect(testCase).toBeDefined();

    const cfg = readRuntimeConfig(envWith(testCase?.input)) as unknown as {
      advanced: { retryLimit: number };
      models: { butler: { thinking: { effort: string } } };
    };
    expect(cfg.advanced).toEqual({ retryLimit: 3 });
    expect(cfg.models.butler.thinking).toEqual({ effort: "low" });
  });
});
