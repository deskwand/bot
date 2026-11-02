import { describe, expect, it } from "vitest";
import {
  decidePredeploy,
  hasConfigBinding,
  settingsBindings,
  workerNameFromConfig,
} from "../scripts/check-remote-config";

const base = {
  force: false,
  hasToken: true,
  hasAccount: true,
  workerExists: true,
  hasConfigBinding: false,
};

describe("predeploy remote configuration guard", () => {
  it("skips when the token or account id is missing", () => {
    expect(decidePredeploy({ ...base, hasToken: false })).toMatchObject({ action: "skip" });
    expect(decidePredeploy({ ...base, hasAccount: false })).toMatchObject({ action: "skip" });
  });

  it("skips when the Worker does not exist yet", () => {
    expect(decidePredeploy({ ...base, workerExists: false })).toMatchObject({ action: "skip" });
  });

  it("allows an existing Worker with DESKWAND_CONFIG", () => {
    expect(decidePredeploy({ ...base, hasConfigBinding: true })).toMatchObject({
      action: "allow",
    });
  });

  it("refuses an existing Worker without DESKWAND_CONFIG", () => {
    const decision = decidePredeploy(base);
    expect(decision.action).toBe("refuse");
    expect(decision.message).toContain("DESKWAND_CONFIG");
    expect(decision.message).toContain("拒绝部署");
  });

  it("allows an explicit --force bypass with a warning", () => {
    const decision = decidePredeploy({ ...base, force: true });
    expect(decision.action).toBe("allow");
    expect(decision.message).toContain("--force");
  });

  it("reads the Worker name from wrangler.jsonc", () => {
    expect(workerNameFromConfig('{\n  "$schema": "x",\n  "name": "bot",\n}')).toBe("bot");
    expect(workerNameFromConfig("not jsonc")).toBeUndefined();
  });

  it("recognizes bindings in raw and enveloped settings", () => {
    const bindings = [{ type: "json", name: "DESKWAND_CONFIG" }];
    expect(settingsBindings({ bindings })).toEqual(bindings);
    expect(settingsBindings({ result: { bindings } })).toEqual(bindings);
    expect(hasConfigBinding({ result: { bindings } })).toBe(true);
    expect(hasConfigBinding({ result: { bindings: [{ name: "PUBLIC_BASE_URL" }] } })).toBe(
      false,
    );
    expect(hasConfigBinding(null)).toBe(false);
  });
});
