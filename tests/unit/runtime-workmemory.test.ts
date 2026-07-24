// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { readWorkingMemoryDocument } from "../../services/memory/public.js";
import { RuntimeWorkingMemory } from "../../src/runtime/workMemory.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("runtime add_workmemory binding", () => {
  let root = "";

  afterEach(async () => {
    closeApplicationDataStores();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("binds the current Agent workspace and complete conversation source", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const conversationId = "account:secondary:group:30003";
    const record = conversation(conversationId);
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map([[conversationId, record]])
    } as never);

    const result = await runtime.toolPort(incoming()).execute({
      content: "下一轮继续核对部署前验证。"
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId,
      conversationScope: "user_group"
    });
    expect((await readWorkingMemoryDocument(config)).items).toEqual([
      expect.objectContaining({
        content: "下一轮继续核对部署前验证。",
        conversationId,
        conversationScope: "user_group",
        conversationTitle: "交付群",
        sourceKind: "add_workmemory"
      })
    ]);
    const audit = applicationDataStore(config).readRequestLogs({
      query: "memory.operation",
      limit: 10
    });
    expect(audit).toEqual([
      expect.objectContaining({
        category: "memory.operation",
        action: "working.append",
        request: expect.objectContaining({
          actor: "model_tool",
          conversationId,
          conversationScope: "user_group",
          source: "working"
        }),
        response: expect.objectContaining({ outcome: "applied" }),
        metadata: expect.objectContaining({
          agentId: config.persona.defaultAgentId,
          conversationId
        })
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain("下一轮继续核对部署前验证");
  });

  it("records whether the exposed tool was invoked without storing conversation content", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-decision-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map()
    } as never);

    runtime.recordToolDecision(incoming(), []);
    runtime.recordToolDecision(incoming(), ["add_workmemory"]);

    const audit = applicationDataStore(config).readRequestLogs({
      query: "working.tool_decision",
      limit: 10
    });
    expect(audit.map((item) => item.response)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "unchanged", reasonCode: "model_not_invoked" }),
      expect.objectContaining({ outcome: "recorded", reasonCode: "model_invoked" })
    ]));
    expect(JSON.stringify(audit)).not.toContain("记录一下");
  });
});

function incoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: "agent-a",
    accountId: "secondary",
    scope: "user_group",
    messageId: 1,
    time: "2026-07-24T09:00:00.000+08:00",
    userId: 10001,
    groupId: 30003,
    selfId: 90001,
    sender: { id: "10001", displayName: "测试用户" },
    text: "记录一下",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function conversation(id: string): ConversationRecord {
  return {
    id,
    agentId: "agent-a",
    accountId: "secondary",
    scope: "user_group",
    title: "交付群",
    userId: 10001,
    groupId: 30003,
    selfId: 90001,
    messageCount: 0,
    lastAt: "2026-07-24T09:00:00.000+08:00",
    lastText: "",
    messages: []
  };
}
