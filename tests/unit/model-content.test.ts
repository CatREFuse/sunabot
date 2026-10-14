import { describe, expect, it } from "vitest";
import { modelContentText, parseModelJson } from "../../packages/contracts/model/modelContent.js";

describe("model content", () => {
  it("accepts JSON wrapped in prose or fences without changing text values", () => {
    const value = { extra: true, text: 'Keep braces { and escaped quotes " intact.', items: [1, 2] };
    const encoded = JSON.stringify(value);
    expect(parseModelJson(encoded)).toEqual(value);
    expect(parseModelJson(`Here is the result:\n\`\`\`json\n${encoded}\n\`\`\``)).toEqual(value);
    expect(parseModelJson(`Result: ${encoded}\nDone.`)).toEqual(value);
    expect(parseModelJson(`说明 [not json] ${encoded}`)).toEqual(value);
  });

  it("leaves unstructured output available to its consumer", () => {
    expect(parseModelJson("A plain language response.")).toBeUndefined();
    expect(parseModelJson('{"unfinished":')).toBeUndefined();
    expect(modelContentText("x".repeat(80_000))).toHaveLength(80_000);
    expect(modelContentText({ detail: "preserved" })).toBe('{"detail":"preserved"}');
    expect(modelContentText(null)).toBe("");
  });
});
