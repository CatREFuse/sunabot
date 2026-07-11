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
    schemaVersion: 1,
    scope: "private",
    messageId: 42,
    time: "2026-07-11T12:00:00.000Z",
    userId: 10001,
    sender: { id: "10001", displayName: "tester" },
    text: "hello",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
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
    const decoded = decodeIncomingReply({
      ...payload,
      incoming: {
        scope: "private",
        userId: 10001,
        text: "hello",
        imageUrls: ["https://example.test/legacy.png"],
        attachments: [],
        replyMessageIds: [],
        quoteReferences: [],
        mentionedSelf: false,
        event: {
          post_type: "message",
          message_type: "private",
          message_id: 42,
          user_id: 10001,
          sender: { nickname: "legacy" },
          time: 1_783_776_000
        }
      }
    });
    expect(decoded.incoming).toMatchObject({
      schemaVersion: 1,
      scope: "private",
      messageId: 42,
      userId: 10001,
      sender: { id: "10001", nickname: "legacy" }
    });
    expect(decoded.incoming.media).toEqual([{
      schemaVersion: 1,
      kind: "image",
      source: "remote_url",
      url: "https://example.test/legacy.png"
    }]);
    expect(decoded.incoming).not.toHaveProperty("event");
    expect(decoded.incoming).not.toHaveProperty("imageUrls");
  });

  it("rejects unknown versions instead of coercing them", () => {
    expect(() => decodeIncomingReply({
      schemaVersion: 2,
      type: "runtime.incoming_reply",
      payload
    })).toThrow("不支持的持久化消息版本");
  });
});
