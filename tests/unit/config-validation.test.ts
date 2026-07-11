// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  exactKeys,
  integer,
  optionalReasoningEffort,
  pathString,
  requiredString
} from "../../src/admin/configValidation.js";

describe("admin config validation primitives", () => {
  it("preserves strict unknown and missing field errors", () => {
    expect(() => exactKeys({ host: "127.0.0.1", extra: true }, ["host"], "server"))
      .toThrow(expect.objectContaining({
        code: "CONFIG_UNKNOWN_FIELD",
        field: "server.extra"
      }));
    expect(() => exactKeys({}, ["host"], "server"))
      .toThrow(expect.objectContaining({
        code: "CONFIG_INVALID",
        field: "server.host"
      }));
  });

  it("preserves text normalization and NUL rejection", () => {
    expect(requiredString("  value  ", "field", { trim: true, min: 1, max: 20 })).toBe("value");
    expect(() => requiredString("bad\0value", "field", { trim: true, min: 1, max: 20 }))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", field: "field" }));
  });

  it("keeps relative Agent paths inside the workspace", () => {
    expect(pathString("prompts/reply.json", "promptFile", true)).toBe("prompts/reply.json");
    expect(() => pathString("../outside.json", "promptFile", true))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", field: "promptFile" }));
  });

  it("preserves integer bounds and model effort validation", () => {
    expect(integer(16, "maxConcurrency", 1, 16)).toBe(16);
    expect(() => integer(16.5, "maxConcurrency", 1, 32))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", field: "maxConcurrency" }));
    expect(optionalReasoningEffort("high", "reasoningEffort")).toBe("high");
    expect(() => optionalReasoningEffort("impossible", "reasoningEffort"))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", field: "reasoningEffort" }));
  });
});
