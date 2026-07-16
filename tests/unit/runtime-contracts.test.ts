// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  toolCompletionEnvelope,
  type GroupThreadContextSnapshotV1,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";

const THREAD_ID = "thread:33333333333333333333333333333333";

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

const threadContext = {
  schemaVersion: 1,
  revision: 7,
  processedThroughSequence: 19,
  activeThreadId: THREAD_ID,
  omittedThreadCount: 2,
  threads: [{
    threadId: THREAD_ID,
    topic: "群成员正在确认杭州明天是否下雨，以决定是否晾晒被子。",
    status: "active",
    participantUids: ["10001", "10002"],
    omittedParticipantCount: 3,
    messageIds: ["41", "42"],
    omittedMessageCount: 4
  }],
  messageAssignments: [{
    messageId: "42",
    sequence: 19,
    primaryThreadId: THREAD_ID,
    relatedThreadIds: [],
    relation: "reply",
    confidence: 0.98
  }]
} satisfies GroupThreadContextSnapshotV1;

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

  it("keeps assistant message provenance in durable outbox envelopes", () => {
    const encoded = assistantReplyEnvelope({
      type: "assistant_reply",
      incoming: payload.incoming,
      text: "生成完成。",
      generatedImages: [],
      isAdmin: true,
      logRunId: "run-1",
      messageOrigin: "async_tool_callback",
      toolNames: ["codex", "websearch"]
    }, {
      conversationId: "private:10001",
      correlationId: "run-1"
    });

    expect(decodeAssistantReply(encoded)).toMatchObject({
      text: "生成完成。",
      logRunId: "run-1",
      messageOrigin: "async_tool_callback",
      toolNames: ["codex", "websearch"]
    });
  });

  it("round-trips a valid thread snapshot through assistant and tool-completion envelopes", () => {
    const assistant = assistantReplyEnvelope({
      type: "assistant_reply",
      incoming: payload.incoming,
      text: "继续讨论这个话题。",
      generatedImages: [],
      isAdmin: false,
      threadContext
    }, {
      conversationId: "group:300",
      correlationId: "reply:42"
    });
    expect(decodeAssistantReply(assistant).threadContext).toEqual(threadContext);

    const completion = toolCompletionEnvelope({
      type: "tool_result",
      toolJobId: "job-1",
      providerCallId: "call-1",
      toolName: "codex",
      originalRequest: {
        incoming: payload.incoming,
        captureSequence: 19,
        threadContext
      },
      arguments: { task: "inspect" },
      outcome: { status: "succeeded", result: { text: "done" }, error: null }
    }, {
      conversationId: "group:300",
      correlationId: "call-1"
    });
    expect(decodeToolCompletion(completion).originalRequest).toMatchObject({
      captureSequence: 19,
      threadContext
    });
  });

  it("keeps legacy assistant and tool-completion payloads without a thread snapshot readable", () => {
    const assistant = decodeAssistantReply({
      type: "assistant_reply",
      incoming: payload.incoming,
      text: "legacy reply",
      generatedImages: [],
      isAdmin: false
    });
    expect(assistant.text).toBe("legacy reply");
    expect(assistant.threadContext).toBeUndefined();

    const completion = decodeToolCompletion({
      type: "tool_result",
      toolJobId: "legacy-job",
      providerCallId: "legacy-call",
      toolName: "codex",
      originalRequest: {
        incoming: payload.incoming,
        captureSequence: 5
      },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    });
    expect(completion.originalRequest.captureSequence).toBe(5);
    expect(completion.originalRequest.threadContext).toBeUndefined();
  });

  it("drops an invalid thread snapshot without rejecting the durable payload", () => {
    const invalidThreadContext = {
      ...threadContext,
      messageAssignments: [{
        ...threadContext.messageAssignments[0],
        confidence: 1.1
      }]
    };
    const assistant = decodeAssistantReply({
      type: "assistant_reply",
      incoming: payload.incoming,
      text: "still readable",
      generatedImages: [],
      isAdmin: false,
      threadContext: invalidThreadContext
    });
    expect(assistant.text).toBe("still readable");
    expect(assistant.threadContext).toBeUndefined();

    const completion = decodeToolCompletion({
      type: "tool_result",
      toolJobId: "job-invalid",
      providerCallId: "call-invalid",
      toolName: "codex",
      originalRequest: {
        incoming: payload.incoming,
        captureSequence: 19,
        threadContext: invalidThreadContext
      },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    });
    expect(completion.originalRequest.captureSequence).toBe(19);
    expect(completion.originalRequest.threadContext).toBeUndefined();
  });

  it("drops a Thread snapshot that exceeds prompt-facing bounds", () => {
    const oversizedThreadContext = {
      ...threadContext,
      threads: Array.from({ length: 73 }, (_, index) => ({
        ...threadContext.threads[0],
        threadId: `thread-${index}`
      }))
    };

    const assistant = decodeAssistantReply({
      type: "assistant_reply",
      incoming: payload.incoming,
      text: "still readable",
      generatedImages: [],
      isAdmin: false,
      threadContext: oversizedThreadContext
    });

    expect(assistant.text).toBe("still readable");
    expect(assistant.threadContext).toBeUndefined();
  });

  it("drops snapshots with invalid references, relation fanout, or zero sequence", () => {
    const ghostThreadId = "thread:99999999999999999999999999999999";
    const invalidSnapshots = [
      { ...threadContext, activeThreadId: ghostThreadId },
      {
        ...threadContext,
        messageAssignments: [{
          ...threadContext.messageAssignments[0],
          relatedThreadIds: [ghostThreadId, ghostThreadId, ghostThreadId]
        }]
      },
      {
        ...threadContext,
        messageAssignments: [{ ...threadContext.messageAssignments[0], sequence: 0 }]
      }
    ];

    for (const invalidThreadContext of invalidSnapshots) {
      expect(decodeAssistantReply({
        type: "assistant_reply",
        incoming: payload.incoming,
        text: "still readable",
        generatedImages: [],
        isAdmin: false,
        threadContext: invalidThreadContext
      }).threadContext).toBeUndefined();
    }
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
