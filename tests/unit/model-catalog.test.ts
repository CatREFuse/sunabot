// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  resolveModelReasoningEffort
} from "../../src/admin/models.js";

describe("model catalog", () => {
  it("exposes the required model IDs in product order", () => {
    expect(MODEL_CATALOG.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark"
    ]);
  });

  it("supports max and ultra only where advertised", () => {
    const sol = MODEL_CATALOG.find((model) => model.id === "gpt-5.6-sol");
    const terra = MODEL_CATALOG.find((model) => model.id === "gpt-5.6-terra");
    const luna = MODEL_CATALOG.find((model) => model.id === "gpt-5.6-luna");

    expect(sol?.reasoningEfforts).toContain("ultra");
    expect(terra?.reasoningEfforts).toContain("ultra");
    expect(luna?.reasoningEfforts).toContain("max");
    expect(luna?.reasoningEfforts).not.toContain("ultra");
  });

  it("uses the actual auxiliary model default for invalid inherited effort", () => {
    expect(resolveModelReasoningEffort("gpt-5.4-mini", "ultra")).toMatchObject({
      effort: "medium",
      adjusted: true
    });
  });

  it("preserves compatible effort for custom models", () => {
    expect(resolveModelReasoningEffort("local-model", "minimal")).toMatchObject({
      effort: "minimal",
      adjusted: false
    });
  });
});
