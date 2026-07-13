import { describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import { AgentRuntimeManager } from "../../services/agents/agentRuntimeManager.js";
import { BroadcastStormDetector } from "../../services/orchestration/broadcastStormDetector.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("AgentRuntimeManager broadcast storm integration", () => {
  it("resolves cross-Agent quoted replies, deduplicates the event, and cancels every runtime", async () => {
    const planaConfig = createAdminTestConfig("/tmp/sunabot-broadcast-storm-plana");
    const aronaConfig = structuredClone(planaConfig);
    aronaConfig.persona.defaultAgentId = "arona";
    aronaConfig.persona.name = "阿罗娜";
    const planaRuntime = runtime(planaConfig);
    const aronaRuntime = runtime(aronaConfig);
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 1,
      cooldownMinutes: 1
    });
    const registry = {
      list: vi.fn(async () => [agent("plana"), agent("arona")]),
      config: vi.fn(async (agentId: string) => agentId === "plana" ? planaConfig : aronaConfig),
      account: vi.fn(() => ({ id: "primary", agentId: "plana", enabled: true, qqId: "10001" })),
      get: vi.fn(async () => ({ ...agent("plana"), enabled: true })),
      updateAccountIdentity: vi.fn(),
      agentIdForQqId: vi.fn((qqId: string) => ({ "10001": "plana", "20002": "arona" })[qqId])
    } as unknown as AgentRegistry;
    const manager = new AgentRuntimeManager(registry, {
      defaultRuntime: planaRuntime,
      createRuntime: () => aronaRuntime,
      initializeRuntime: false,
      broadcastStormDetector: detector
    });
    await manager.initialize();
    const gateway = {
      getMessage: vi.fn(async () => ({
        text: "上一条",
        media: [],
        attachments: [],
        replyMessageIds: [],
        sender: { id: "10001" }
      }))
    } as unknown as MessagingPort;
    const message = {
      schemaVersion: 1 as const,
      scope: "user_group" as const,
      messageId: 9001,
      time: new Date().toISOString(),
      userId: 20002,
      groupId: 30003,
      sender: { id: "20002" },
      text: "继续",
      media: [],
      attachments: [],
      replyMessageIds: [8001],
      quoteReferences: [],
      mentionedSelf: false
    };

    await manager.handleInboundMessage(message, gateway, { accountId: "primary", selfId: "10001" });
    await manager.handleInboundMessage(message, gateway, { accountId: "primary", selfId: "10001" });

    expect(gateway.getMessage).toHaveBeenCalledTimes(2);
    expect(planaRuntime.cancelAllReplies).toHaveBeenCalledOnce();
    expect(aronaRuntime.cancelAllReplies).toHaveBeenCalledOnce();
    expect(detector.status().blocked).toBe(true);
    expect(planaRuntime.handleInboundMessage).toHaveBeenCalledTimes(2);
  });
});

function runtime(config: ReturnType<typeof createAdminTestConfig>) {
  return {
    config,
    handleInboundMessage: vi.fn(),
    cancelAllReplies: vi.fn(),
    close: vi.fn(),
    getPersonaStatus: vi.fn()
  } as unknown as SunaRuntime & {
    handleInboundMessage: ReturnType<typeof vi.fn>;
    cancelAllReplies: ReturnType<typeof vi.fn>;
  };
}

function agent(id: string) {
  return {
    id,
    name: id,
    enabled: true,
    workspace: `/tmp/${id}`,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    accounts: []
  };
}
