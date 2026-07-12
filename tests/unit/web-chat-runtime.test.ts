import { describe, expect, it } from "vitest";
import type { ConversationRecord } from "../../src/types.js";
import { runtime_getActiveConversationRecords } from "../../src/runtime/conversations.js";
import {
  runtime_getConversationMessages,
  runtime_getConversationRecords
} from "../../src/runtime/lifecycle.js";
import {
  normalizeConversationId,
  normalizeConversationLookupId,
  WEB_CHAT_CONVERSATION_ID
} from "../../src/runtime/messagingAttachmentHelpers.js";

describe("Web Chat runtime isolation", () => {
  it("reads web:admin without opening the QQ conversation mutation boundary", () => {
    expect(normalizeConversationId(WEB_CHAT_CONVERSATION_ID)).toBe("");
    expect(normalizeConversationLookupId(WEB_CHAT_CONVERSATION_ID)).toBe(WEB_CHAT_CONVERSATION_ID);

    const web = conversation(WEB_CHAT_CONVERSATION_ID, "Web Chat");
    const host = {
      conversationRecords: new Map([[web.id, web]])
    };
    const page = runtime_getConversationMessages.call(host as never, WEB_CHAT_CONVERSATION_ID, { limit: 20 });

    expect(page).toMatchObject({
      conversationId: WEB_CHAT_CONVERSATION_ID,
      messages: [{ role: "user", text: "测试消息" }]
    });
  });

  it("keeps Web Chat out of QQ lists and OneBot announcement targets", () => {
    const web = conversation(WEB_CHAT_CONVERSATION_ID, "Web Chat");
    const qq = conversation("private:171419991", "管理员");
    const host = {
      conversationRecords: new Map([[web.id, web], [qq.id, qq]]),
      isAdminUser: () => true,
      publicConversationRecord: (record: ConversationRecord) => record
    };

    expect(runtime_getConversationRecords.call(host as never).map((record) => record.id))
      .toEqual([qq.id]);
    expect(runtime_getActiveConversationRecords.call(host as never).map((record) => record.id))
      .toEqual([qq.id]);
  });
});

function conversation(id: string, title: string): ConversationRecord {
  const at = new Date().toISOString();
  return {
    id,
    scope: "private",
    title,
    userId: 171419991,
    messageCount: 1,
    lastAt: at,
    lastText: "测试消息",
    messages: [{
      id: `${id}:1`,
      role: "user",
      text: "测试消息",
      at,
      sequence: 1,
      userId: 171419991
    }]
  };
}
