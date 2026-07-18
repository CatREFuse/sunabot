// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decodeReplyDebounce,
  decodeToolCompletion,
  replyDebounceEnvelope,
  toolCompletionEnvelope
} from "../../packages/contracts/session/runtimeMessages.js";
import {
  parseUserGroupOrchestratorDecision,
  serializeUserGroupOrchestratorResult,
  userGroupOrchestratorResult
} from "../../services/orchestration/userGroupOrchestratorResult.js";

describe("user-group orchestrator result", () => {
  it("accepts an affirmative decision only when its reply target is in the candidate batch", () => {
    const decision = parseUserGroupOrchestratorDecision(JSON.stringify({
      should_reply: true,
      reason: "群友正在追问普拉娜负责的任务。",
      reply_to_message_id: "message-2"
    }), ["message-1", "message-2"]);

    expect(decision).toEqual({
      shouldReply: true,
      reason: "群友正在追问普拉娜负责的任务。",
      replyToMessageId: "message-2"
    });
    expect(userGroupOrchestratorResult(decision!)).toEqual({
      schemaVersion: 1,
      reason: "群友正在追问普拉娜负责的任务。",
      replyToMessageId: "message-2"
    });
  });

  it("rejects a positive decision with a missing or out-of-batch reply target", () => {
    expect(parseUserGroupOrchestratorDecision(JSON.stringify({
      should_reply: true,
      reason: "需要回复。",
      reply_to_message_id: "unknown-message"
    }), ["message-1"])).toBeNull();
    expect(parseUserGroupOrchestratorDecision(JSON.stringify({
      should_reply: true,
      reason: "需要回复。"
    }), ["message-1"])).toBeNull();
  });

  it("accepts a negative decision only with an explicit null reply target", () => {
    expect(parseUserGroupOrchestratorDecision(JSON.stringify({
      should_reply: false,
      reason: "当前只是群友闲聊。",
      reply_to_message_id: null
    }), ["message-1"])).toEqual({
      shouldReply: false,
      reason: "当前只是群友闲聊。",
      replyToMessageId: null
    });
  });

  it.each([
    ["missing reply target", { should_reply: false, reason: "skip" }],
    ["non-null negative target", {
      should_reply: false,
      reason: "skip",
      reply_to_message_id: "message-2"
    }],
    ["extra field", {
      should_reply: false,
      reason: "skip",
      reply_to_message_id: null,
      debug: true
    }],
    ["string boolean", {
      should_reply: "false",
      reason: "skip",
      reply_to_message_id: null
    }],
    ["non-string reason", {
      should_reply: false,
      reason: 1,
      reply_to_message_id: null
    }],
    ["numeric positive target", {
      should_reply: true,
      reason: "reply",
      reply_to_message_id: 2
    }],
    ["positive target with surrounding whitespace", {
      should_reply: true,
      reason: "reply",
      reply_to_message_id: " message-2 "
    }]
  ])("rejects %s", (_label, payload) => {
    expect(parseUserGroupOrchestratorDecision(JSON.stringify(payload), ["2", "message-2"]))
      .toBeNull();
  });

  it("rejects non-JSON wrappers and keeps absent results empty", () => {
    expect(parseUserGroupOrchestratorDecision(
      '```json\n{"should_reply":false,"reason":"skip","reply_to_message_id":null}\n```',
      ["message-1"]
    )).toBeNull();
    expect(serializeUserGroupOrchestratorResult(undefined)).toBe("");
  });

  it("preserves the result through ambient debounce and deferred callback contracts", () => {
    const incoming = groupIncoming();
    const conversationId = "group:3003";
    const result = {
      schemaVersion: 1 as const,
      reason: "群友正在等待普拉娜回应。",
      replyToMessageId: "1001"
    };
    const debounce = replyDebounceEnvelope({
      type: "reply_debounce",
      route: "ambient",
      conversationId,
      incoming,
      captureSequence: 1,
      replyGate: {
        generation: "orchestrator-result-test",
        scope: "user_group",
        conversationId,
        scopeEpoch: 0,
        conversationEpoch: 0
      },
      replyQuote: { enabled: true, replyToMessageId: 1001 },
      orchestratorResult: result
    }, {
      conversationId,
      correlationId: "orchestrator-result-test"
    });
    expect(decodeReplyDebounce(debounce).orchestratorResult).toEqual(result);
    expect(() => decodeReplyDebounce({
      ...debounce,
      payload: { ...debounce.payload, route: "direct" }
    })).toThrow("orchestratorResult 无效");

    const completion = toolCompletionEnvelope({
      type: "tool_result",
      toolJobId: "job-1",
      providerCallId: "call-1",
      toolName: "codex",
      originalRequest: { incoming, orchestratorResult: result },
      arguments: {},
      outcome: { status: "succeeded", result: {}, error: null }
    }, {
      conversationId,
      correlationId: "orchestrator-result-completion"
    });
    expect(decodeToolCompletion(completion).originalRequest.orchestratorResult).toEqual(result);
  });
});

function groupIncoming() {
  return {
    schemaVersion: 1 as const,
    scope: "user_group" as const,
    messageId: 1001,
    time: "2026-07-18T12:00:00.000Z",
    userId: 2002,
    groupId: 3003,
    selfId: 4004,
    sender: { id: "2002", displayName: "群友" },
    text: "普拉娜，这个进展怎么样？",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}
