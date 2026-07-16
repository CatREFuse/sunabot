// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyGroupThreadContext,
  createDeterministicGroupThreadId,
  createEmptyGroupThreadState,
  isShortSentenceTopic,
  parseGroupThreadModelOutput,
  planGroupThreadContext,
  retainGroupThreadStateMessageIndex,
  type GroupThreadMessageRecord,
  type GroupThreadStateV1
} from "../../services/conversations/groupThreadContext.js";

describe("group thread context", () => {
  it("keeps the complete message array unchanged while adding a deterministic sidecar index", () => {
    const messages = [
      message("101", 1, "2218471571", "杭州明天会下雨吗"),
      message("102", 2, "171419991", "下雨的话就不晒被子了")
    ] as const;
    const before = structuredClone(messages);
    const result = applyGroupThreadContext({
      conversationId: "agent:plana:group:7788",
      messages,
      modelOutput: modelOutput({
        threads: [thread("weather", "群成员正在确认杭州明天是否下雨，以决定是否晾晒被子。")],
        assignments: [
          assignment("101", "weather", "new", 0.98),
          assignment("102", "weather", "continue", 0.95)
        ],
        active: "weather"
      })
    });

    expect(result.changed).toBe(true);
    expect(result.passthroughMessages).toBe(messages);
    expect(messages).toEqual(before);
    const expectedThreadId = createDeterministicGroupThreadId({
      conversationId: "agent:plana:group:7788",
      anchorMessageId: "101",
      anchorSequence: 1
    });
    expect(result.state).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      processedThroughSequence: 2,
      activeThreadId: expectedThreadId
    });
    expect(result.state.threads).toEqual([expect.objectContaining({
      threadId: expectedThreadId,
      topic: "群成员正在确认杭州明天是否下雨，以决定是否晾晒被子。",
      status: "active",
      participantUids: ["2218471571", "171419991"],
      messageIds: ["101", "102"],
      anchorMessageId: "101",
      lastSequence: 2
    })]);
    expect(result.snapshot.messageAssignments.map((item) => item.messageId)).toEqual(["101", "102"]);
  });

  it("uses the model-selected active thread even when the last message belongs to another thread", () => {
    const conversationId = "agent:plana:group:active-selection";
    const result = applyGroupThreadContext({
      conversationId,
      messages: [
        message("101", 1, "10001", "继续确认明天杭州会不会下雨"),
        message("102", 2, "10002", "顺便问一下衣服尺寸怎么改")
      ],
      modelOutput: modelOutput({
        threads: [
          thread("weather", "群成员正在确认杭州明天是否下雨，以安排出行。"),
          thread("clothes", "群成员正在询问委托服装的尺寸应该如何修改。")
        ],
        assignments: [
          assignment("101", "weather", "continue", 0.95),
          assignment("102", "clothes", "switch", 0.82)
        ],
        active: "weather"
      })
    });

    expect(result.error).toBeUndefined();
    expect(result.state.activeThreadId).toBe(createDeterministicGroupThreadId({
      conversationId,
      anchorMessageId: "101",
      anchorSequence: 1
    }));
    expect(result.state.activeThreadId).not.toBe(result.state.assignments.at(-1)?.primaryThreadId);
  });

  it("inherits an existing thread from an explicit reply without calling a model", () => {
    const previous = existingState({ status: "dormant" });
    const messages = [
      message("100", 1, "10001", "此前的天气讨论"),
      { ...message("101", 2, "10002", "那明天再晒吧"), replyMessageIds: [100] }
    ];
    const plan = planGroupThreadContext({ messages, previousState: previous });

    expect(plan.needsModel).toBe(false);
    expect(plan.ruleAssignments).toEqual([expect.objectContaining({
      messageId: "101",
      primaryThreadId: previous.threads[0]!.threadId,
      relation: "reply",
      confidence: 1
    })]);

    const result = applyGroupThreadContext({
      conversationId: "group:1",
      messages,
      previousState: previous
    });
    expect(result.error).toBeUndefined();
    expect(result.state.revision).toBe(2);
    expect(result.state.activeThreadId).toBe(previous.threads[0]!.threadId);
    expect(result.state.threads[0]).toMatchObject({ status: "active", messageIds: ["100", "101"] });
    expect(result.state.assignments.at(-1)).toMatchObject({ relation: "reply", confidence: 1 });
  });

  it("classifies only the root message and inherits its thread through an in-batch reply", () => {
    const messages = [
      message("200", 1, "10001", "我明天想把被子拿上楼晒"),
      { ...message("201", 2, "10002", "明天预报下雨"), replyMessageIds: [200] }
    ];
    const result = applyGroupThreadContext({
      conversationId: "group:2",
      messages,
      modelOutput: modelOutput({
        threads: [thread("drying", "群成员正在商量明天是否把被子拿到楼顶晾晒。")],
        assignments: [assignment("200", "drying", "new", 0.9)],
        active: "drying"
      })
    });

    expect(result.error).toBeUndefined();
    expect(result.state.threads).toHaveLength(1);
    expect(result.state.assignments[1]).toMatchObject({
      primaryThreadId: result.state.assignments[0]!.primaryThreadId,
      relation: "reply",
      confidence: 1
    });
    expect(result.state.activeThreadId).toBe(result.state.assignments[0]!.primaryThreadId);
    const plan = planGroupThreadContext({ messages });
    expect(plan.unresolvedMessageIds).toEqual(["200"]);
    expect(plan.deferredReplyMessageIds).toEqual(["201"]);
  });

  it("represents replies to multiple known topics as a bridge", () => {
    const first = existingState();
    const secondThreadId = createDeterministicGroupThreadId({
      conversationId: "seed",
      anchorMessageId: "110",
      anchorSequence: 2
    });
    const previous: GroupThreadStateV1 = {
      ...first,
      processedThroughSequence: 2,
      threads: [
        ...first.threads,
        {
          threadId: secondThreadId,
          topic: "群成员正在讨论委托服装的尺寸和修改方案。",
          status: "active",
          participantUids: ["10002"],
          messageIds: ["110"],
          anchorMessageId: "110",
          lastSequence: 2
        }
      ],
      assignments: [
        ...first.assignments,
        {
          messageId: "110",
          sequence: 2,
          primaryThreadId: secondThreadId,
          relatedThreadIds: [],
          relation: "new",
          confidence: 1
        }
      ]
    };
    const messages = [
      message("100", 1, "10001", "此前的天气讨论"),
      message("110", 2, "10002", "此前的服装讨论"),
      { ...message("120", 3, "10003", "两个安排会不会撞时间"), replyMessageIds: [100, 110] }
    ];
    const result = applyGroupThreadContext({ conversationId: "group:3", messages, previousState: previous });

    expect(result.state.assignments.at(-1)).toEqual({
      messageId: "120",
      sequence: 3,
      primaryThreadId: first.threads[0]!.threadId,
      relatedThreadIds: [secondThreadId],
      relation: "bridge",
      confidence: 1
    });
  });

  it("requires topic descriptions to be short sentences", () => {
    expect(isShortSentenceTopic("杭州天气")).toBe(false);
    expect(isShortSentenceTopic("群成员正在确认杭州明天是否下雨。")).toBe(true);
    expect(isShortSentenceTopic("今晚吃麦当劳还是肯德基？")).toBe(true);
    expect(isShortSentenceTopic("杭州明天有雨，大家带伞。")).toBe(true);
    const parsed = parseGroupThreadModelOutput(modelOutput({
      threads: [thread("weather", "杭州天气")],
      assignments: [assignment("1", "weather", "new", 0.9)]
    }), { messages: [message("1", 1, "10001", "天气如何")] });
    expect(parsed).toMatchObject({ ok: false, error: { code: "model_output_invalid" } });
  });

  it("bounds the durable message index to retained raw messages without dropping thread summaries", () => {
    const previous = existingState();
    const retained = retainGroupThreadStateMessageIndex(previous, new Set());

    expect(retained.threads).toHaveLength(previous.threads.length);
    expect(retained.threads[0]).toMatchObject({
      threadId: previous.threads[0]?.threadId,
      topic: previous.threads[0]?.topic,
      messageIds: []
    });
    expect(retained.assignments).toEqual([]);
    expect(previous.threads[0]?.messageIds).toEqual(["100"]);
    expect(previous.assignments).toHaveLength(1);
  });

  it("strictly rejects unknown messages, unknown threads, and non-numeric confidence", () => {
    const messages = [message("1", 1, "10001", "天气如何")];
    const unknownMessage = parseGroupThreadModelOutput(modelOutput({
      threads: [thread("weather", "群成员正在询问杭州明天的天气情况。")],
      assignments: [assignment("2", "weather", "new", 0.9)]
    }), { messages });
    expect(unknownMessage.ok).toBe(false);

    const unknownThread = parseGroupThreadModelOutput(modelOutput({
      assignments: [assignment("1", "missing", "continue", 0.9)]
    }), { messages });
    expect(unknownThread.ok).toBe(false);

    const wrongType = modelOutput({
      threads: [thread("weather", "群成员正在询问杭州明天的天气情况。")],
      assignments: [assignment("1", "weather", "new", 0.9)]
    }) as Record<string, unknown>;
    (wrongType.message_assignments as Array<Record<string, unknown>>)[0]!.confidence = "0.9";
    expect(parseGroupThreadModelOutput(wrongType, { messages }).ok).toBe(false);
  });

  it("rejects assignments for context-only messages outside the target set", () => {
    const messages = [
      message("1", 1, "10001", "杭州今天会下雨吗"),
      message("2", 2, "10002", "那晚上还下雨吗")
    ];
    const parsed = parseGroupThreadModelOutput(modelOutput({
      threads: [thread("weather", "群成员正在继续确认杭州天气和晚间降雨情况。")],
      assignments: [
        assignment("1", "weather", "continue", 0.9),
        assignment("2", "weather", "continue", 0.9)
      ]
    }), { messages, requiredMessageIds: ["2"] });

    expect(parsed.ok).toBe(false);
  });

  it("returns the exact previous state and message array when model output fails", () => {
    const previous = createEmptyGroupThreadState();
    const messages = [message("1", 1, "10001", "天气如何")];
    const result = applyGroupThreadContext({
      conversationId: "group:4",
      messages,
      previousState: previous,
      modelOutput: "not-json"
    });

    expect(result.changed).toBe(false);
    expect(result.error?.code).toBe("model_output_invalid");
    expect(result.state).toBe(previous);
    expect(result.passthroughMessages).toBe(messages);
  });

  it("only asks the model to classify messages after the persisted cursor", () => {
    const previous = existingState();
    const messages = [
      message("100", 1, "10001", "此前的天气讨论"),
      message("101", 2, "10002", "换个话题，衣服怎么改")
    ];
    const plan = planGroupThreadContext({ messages, previousState: previous });
    expect(plan.newMessages.map((item) => item.id)).toEqual(["101"]);
    expect(plan.unresolvedMessageIds).toEqual(["101"]);

    const result = applyGroupThreadContext({
      conversationId: "group:5",
      messages,
      previousState: previous,
      modelOutput: modelOutput({
        threads: [thread("clothes", "群成员正在讨论委托服装的尺寸和修改方案。")],
        assignments: [assignment("101", "clothes", "new", 0.92)]
      })
    });
    expect(result.state.assignments.map((item) => item.messageId)).toEqual(["100", "101"]);
    expect(result.state.processedThroughSequence).toBe(2);
  });

  it("supports active, dormant, and closed status updates without rewriting assignments", () => {
    const previous = existingState();
    const existingThreadId = previous.threads[0]!.threadId;
    const messages = [
      message("100", 1, "10001", "此前的天气讨论"),
      message("101", 2, "10002", "现在聊委托服装怎么修改")
    ];
    const result = applyGroupThreadContext({
      conversationId: "group:6",
      messages,
      previousState: previous,
      modelOutput: modelOutput({
        threads: [
          thread("old-weather", "群成员已经结束对杭州天气和晾晒安排的讨论。", "closed", existingThreadId),
          thread("clothes", "群成员正在讨论委托服装的尺寸和修改方案。")
        ],
        assignments: [assignment("101", "clothes", "switch", 0.96)],
        active: "clothes"
      })
    });

    expect(result.state.threads.find((item) => item.threadId === existingThreadId)?.status).toBe("closed");
    expect(result.state.threads.find((item) => item.threadId !== existingThreadId)?.status).toBe("active");
    expect(result.state.assignments[0]).toEqual(previous.assignments[0]);
  });

  it("keeps the model-selected active thread in active status", () => {
    const previous = existingState();
    const existingThreadId = previous.threads[0]!.threadId;
    const result = applyGroupThreadContext({
      conversationId: "group:active-status",
      messages: [
        message("100", 1, "10001", "此前的天气讨论"),
        message("101", 2, "10002", "现在聊委托服装怎么修改")
      ],
      previousState: previous,
      modelOutput: modelOutput({
        threads: [
          thread("old-weather", "群成员仍在关注杭州天气和出行安排。", "closed", existingThreadId),
          thread("clothes", "群成员正在讨论委托服装的尺寸和修改方案。")
        ],
        assignments: [assignment("101", "clothes", "switch", 0.96)],
        active: "old-weather"
      })
    });

    expect(result.error).toBeUndefined();
    expect(result.state.activeThreadId).toBe(existingThreadId);
    expect(result.state.threads.find((item) => item.threadId === existingThreadId)?.status).toBe("active");
  });

  it("fails safely instead of sorting invalid message sequences", () => {
    const previous = createEmptyGroupThreadState();
    const messages = [
      message("2", 2, "10002", "第二条"),
      message("1", 1, "10001", "第一条")
    ];
    const result = applyGroupThreadContext({ conversationId: "group:7", messages, previousState: previous });
    expect(result.changed).toBe(false);
    expect(result.error?.code).toBe("input_invalid");
    expect(result.passthroughMessages).toBe(messages);
    expect(result.passthroughMessages.map((item) => item.id)).toEqual(["2", "1"]);
  });
});

function message(id: string, sequence: number, userId: string, text: string): GroupThreadMessageRecord {
  return { id, sequence, userId, text, role: "user", replyMessageIds: [] };
}

function thread(
  threadKey: string,
  topic: string,
  status: "active" | "dormant" | "closed" = "active",
  existingThreadId: string | null = null
) {
  return {
    thread_key: threadKey,
    existing_thread_id: existingThreadId,
    topic,
    status
  };
}

function assignment(
  messageId: string,
  primaryThreadKey: string,
  relation: "new" | "continue" | "reply" | "switch" | "bridge" | "unresolved",
  confidence: number,
  relatedThreadKeys: string[] = []
) {
  return {
    message_id: messageId,
    primary_thread_key: primaryThreadKey,
    related_thread_keys: relatedThreadKeys,
    relation,
    confidence
  };
}

function modelOutput(input: {
  threads?: ReturnType<typeof thread>[];
  assignments?: ReturnType<typeof assignment>[];
  active?: string | null;
}) {
  return {
    schema_version: 1,
    active_thread_key: input.active ?? null,
    threads: input.threads ?? [],
    message_assignments: input.assignments ?? []
  };
}

function existingState(input: { status?: "active" | "dormant" | "closed" } = {}): GroupThreadStateV1 {
  const threadId = createDeterministicGroupThreadId({
    conversationId: "seed",
    anchorMessageId: "100",
    anchorSequence: 1
  });
  return {
    schemaVersion: 1,
    revision: 1,
    processedThroughSequence: 1,
    ...(input.status && input.status !== "active" ? {} : { activeThreadId: threadId }),
    threads: [{
      threadId,
      topic: "群成员正在确认杭州明天是否下雨，以决定是否晾晒被子。",
      status: input.status ?? "active",
      participantUids: ["10001"],
      messageIds: ["100"],
      anchorMessageId: "100",
      lastSequence: 1
    }],
    assignments: [{
      messageId: "100",
      sequence: 1,
      primaryThreadId: threadId,
      relatedThreadIds: [],
      relation: "new",
      confidence: 1
    }]
  };
}
