import { describe, expect, it } from "vitest";
import {
  assertProviderToolDefinition,
  assertProviderToolDefinitions
} from "../../services/tools/providerToolSchema.js";
import { listToolMetadata } from "../../services/tools/toolRegistry.js";

describe("Provider tool schema gate", () => {
  it("accepts every built-in Provider-facing schema", () => {
    expect(() => assertProviderToolDefinitions(listToolMetadata().map((tool) => ({
      type: "function",
      name: tool.name,
      parameters: tool.parameters,
      strict: tool.strict
    })))).not.toThrow();
  });

  it("rejects oneOf and incomplete strict object schemas before a Provider request", () => {
    expect(() => assertProviderToolDefinition({
      type: "function",
      name: "bad_union",
      parameters: { type: "object", oneOf: [] },
      strict: false
    })).toThrow("PROVIDER_TOOL_SCHEMA_INVALID: bad_union: oneOf is not permitted");

    expect(() => assertProviderToolDefinition({
      type: "function",
      name: "bad_strict",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { optional: { type: "string" } },
        required: []
      },
      strict: true
    })).toThrow("PROVIDER_TOOL_SCHEMA_INVALID: bad_strict: strict object property optional must be required");
  });
});
