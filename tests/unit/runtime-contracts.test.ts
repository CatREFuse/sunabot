// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decodeIncomingReply,
  incomingReplyEnvelope,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";

const payload = {
  type: "incoming_reply",
  route: "direct",
  incoming: {
    scope: "private",
    userId: 10001,
    text: "hello",
    imageUrls: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false,
    event: { post_type: "message", message_type: "private", user_id: 10001 }
  },
  captureSequence: 1
} satisfies RuntimeIncomingReplyEventPayload;

describe("runtime persisted contracts", () => {
  it("encodes and decodes a versioned envelope", () => {
    const encoded = incomingReplyEnvelope(payload, {
      conversationId: "private:10001",
      correlationId: "onebot:42",
      idempotencyKey: "reply:42"
    });
    expect(encoded).toMatchObject({ schemaVersion: 1, type: "runtime.incoming_reply" });
    expect(decodeIncomingReply(encoded)).toEqual(payload);
  });

  it("keeps legacy rows readable during forward migration", () => {
    expect(decodeIncomingReply(payload)).toEqual(payload);
  });

  it("rejects unknown versions instead of coercing them", () => {
    expect(() => decodeIncomingReply({
      schemaVersion: 2,
      type: "runtime.incoming_reply",
      payload
    })).toThrow("不支持的持久化消息版本");
  });
});
