// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assistantReplyEnvelope,
  decodeAssistantReply
} from "../../packages/contracts/session/runtimeMessages.js";
import type { InboundMessageV1 } from "../../packages/contracts/messaging/messages.js";

const incoming: InboundMessageV1 = {
  schemaVersion: 1,
  agentId: "koharu",
  accountId: "koharu-qq",
  scope: "private",
  time: "2026-07-18T00:00:00.000Z",
  userId: 42,
  sender: { id: "42" },
  text: "hello",
  media: [],
  attachments: [],
  replyMessageIds: [],
  quoteReferences: [],
  mentionedSelf: false
};

describe("emoji durable reply segments", () => {
  it("round trips ordered text and image segments", () => {
    const envelope = assistantReplyEnvelope({
      type: "assistant_reply",
      incoming,
      text: "前后",
      generatedImages: [
        { url: "/generated-images/agents/koharu/a.png", filePath: "/media/agents/koharu/a.png" },
        { url: "/generated-images/agents/koharu/b.png", filePath: "/media/agents/koharu/b.png" }
      ],
      contentSegments: [
        { type: "text", text: "前" },
        { type: "image", imageIndex: 0 },
        { type: "text", text: "后" },
        { type: "image", imageIndex: 1 }
      ],
      isAdmin: false
    }, { conversationId: "private:42", correlationId: "emoji-test" });

    expect(decodeAssistantReply(envelope).contentSegments).toEqual(envelope.payload.contentSegments);
  });

  it("rejects text mismatch, duplicate indexes, missing images, and oversized layouts", () => {
    const base = assistantReplyEnvelope({
      type: "assistant_reply",
      incoming,
      text: "正文",
      generatedImages: [{ url: "/generated-images/a.png" }],
      contentSegments: [
        { type: "text", text: "正文" },
        { type: "image", imageIndex: 0 }
      ],
      isAdmin: false
    }, { correlationId: "invalid-emoji-test" });

    expect(() => decodeAssistantReply({
      ...base,
      payload: { ...base.payload, text: "改变" }
    })).toThrow("contentSegments");
    expect(() => decodeAssistantReply({
      ...base,
      payload: {
        ...base.payload,
        contentSegments: [
          { type: "text", text: "正文" },
          { type: "image", imageIndex: 0 },
          { type: "image", imageIndex: 0 }
        ]
      }
    })).toThrow("contentSegments");
    expect(() => decodeAssistantReply({
      ...base,
      payload: { ...base.payload, generatedImages: [] }
    })).toThrow("contentSegments");
    expect(() => decodeAssistantReply({
      ...base,
      payload: {
        ...base.payload,
        generatedImages: [
          ...base.payload.generatedImages,
          { url: "/generated-images/unreferenced.png" }
        ]
      }
    })).toThrow("contentSegments");
    expect(() => decodeAssistantReply({
      ...base,
      payload: {
        ...base.payload,
        text: "x".repeat(65),
        generatedImages: [],
        contentSegments: Array.from({ length: 65 }, () => ({ type: "text", text: "x" }))
      }
    })).toThrow("contentSegments");
  });

  it("keeps old assistant replies without ordered segments compatible", () => {
    const legacy = assistantReplyEnvelope({
      type: "assistant_reply",
      incoming,
      text: "旧消息",
      generatedImages: [{ url: "/generated-images/legacy.png" }],
      isAdmin: false
    }, { correlationId: "legacy-emoji-test" });
    expect(decodeAssistantReply(legacy).contentSegments).toBeUndefined();
  });
});
