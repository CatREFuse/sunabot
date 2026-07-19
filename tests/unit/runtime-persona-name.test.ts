// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectGroupChatSummaryMessages,
  resolveRuntimePersonaName
} from "../../src/runtime/conversationMemoryHelpers.js";
import { formatModelTimestamp } from "../../services/agent/modelTime.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime persona names", () => {
  it("prefers the loaded persona, then the configured Agent, then a generic fallback", () => {
    expect(resolveRuntimePersonaName("阿罗娜", "小春")).toBe("阿罗娜");
    expect(resolveRuntimePersonaName(undefined, " 小春 ")).toBe("小春");
    expect(resolveRuntimePersonaName(" ", " ")).toBe("助手");
  });

  it("uses the configured non-Plana Agent before the persona has loaded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-persona-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "arona";
    config.persona.name = "阿罗娜";
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const incoming = privateIncoming();

    try {
      const record = runtime.recordAssistantRequestStarted(incoming, "run-arona");
      runtime.recordAssistantMessage(incoming, "回复", [], "run-arona");
      runtime.recordServiceMessage(record, "服务消息");
      runtime.recordOrchestratorDecision(record, {
        status: "completed",
        shouldReply: false,
        reason: "无需回复",
        raw: "{}"
      }, "orchestrator-arona");

      expect(record.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.senderName))
        .toEqual(["阿罗娜", "阿罗娜", "阿罗娜"]);
    } finally {
      runtime.close();
    }
  });

  it("uses the configured or generic persona status name before the persona has loaded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-persona-status-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "arona";
    config.persona.name = "阿罗娜";
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });

    try {
      expect(runtime.getPersonaStatus().name).toBe("阿罗娜");
      config.persona.name = " ";
      expect(runtime.getPersonaStatus().name).toBe("助手");
    } finally {
      runtime.close();
    }
  });

  it("keeps stored assistant names in group summaries and uses a generic name for legacy gaps", () => {
    const now = new Date().toISOString();
    const record = {
      messages: [
        { id: "assistant-arona", role: "assistant", text: "阿罗娜回复", at: now, senderName: "阿罗娜" },
        { id: "assistant-legacy", role: "assistant", text: "旧回复", at: now }
      ]
    } as ConversationRecord;

    expect(collectGroupChatSummaryMessages(record, groupIncoming())).toEqual([
      expect.objectContaining({ at: formatModelTimestamp(now), senderName: "阿罗娜", text: "阿罗娜回复" }),
      expect.objectContaining({ at: formatModelTimestamp(now), senderName: "助手", text: "旧回复" })
    ]);
  });
});

function privateIncoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "private",
    messageId: 1001,
    time: "2026-07-19T00:00:00.000Z",
    userId: 2002,
    selfId: 3003,
    sender: { id: "2002", displayName: "用户" },
    text: "你好",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function groupIncoming(): ParsedIncomingMessage {
  return {
    ...privateIncoming(),
    scope: "user_group",
    messageId: 1002,
    groupId: 4004
  };
}
