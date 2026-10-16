import { describe, expect, it } from "vitest";
import { parseCodexResultText, normalizeModelResult } from "../../adapters/codex/codexResult.js";
import type { CodexSupervisorRequest } from "../../packages/contracts/tools/codex.js";

describe("Codex result content", () => {
  it("extracts wrapped output and keeps additional model fields from blocking the report", () => {
    expect(parseCodexResultText('Result:\n```json\n{"content":"done","status":"succeeded","extra":true}\n```'))
      .toMatchObject({ status: "succeeded", content: "done", artifacts: [] });
  });

  it("preserves plain text and indeterminate status without claiming task success", () => {
    const content = "A report with no explicit completion status.";
    const parsed = parseCodexResultText(content);
    expect(parsed).toMatchObject({ status: "unknown", content });
    expect(normalizeModelResult({ jobId: "test", kind: "analysis" } as CodexSupervisorRequest, parsed, {}))
      .toMatchObject({ status: "unknown", content, error: { retryable: false } });
  });

  it("continues to reject artifact paths outside the authorized output directory", () => {
    expect(() => parseCodexResultText(JSON.stringify({ status: "succeeded", content: "done", artifacts: [
      { relativePath: "../secret", displayName: "secret" }
    ] }))).toThrow("Codex artifact path is invalid");
  });
});
