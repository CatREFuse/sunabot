// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inboundMessageIdentityV1 } from "../../packages/contracts/messaging/incomingIdentity.js";
import {
  MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS,
  decodeReplyDebounce,
  replyDebounceEnvelope
} from "../../packages/contracts/session/runtimeMessages.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { persistentIncomingKey } from "../../src/runtime/messagingAttachmentHelpers.js";

const replyGate = {
  generation: "identity-test",
  scope: "user_group" as const,
  conversationId: "account:qq-secondary:group:7001",
  scopeEpoch: 0,
  conversationEpoch: 0
};
const replyQuote = { enabled: false, replyToMessageId: null };

describe("id-less incoming identity", () => {
  it("is stable across exact redelivery and ignores local attachment processing state", () => {
    const incoming = idlessIncoming();
    const redelivery = structuredClone(incoming);
    redelivery.attachments[0] = {
      ...redelivery.attachments[0]!,
      status: "ready",
      url: "https://temporary.test/download-token-2",
      cacheKey: "local-cache-2",
      textPreview: "a different parsed preview",
      chunkIndexPath: "/private/cache/chunks-2.sqlite",
      visualPagePaths: ["/private/cache/page-2.png"],
      visualSourcePath: "/private/cache/source-2.pdf",
      errorMessage: "local parser detail"
    };

    expect(inboundMessageIdentityV1(redelivery)).toBe(inboundMessageIdentityV1(incoming));
    expect(persistentIncomingKey(redelivery)).toBe(persistentIncomingKey(incoming));
  });

  it.each([
    ["transport", (value: ParsedIncomingMessage) => { value.transport = "web"; }],
    ["account", (value: ParsedIncomingMessage) => { value.accountId = "qq-other"; }],
    ["self", (value: ParsedIncomingMessage) => { value.selfId = 9002; }],
    ["conversation", (value: ParsedIncomingMessage) => { value.groupId = 7002; }],
    ["sender id", (value: ParsedIncomingMessage) => { value.sender.id = "5002"; }],
    ["sender nickname", (value: ParsedIncomingMessage) => { value.sender.nickname = "other"; }],
    ["sender card", (value: ParsedIncomingMessage) => { value.sender.card = "other-card"; }],
    ["sender display", (value: ParsedIncomingMessage) => { value.sender.displayName = "Other"; }],
    ["time", (value: ParsedIncomingMessage) => { value.time = "2026-07-17T02:00:01.000Z"; }],
    ["text", (value: ParsedIncomingMessage) => { value.text = "different text"; }],
    ["media", (value: ParsedIncomingMessage) => { value.media[0]!.url = "https://example.test/b.png"; }],
    ["attachment", (value: ParsedIncomingMessage) => { value.attachments[0]!.name = "other.pdf"; }],
    ["reply target", (value: ParsedIncomingMessage) => { value.replyMessageIds = [9912]; }],
    ["quote", (value: ParsedIncomingMessage) => { value.quoteReferences[0]!.text = "different quote"; }]
  ])("changes when %s changes", (_label, mutate) => {
    const incoming = idlessIncoming();
    const different = structuredClone(incoming);
    mutate(different);
    expect(inboundMessageIdentityV1(different)).not.toBe(inboundMessageIdentityV1(incoming));
    expect(persistentIncomingKey(different)).not.toBe(persistentIncomingKey(incoming));
  });

  it("digests every array position and keeps the external key bounded", () => {
    const incoming = idlessIncoming();
    incoming.text = "x".repeat(100_000);
    incoming.attachments = Array.from({ length: 65 }, (_, index) => ({
      ...incoming.attachments[0]!,
      id: `attachment-${index}`,
      name: `${"n".repeat(2_000)}-${index}`,
      textPreview: "parsed".repeat(10_000)
    }));
    incoming.quoteReferences = Array.from({ length: 65 }, (_, index) => ({
      ...incoming.quoteReferences[0]!,
      messageId: 20_000 + index,
      text: `${"q".repeat(2_000)}-${index}`
    }));
    const changedAttachment = structuredClone(incoming);
    changedAttachment.attachments[32]!.fileId = "middle-different";
    const changedQuote = structuredClone(incoming);
    changedQuote.quoteReferences[32]!.senderName = "middle-different";

    expect(persistentIncomingKey(changedAttachment)).not.toBe(persistentIncomingKey(incoming));
    expect(persistentIncomingKey(changedQuote)).not.toBe(persistentIncomingKey(incoming));
    expect(persistentIncomingKey(incoming).length).toBeLessThan(180);
  });

  it("uses the shared identity in durable follow-up duplicate validation", () => {
    const trigger = idlessIncoming();
    const attachmentVariant = structuredClone(trigger);
    attachmentVariant.attachments[0]!.id = "attachment-b";
    attachmentVariant.attachments[0]!.fileId = "file-b";
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: replyGate.conversationId,
      incoming: trigger,
      captureSequence: 1,
      followUps: [{ incoming: attachmentVariant, captureSequence: 2 }],
      replyGate,
      replyQuote
    }, {
      conversationId: replyGate.conversationId,
      correlationId: "idless:attachment-variant"
    });

    expect(decodeReplyDebounce(encoded).followUps).toHaveLength(1);
    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: {
        ...encoded.payload,
        followUps: [{ incoming: structuredClone(trigger), captureSequence: 2 }]
      }
    })).toThrow("followUps 包含重复消息");
  });

  it("accepts 64 distinct id-less follow-ups and rejects a 65th before decoding", () => {
    const trigger = idlessIncoming();
    const followUps = Array.from(
      { length: MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS },
      (_, index) => ({
        incoming: {
          ...structuredClone(trigger),
          attachments: [{
            ...trigger.attachments[0]!,
            id: `tail-attachment-${index}`,
            fileId: `tail-file-${index}`
          }]
        },
        captureSequence: index + 2
      })
    );
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: replyGate.conversationId,
      incoming: trigger,
      captureSequence: 1,
      followUps,
      replyGate,
      replyQuote
    }, {
      conversationId: replyGate.conversationId,
      correlationId: "idless:bounded-tail"
    });
    expect(decodeReplyDebounce(encoded).followUps).toHaveLength(64);
    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: {
        ...encoded.payload,
        followUps: [...followUps, {
          incoming: { ...structuredClone(trigger), text: "65th" },
          captureSequence: 66
        }]
      }
    })).toThrow("followUps 超过最大数量");
  });

  it("keeps exact redelivery deduped and attachment or quote variants distinct through SQLite", () => {
    const store = new SessionStore({ databasePath: ":memory:" });
    try {
      const original = idlessIncoming();
      const exact = structuredClone(original);
      const attachmentVariant = structuredClone(original);
      attachmentVariant.attachments[0]!.id = "sqlite-attachment-b";
      attachmentVariant.attachments[0]!.fileId = "sqlite-file-b";
      const quoteVariant = structuredClone(original);
      quoteVariant.quoteReferences[0]!.text = "sqlite quote B";
      const enqueue = (incoming: ParsedIncomingMessage) => {
        const identity = persistentIncomingKey(incoming);
        return store.enqueueEvent({
          sessionId: replyGate.conversationId,
          kind: "reply_debounce",
          dedupeKey: identity,
          payload: replyDebounceEnvelope({
            type: "reply_debounce",
            route: "direct",
            conversationId: replyGate.conversationId,
            incoming,
            captureSequence: 1,
            replyGate,
            replyQuote
          }, {
            conversationId: replyGate.conversationId,
            correlationId: identity,
            idempotencyKey: identity
          })
        });
      };

      const first = enqueue(original);
      const repeated = enqueue(exact);
      const attachment = enqueue(attachmentVariant);
      const quote = enqueue(quoteVariant);

      expect(repeated).toEqual({ event: first.event, inserted: false });
      expect(attachment.inserted).toBe(true);
      expect(quote.inserted).toBe(true);
      const decoded = store.listEvents(replyGate.conversationId)
        .map((event) => decodeReplyDebounce(event.payload).incoming);
      expect(decoded).toHaveLength(3);
      expect(decoded.map(inboundMessageIdentityV1)).toEqual([
        inboundMessageIdentityV1(original),
        inboundMessageIdentityV1(attachmentVariant),
        inboundMessageIdentityV1(quoteVariant)
      ]);
    } finally {
      store.close();
    }
  });
});

function idlessIncoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: "agent-a",
    accountId: "qq-secondary",
    scope: "user_group",
    time: "2026-07-17T02:00:00.000Z",
    userId: 5_001,
    groupId: 7_001,
    selfId: 9_001,
    sender: {
      id: "5001",
      nickname: "sender",
      card: "group-card",
      displayName: "Sender"
    },
    text: "same text",
    media: [{
      schemaVersion: 1,
      kind: "image",
      source: "remote_url",
      url: "https://example.test/a.png"
    }],
    attachments: [{
      id: "attachment-a",
      source: "message",
      name: "report.pdf",
      fileId: "file-a",
      sizeBytes: 1_024,
      busId: 7,
      groupId: 7_001,
      userId: 5_001,
      status: "pending",
      mimeType: "application/pdf",
      format: "pdf",
      sha256: "a".repeat(64),
      url: "https://temporary.test/download-token-1",
      cacheKey: "local-cache-1",
      textPreview: "parsed preview",
      chunkIndexPath: "/private/cache/chunks-1.sqlite"
    }],
    replyMessageIds: [9_911],
    quoteReferences: [{
      messageId: 9_911,
      text: "quoted text",
      senderName: "quoted sender",
      media: [{
        schemaVersion: 1,
        kind: "image",
        source: "remote_url",
        url: "https://example.test/quote.png"
      }],
      imageUrls: ["https://example.test/quote.png"],
      attachments: [{
        id: "quote-attachment",
        source: "quote",
        name: "quote.txt",
        fileId: "quote-file",
        status: "pending"
      }]
    }],
    mentionedSelf: true
  };
}
