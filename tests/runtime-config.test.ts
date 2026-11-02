import { describe, expect, it } from "vitest";
import cases from "../contracts/fixtures/config-cases.json";
import validConfig from "../contracts/fixtures/config-valid.json";
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
