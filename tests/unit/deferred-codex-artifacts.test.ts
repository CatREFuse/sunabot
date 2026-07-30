// @vitest-environment node
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConversationCapabilityContext } from "../../services/conversations/conversationCapability.js";
import {
  readCodexInputHandles,
  snapshotDeferredCodexTask
} from "../../src/runtime/deferredCodexArtifacts.js";

describe("deferred Codex conversation artifacts", () => {
  it("freezes selected handles before durable dispatch and stores only bounded metadata", async () => {
    const frozen = [{
      schemaVersion: 1 as const,
      handle: "message:885282522:file:0",
      kind: "file" as const,
      relativePath: "inputs/input-1-cf7c.txt",
      displayName: "codex-input.txt",
      sha256: "cf7c6564a1d7757bbaac37c800294da3ad20245f19176def8390b303a39b72f6",
      sizeBytes: 33,
      mimeType: "text/plain"
    }];
    const freezeCodexInputs = vi.fn(async () => frozen);
    const capability = createConversationCapabilityContext({
      agentId: "arona",
      accountId: "secondary",
      conversationId: "account:secondary:private:1001",
      transport: "onebot",
      scope: "private",
      userId: 1001,
      isAdmin: true,
      messageId: 885282522,
      configEpoch: 7
    });

    const result = await snapshotDeferredCodexTask({
      toolCall: {
        name: "codex",
        callId: "call-codex-artifact",
        arguments: {
          task: "Read the input and create codex-result.txt.",
          kind: "analysis",
          inputHandles: ["message:885282522:file:0"],
          __sunabot_admin_authorized: true
        }
      },
      capability,
      chatMedia: {
        export: vi.fn(),
        freezeCodexInputs
      },
      jobRoot: "/tmp/sunabot-codex-jobs",
      isCurrent: () => true
    });

    expect(result.jobId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(freezeCodexInputs).toHaveBeenCalledWith(
      ["message:885282522:file:0"],
      path.join("/tmp/sunabot-codex-jobs", result.jobId!)
    );
    expect(result.toolCall.arguments).toMatchObject({
      inputHandles: ["message:885282522:file:0"],
      __sunabot_artifact_backend: "native",
      __sunabot_frozen_inputs: frozen
    });
    expect(JSON.stringify(result.toolCall.arguments)).not.toContain("base64");
    expect(JSON.stringify(result.toolCall.arguments)).not.toContain("https://");
  });

  it("rejects duplicate, cross-shape and malformed handles before freezing", () => {
    for (const value of [
      ["message:1:file:0", "message:1:file:0"],
      ["message:1:voice:0"],
      ["https://example.test/file.pdf"]
    ]) {
      expect(() => readCodexInputHandles(value)).toThrow("CODEX_INPUT_HANDLES_INVALID");
    }
    expect(readCodexInputHandles(null)).toEqual([]);
  });

  it("dispatches authenticated Web Codex without chat input handles", async () => {
    const capability = createConversationCapabilityContext({
      agentId: "arona",
      accountId: "web-admin",
      conversationId: "web:admin",
      transport: "web",
      scope: "private",
      userId: 1001,
      isAdmin: true,
      configEpoch: 7
    });

    const result = await snapshotDeferredCodexTask({
      toolCall: {
        name: "codex",
        callId: "call-web-codex",
        arguments: {
          task: "Create a report.",
          kind: "analysis",
          __sunabot_admin_authorized: true
        }
      },
      capability,
      jobRoot: "/tmp/sunabot-codex-jobs",
      isCurrent: () => true
    });

    expect(result.toolCall.arguments).toMatchObject({
      __sunabot_artifact_backend: "native"
    });
    expect(result.toolCall.arguments).not.toHaveProperty("__sunabot_frozen_inputs");
  });
});
