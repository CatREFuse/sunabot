import { describe, expect, it } from "vitest";
import { parseRewrittenSelfiePrompt } from "../../src/runtime/selfie.js";

describe("selfie model content", () => {
  it("accepts wrapped JSON, extra fields, long prompts and repeated known reference ids", () => {
    const prompt = "完整画面描述".repeat(1_000);
    const result = { prompt, selectedSelfieReferenceIds: ["known", "known"], explanation: "extra" };
    expect(parseRewrittenSelfiePrompt(`说明\n\x60\x60\x60json\n${JSON.stringify(result)}\n\x60\x60\x60`, new Set(["known"])))
      .toEqual({ prompt, selectedSelfieReferenceIds: ["known"] });
  });

  it("does not authorize unknown reference ids or invent missing generation input", () => {
    expect(() => parseRewrittenSelfiePrompt(JSON.stringify({ prompt: "画面", selectedSelfieReferenceIds: ["unknown"] }), new Set(["known"])))
      .toThrow("unknown reference");
    expect(() => parseRewrittenSelfiePrompt(JSON.stringify({ selectedSelfieReferenceIds: ["known"] }), new Set(["known"])))
      .toThrow("invalid prompt");
  });
});
