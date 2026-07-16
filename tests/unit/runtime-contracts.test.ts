// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_INVOCATION_ARGS_CHARACTERS,
  MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS
} from "../../packages/contracts/messaging/commands.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeReplyDebounce,
  decodeToolCompletion,
  incomingReplyEnvelope,
  MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS,
  replyDebounceEnvelope,
  toolCompletionEnvelope,
  type GroupThreadContextSnapshotV1,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";

const THREAD_ID = "thread:33333333333333333333333333333333";
const replyGate = {
  generation: "runtime-generation",
  scope: "private" as const,
  conversationId: "private:10001",
  scopeEpoch: 0,
  conversationEpoch: 0
};
const replyQuote = {
  enabled: true,
  replyToMessageId: 42
};
const commandIncoming = {
  schemaVersion: 1 as const,
  scope: "private" as const,
  messageId: 42,
  time: "2026-07-11T12:00:00.000Z",
  userId: 10001,
  sender: { id: "10001", displayName: "tester" },
  text: "/总结群聊@Plana 最近三小时",
  media: [],
  attachments: [],
  replyMessageIds: [],
  quoteReferences: [],
  mentionedSelf: false
};
const commandInvocation = {
  id: "group-summary",
  invokedName: "总结群聊",
  args: "最近三小时",
  rawText: commandIncoming.text
};

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
  captureSequence: 1,
  replyGate,
  replyQuote
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

  it("freezes the first trigger in a versioned reply debounce envelope", () => {
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      preparationKey: "primary:private:10001:42",
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42",
      idempotencyKey: "reply-debounce:42"
    });

    expect(encoded).toMatchObject({ schemaVersion: 1, type: "runtime.reply_debounce" });
    expect(decodeReplyDebounce(encoded)).toEqual(encoded.payload);
  });

  it("round-trips one frozen command invocation through debounce and handoff", () => {
    const debounce = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "command",
      conversationId: "private:10001",
      incoming: commandIncoming,
      captureSequence: 1,
      replyGate,
      replyQuote,
      commandInvocation
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    const handoff = incomingReplyEnvelope({
      type: "incoming_reply",
      route: "command",
      incoming: commandIncoming,
      captureSequence: 1,
      contextThroughSequence: 1,
      replyGate,
      replyQuote,
      commandInvocation
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(decodeReplyDebounce(debounce).commandInvocation).toEqual(commandInvocation);
    expect(decodeIncomingReply(handoff).commandInvocation).toEqual(commandInvocation);
  });

  it("rejects missing, misplaced, mismatched, or unbounded frozen command data", () => {
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "command",
      conversationId: "private:10001",
      incoming: commandIncoming,
      captureSequence: 1,
      replyGate,
      replyQuote,
      commandInvocation
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    const rejects = (patch: Record<string, unknown>, incomingText = commandIncoming.text) => {
      expect(() => decodeReplyDebounce({
        ...encoded,
        payload: {
          ...encoded.payload,
          ...patch,
          incoming: { ...commandIncoming, text: incomingText }
        }
      })).toThrow("持久化消息字段 commandInvocation 无效");
    };

    rejects({ commandInvocation: undefined });
    rejects({ route: "direct" });
    rejects({ commandInvocation: { ...commandInvocation, rawText: "/总结群聊 另一条命令" } });
    rejects({
      commandInvocation: {
        ...commandInvocation,
        args: "a".repeat(MAX_COMMAND_INVOCATION_ARGS_CHARACTERS + 1)
      }
    });
    const overlongRawText = "a".repeat(MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS + 1);
    rejects({
      commandInvocation: { ...commandInvocation, rawText: overlongRawText }
    }, overlongRawText);
    rejects({
      commandInvocation: { ...commandInvocation, definition: { handler: "forged" } }
    });

    const handoff = incomingReplyEnvelope({
      type: "incoming_reply",
      route: "command",
      incoming: commandIncoming,
      captureSequence: 1,
      contextThroughSequence: 1,
      replyGate,
      replyQuote,
      commandInvocation
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    expect(() => decodeIncomingReply({
      ...handoff,
      payload: { ...handoff.payload, commandInvocation: undefined }
    })).toThrow("持久化消息字段 commandInvocation 无效");
  });

  it("round-trips a frozen reply quote through debounce, handoff, and tool completion", () => {
    const debounce = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    expect(decodeReplyDebounce(debounce).replyQuote).toEqual(replyQuote);

    const incoming = incomingReplyEnvelope({
      ...payload,
      contextThroughSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    expect(decodeIncomingReply(incoming).replyQuote).toEqual(replyQuote);

    const completion = toolCompletionEnvelope({
      type: "tool_result",
      toolJobId: "job-quote",
      providerCallId: "call-quote",
      toolName: "codex",
      originalRequest: { incoming: payload.incoming, replyQuote },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    }, {
      conversationId: "private:10001",
      correlationId: "call-quote"
    });
    expect(decodeToolCompletion(completion).originalRequest.replyQuote).toEqual(replyQuote);
  });

  it("rejects malformed or internally inconsistent frozen reply quotes", () => {
    const debounce = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    for (const invalid of [
      { enabled: true, replyToMessageId: null },
      { enabled: false, replyToMessageId: 42 },
      { enabled: true, replyToMessageId: 0 },
      { enabled: "yes", replyToMessageId: 42 },
      { enabled: false }
    ]) {
      expect(() => decodeReplyDebounce({
        ...debounce,
        payload: { ...debounce.payload, replyQuote: invalid }
      })).toThrow("持久化消息字段 replyQuote 无效");
    }
  });

  it("rejects an invalid debounce preparation key", () => {
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: { ...encoded.payload, preparationKey: 42 }
    })).toThrow("持久化消息字段 preparationKey 无效");
  });

  it("decodes strictly ordered unique durable debounce follow-ups", () => {
    const followUp = {
      ...payload.incoming,
      messageId: 43,
      text: "follow-up"
    };
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      followUps: [{ incoming: followUp, captureSequence: 2 }],
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(decodeReplyDebounce(encoded).followUps).toEqual([
      { incoming: followUp, captureSequence: 2 }
    ]);
    expect(decodeIncomingReply(incomingReplyEnvelope({
      ...payload,
      followUps: [{ incoming: followUp, captureSequence: 2 }],
      contextThroughSequence: 2,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    })).followUps).toEqual([{ incoming: followUp, captureSequence: 2 }]);
  });

  it("accepts exactly the durable debounce follow-up snapshot limit", () => {
    const followUps = Array.from(
      { length: MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS },
      (_, index) => ({
        incoming: {
          ...payload.incoming,
          messageId: 43 + index,
          text: `follow-up-${index + 1}`
        },
        captureSequence: 2 + index
      })
    );
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      followUps,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(decodeReplyDebounce(encoded).followUps).toEqual(followUps);
  });

  it("rejects 65 durable debounce follow-up snapshots before decoding entries", () => {
    const followUps = Array.from(
      { length: MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS + 1 },
      (_, index) => ({
        incoming: {
          ...payload.incoming,
          messageId: 43 + index,
          text: `follow-up-${index + 1}`
        },
        captureSequence: 2 + index
      })
    );
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      followUps,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(() => decodeReplyDebounce(encoded)).toThrow("followUps 超过最大数量");
  });

  it("continues rejecting malformed durable debounce follow-up snapshots", () => {
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: { ...encoded.payload, followUps: [null] }
    })).toThrow("followUps[0] 无效");
  });

  it("rejects duplicate or out-of-order durable debounce follow-ups", () => {
    const followUp = { ...payload.incoming, messageId: 43, text: "follow-up" };
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });

    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: {
        ...encoded.payload,
        followUps: [
          { incoming: followUp, captureSequence: 3 },
          { incoming: { ...followUp, messageId: 44 }, captureSequence: 2 }
        ]
      }
    })).toThrow("followUps.captureSequence 必须严格递增");
    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: {
        ...encoded.payload,
        followUps: [
          { incoming: followUp, captureSequence: 2 },
          { incoming: followUp, captureSequence: 3 }
        ]
      }
    })).toThrow("followUps 包含重复消息");
    expect(() => decodeReplyDebounce({
      ...encoded,
      payload: {
        ...encoded.payload,
        followUps: [{ incoming: payload.incoming, captureSequence: 2 }]
      }
    })).toThrow("followUps 包含重复消息");
  });

  it("requires valid frozen gate and quote provenance for a handed-off reply", () => {
    const encoded = incomingReplyEnvelope({
      ...payload,
      contextThroughSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, route: "invalid" }
    })).toThrow("持久化消息字段 route 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, replyGate: "invalid" }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, replyGate: undefined }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, replyGate: {} }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, replyQuote: undefined }
    })).toThrow("持久化消息字段 replyQuote 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: { ...encoded.payload, replyQuote: {} }
    })).toThrow("持久化消息字段 replyQuote 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: {
        ...encoded.payload,
        contextThroughSequence: undefined,
        replyGate: undefined
      }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: {
        ...encoded.payload,
        contextThroughSequence: undefined,
        replyQuote: undefined
      }
    })).toThrow("持久化消息字段 replyQuote 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: {
        ...encoded.payload,
        replyGate: { ...replyGate, conversationId: "private:other" }
      }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeIncomingReply({
      ...encoded,
      payload: {
        ...encoded.payload,
        replyQuote: { enabled: true, replyToMessageId: 43 }
      }
    })).toThrow("持久化消息字段 replyQuote 无效");
  });

  it("requires gate and quote snapshots on every new debounce payload", () => {
    const encoded = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "direct",
      conversationId: "private:10001",
      incoming: payload.incoming,
      captureSequence: 1,
      replyGate,
      replyQuote
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    for (const [field, expected] of [
      ["replyGate", "持久化消息字段 replyGate 无效"],
      ["replyQuote", "持久化消息字段 replyQuote 无效"]
    ] as const) {
      expect(() => decodeReplyDebounce({
        ...encoded,
        payload: { ...encoded.payload, [field]: undefined }
      })).toThrow(expected);
      expect(() => decodeReplyDebounce({
        ...encoded,
        payload: { ...encoded.payload, [field]: {} }
      })).toThrow(expected);
    }

    const idlessIncoming = { ...payload.incoming, messageId: undefined };
    const idless = replyDebounceEnvelope({
      ...encoded.payload,
      conversationId: "private:10001",
      incoming: idlessIncoming,
      replyQuote: { enabled: false, replyToMessageId: null }
    }, {
      conversationId: "private:10001",
      correlationId: "idless"
    });
    expect(() => decodeReplyDebounce({
      ...idless,
      payload: {
        ...idless.payload,
        replyQuote: { enabled: true, replyToMessageId: 42 }
      }
    })).toThrow("持久化消息字段 replyQuote 无效");
  });

  it("rejects invalid or reversed reply context sequence bounds", () => {
    const incomingEnvelope = incomingReplyEnvelope({
      ...payload,
      captureSequence: 5,
      contextThroughSequence: 4
    }, {
      conversationId: "private:10001",
      correlationId: "onebot:42"
    });
    expect(() => decodeIncomingReply(incomingEnvelope)).toThrow(
      "contextThroughSequence 不能早于 captureSequence"
    );

    const completion = toolCompletionEnvelope({
      type: "tool_result",
      toolJobId: "job-invalid-sequence",
      providerCallId: "call-invalid-sequence",
      toolName: "codex",
      originalRequest: {
        incoming: payload.incoming,
        captureSequence: 5,
        contextThroughSequence: 4
      },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    }, {
      conversationId: "private:10001",
      correlationId: "call-invalid-sequence"
    });
    expect(() => decodeToolCompletion(completion)).toThrow(
      "contextThroughSequence 不能早于 captureSequence"
    );
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
        contextThroughSequence: 23,
        replyGate,
        replyQuote,
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
      contextThroughSequence: 23,
      threadContext
    });
  });

  it("keeps payloads without a frozen boundary or thread snapshot readable", () => {
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
        incoming: payload.incoming
      },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    });
    expect(completion.originalRequest.captureSequence).toBeUndefined();
    expect(completion.originalRequest.threadContext).toBeUndefined();
  });

  it("rejects a deferred callback boundary without frozen gate and quote snapshots", () => {
    const encoded = toolCompletionEnvelope({
      type: "tool_result",
      toolJobId: "job-frozen-boundary",
      providerCallId: "call-frozen-boundary",
      toolName: "codex",
      originalRequest: {
        incoming: payload.incoming,
        captureSequence: 1,
        contextThroughSequence: 1,
        replyGate,
        replyQuote
      },
      arguments: {},
      outcome: { status: "succeeded", result: null, error: null }
    }, {
      conversationId: "private:10001",
      correlationId: "call-frozen-boundary"
    });
    expect(() => decodeToolCompletion({
      ...encoded,
      payload: {
        ...encoded.payload,
        originalRequest: { ...encoded.payload.originalRequest, replyGate: undefined }
      }
    })).toThrow("持久化消息字段 replyGate 无效");
    expect(() => decodeToolCompletion({
      ...encoded,
      payload: {
        ...encoded.payload,
        originalRequest: { ...encoded.payload.originalRequest, replyQuote: undefined }
      }
    })).toThrow("持久化消息字段 replyQuote 无效");
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
        replyGate,
        replyQuote,
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
