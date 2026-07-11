import { describe, expect, it } from "vitest";
import { enrichMemoryEntriesWithConversations } from "../../src/runtime.js";
import type { ConversationRecord } from "../../src/types.js";
import type { MemoryEntry } from "../../src/memory.js";

describe("memory identity enrichment", () => {
  it("uses the latest nickname and keeps the latest card for every group", () => {
    const entry = memoryEntry();
    const records = [
      conversation(100, [
        message("2026-07-10T01:00:00.000Z", "旧昵称", "一群旧名片", 100),
        message("2026-07-10T03:00:00.000Z", "新昵称", "一群新名片", 100)
      ]),
      conversation(200, [message("2026-07-10T02:00:00.000Z", "中间昵称", "二群名片", 200)])
    ];

    expect(enrichMemoryEntriesWithConversations([entry], records)[0]).toMatchObject({
      userNickname: "新昵称",
      groupCards: [
        { groupId: 100, card: "一群新名片", lastSeenAt: "2026-07-10T03:00:00.000Z" },
        { groupId: 200, card: "二群名片", lastSeenAt: "2026-07-10T02:00:00.000Z" }
      ]
    });
  });

  it("falls back to the stored memory name without inventing a group card", () => {
    expect(enrichMemoryEntriesWithConversations([memoryEntry()], [])[0]).toMatchObject({
      userNickname: "记忆称呼",
      groupCards: undefined
    });
  });
});

function memoryEntry(): MemoryEntry {
  return {
    id: "profile-1",
    source: "user_profile",
    sourceTitle: "用户画像",
    fileName: "sunabot.sqlite#memory/user-profile",
    editable: true,
    key: "QQ 42",
    value: "喜欢清淡口味",
    text: "喜欢清淡口味",
    field: "fact",
    userId: "42",
    userName: "记忆称呼"
  };
}

function conversation(groupId: number, messages: ConversationRecord["messages"]): ConversationRecord {
  return {
    id: `group:${groupId}`,
    scope: "user_group",
    title: `群 ${groupId}`,
    userId: 42,
    groupId,
    messageCount: messages.length,
    lastAt: messages.at(-1)?.at ?? "",
    lastText: messages.at(-1)?.text ?? "",
    messages
  };
}

function message(at: string, senderNickname: string, senderCard: string, groupId: number): ConversationRecord["messages"][number] {
  return { id: `${groupId}-${at}`, role: "user", text: "内容", at, userId: 42, groupId, senderNickname, senderCard };
}
