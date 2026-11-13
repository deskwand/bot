import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const tool = {
  name: "schema_probe",
  description: "Probe tool argument validation.",
  parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
};

function validate(args: JsonObject) {
  return validateToolArguments(tool, {
    type: "toolCall", id: "schema-probe", name: tool.name, arguments: args,
  });
}

describe("tool schema validation after the Pi upgrade", () => {
  it("coerces numeric strings without stripping undeclared properties or mutating input", () => {
    const args = { query: "a", limit: "5", extra: true };
    expect(validate(args)).toEqual({ query: "a", limit: 5, extra: true });
    expect(args).toEqual({ query: "a", limit: "5", extra: true });
  });

  it("rejects an invalid declared property", () => {
    expect(() => validate({ query: "a", limit: "not-a-number" })).toThrow();
  });
});
