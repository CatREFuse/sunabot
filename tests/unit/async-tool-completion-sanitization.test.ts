// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildAsyncToolCompletionPrompt,
  publicToolArguments
} from "../../src/runtime/infrastructure.js";

describe("async tool completion argument sanitization", () => {
  it("removes runtime-only Codex bridge metadata from callback context", () => {
    expect(publicToolArguments({
      task: "Summarize the PDF.",
      inputHandles: ["message:885282519:file:0"],
      __sunabot_artifact_backend: "native",
      __sunabot_frozen_inputs: [{
        relativePath: "inputs/input-1.pdf",
        sha256: "a".repeat(64)
      }]
    })).toEqual({
      task: "Summarize the PDF.",
      inputHandles: ["message:885282519:file:0"]
    });
  });

  it("does not expose frozen paths in the generated completion prompt", () => {
    const prompt = buildAsyncToolCompletionPrompt({
      type: "tool_result",
      toolJobId: "job-1",
      providerCallId: "call-1",
      toolName: "codex",
      originalRequest: {
        incoming: {
          schemaVersion: 1,
          accountId: "secondary",
          conversationId: "private:1001",
          scope: "private",
          userId: 1001,
          messageId: 885282519,
          time: "2026-07-30T13:21:00+08:00",
          text: "读取这个 PDF",
          sender: {},
          segments: [],
          media: [],
          attachments: [],
          replyMessageIds: [],
          quoteReferences: []
        }
      },
      arguments: {
        task: "Summarize the PDF.",
        __sunabot_frozen_inputs: [{
          relativePath: "inputs/private.pdf",
          sha256: "a".repeat(64)
        }]
      },
      outcome: {
        status: "succeeded",
        result: { ok: true },
        error: undefined
      }
    });

    expect(prompt).toContain("Summarize the PDF.");
    expect(prompt).not.toContain("__sunabot_frozen_inputs");
    expect(prompt).not.toContain("inputs/private.pdf");
  });
});
