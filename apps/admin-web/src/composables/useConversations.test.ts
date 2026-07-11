// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../types";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useConversations } from "./useConversations";

const conversation: ConversationRecord = {
  id: "group:7",
  scope: "user_group",
  title: "群聊",
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
  it("updates a switch immediately and keeps the server result", async () => {
    let resolveUpdate!: (value: unknown) => void;
    apiRequest
      .mockResolvedValueOnce({ conversations: [conversation] })
      .mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));

    const state = useConversations();
    await state.loadList();
    const saving = state.setReplyEnabled(conversation, false);

    expect(state.conversations.value[0]?.replyEnabled).toBe(false);

    resolveUpdate({ conversation: { ...conversation, replyEnabled: false } });
    await saving;
    expect(state.conversations.value[0]?.replyEnabled).toBe(false);
  });

  it("rolls back the switch when saving fails", async () => {
    apiRequest
      .mockResolvedValueOnce({ conversations: [conversation] })
      .mockRejectedValueOnce(new Error("保存失败"));

    const state = useConversations();
    await state.loadList();
    await state.setOrchestratorEnabled(conversation, false);

    expect(state.conversations.value[0]?.orchestratorEnabled).toBe(true);
    expect(state.error.value).toBe("保存失败");
  });
});
