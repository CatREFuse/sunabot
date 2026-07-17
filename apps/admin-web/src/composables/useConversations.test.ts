// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../types";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useConversations } from "./useConversations";

const conversation: ConversationRecord = {
  id: "group:7",
  scope: "user_group",
  title: "测试群聊",
  groupName: "测试群聊",
  userId: 1,
  groupId: 7,
  messageCount: 1,
  lastAt: "2026-07-12T00:00:00.000Z",
  lastText: "消息",
  messages: [],
  replyEnabled: true,
  orchestratorEnabled: true
};

describe("useConversations reply settings", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("updates a switch without replacing the directory group name", async () => {
    let resolveUpdate!: (value: unknown) => void;
    apiRequest
      .mockResolvedValueOnce({ conversations: [conversation] })
      .mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));

    const state = useConversations();
    await state.loadList();
    const saving = state.setReplyEnabled(conversation, false);

    expect(state.conversations.value[0]?.replyEnabled).toBe(false);
    expect(state.mutationBusy.value[conversation.id]).toBe("reply");

    resolveUpdate({
      conversation: {
        ...conversation,
        title: "7",
        groupName: undefined,
        replyEnabled: false
      }
    });
    await expect(saving).resolves.toBe(true);
    expect(state.conversations.value[0]?.replyEnabled).toBe(false);
    expect(state.conversations.value[0]?.title).toBe("测试群聊");
    expect(state.conversations.value[0]?.groupName).toBe("测试群聊");
    expect(state.mutationBusy.value[conversation.id]).toBeUndefined();
    expect(state.mutationErrors.value[conversation.id]).toBeUndefined();
  });

  it("rolls back, refetches and exposes an action error when saving fails", async () => {
    apiRequest
      .mockResolvedValueOnce({ conversations: [conversation] })
      .mockRejectedValueOnce(new Error("保存失败"))
      .mockResolvedValueOnce({ conversations: [conversation] });

    const state = useConversations();
    await state.loadList();
    await expect(state.setOrchestratorEnabled(conversation, false)).resolves.toBe(false);

    expect(state.conversations.value[0]?.orchestratorEnabled).toBe(true);
    expect(state.error.value).toBe("");
    expect(state.mutationBusy.value[conversation.id]).toBeUndefined();
    expect(state.mutationErrors.value[conversation.id]?.orchestrator).toBe("保存失败，已重新读取当前状态");
    expect(apiRequest).toHaveBeenNthCalledWith(3, "/api/conversations", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("serializes mutations for one conversation and ignores repeated clicks", async () => {
    let resolveUpdate!: (value: unknown) => void;
    apiRequest
      .mockResolvedValueOnce({ conversations: [conversation] })
      .mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));

    const state = useConversations();
    await state.loadList();
    const saving = state.setReplyEnabled(conversation, false);

    await expect(state.setReplyEnabled(conversation, true)).resolves.toBe(false);
    await expect(state.setOrchestratorEnabled(conversation, false)).resolves.toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(state.mutationBusy.value[conversation.id]).toBe("reply");

    resolveUpdate({ conversation: { ...conversation, replyEnabled: false } });
    await expect(saving).resolves.toBe(true);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(state.mutationBusy.value[conversation.id]).toBeUndefined();
  });
});
