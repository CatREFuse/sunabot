// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner, CodexToolResult } from "../../src/codexTool.js";
import type {
  OpenAIProvider,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "../../src/openaiProvider.js";
import type { OneBotGateway } from "../../src/onebot.js";
import type { RenderedPromptRequest } from "../../src/promptSystem.js";
import { parseIncomingMessage, SunaRuntime } from "../../src/runtime.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { ConversationRecord, OneBotEvent } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const recallMemory = vi.hoisted(() => vi.fn(async () => ({ ok: true, matches: [] })));
const readUserProfileForUser = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));
vi.mock("../../src/memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory.js")>()),
  recallMemory,
  readUserProfileForUser
}));

const runtimes: SunaRuntime[] = [];
const stores: SessionStore[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
});

describe("SunaRuntime Session queue bridge", () => {
  it("keeps model starts and sends FIFO in one group while another group progresses", async () => {
    const gates = new Map([
      ["first", deferred<void>()],
      ["second", deferred<void>()],
      ["third", deferred<void>()],
      ["parallel", deferred<void>()]
    ]);
    const starts: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      const marker = findMarker(lastUserText(request), [...gates.keys()]);
      starts.push(marker);
      if (options.signal) signals.set(marker, options.signal);
      await gates.get(marker)!.promise;
      return { kind: "completed", text: `reply:${marker}` };
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    await harness.runtime.handleOneBotEvent(groupEvent(101, 100, "first"), harness.gateway);
    await harness.runtime.handleOneBotEvent(groupEvent(102, 100, "second"), harness.gateway);
    await harness.runtime.handleOneBotEvent(groupEvent(103, 100, "third"), harness.gateway);
    await harness.runtime.handleOneBotEvent(groupEvent(201, 200, "parallel"), harness.gateway);

    await waitUntil(() => starts.length === 2);
    expect(starts).toEqual(["first", "parallel"]);
    expect(signals.get("first")?.aborted).toBe(false);

    gates.get("parallel")!.resolve();
    await waitUntil(() => sentTexts(harness.gateway).includes("reply:parallel"));
    expect(starts).toEqual(["first", "parallel"]);

    gates.get("first")!.resolve();
    await waitUntil(() => starts.includes("second"));
    expect(signals.get("first")?.aborted).toBe(false);

    gates.get("second")!.resolve();
    await waitUntil(() => starts.includes("third"));
    gates.get("third")!.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(starts).toEqual(["first", "parallel", "second", "third"]);
    expect(sentMessages(harness.gateway)
      .filter(([groupId]) => groupId === 100)
      .map(([, text]) => text)).toEqual([
        "reply:first",
        "reply:second",
        "reply:third"
      ]);
    expect(harness.store.listTurns("group:100").map((turn) => turn.status)).toEqual([
      "replied",
      "replied",
      "replied"
    ]);
  });

  it("preserves per-group FIFO without loss or duplication across 100 deterministically interleaved turns", async () => {
    const random = seededRandom(0x5eedc0de);
    const groupIds = [410, 420, 430, 440, 450];
    const expectedByGroup = new Map(groupIds.map((groupId) => [groupId, [] as string[]]));
    const startsByGroup = new Map(groupIds.map((groupId) => [groupId, [] as string[]]));
    const markerGroup = new Map<string, number>();
    const markerDelay = new Map<string, number>();
    let activeProviders = 0;
    let maximumActiveProviders = 0;
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest
    ): Promise<ProviderTurnResult> => {
      const marker = lastUserText(request).match(/job-\d{3}/)?.[0];
      if (!marker) throw new Error(`Missing property-test marker: ${lastUserText(request)}`);
      const groupId = markerGroup.get(marker);
      if (groupId == null) throw new Error(`Unknown property-test marker: ${marker}`);
      startsByGroup.get(groupId)!.push(marker);
      activeProviders += 1;
      maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders);
      try {
        await delay(markerDelay.get(marker)!);
        return { kind: "completed", text: `reply:${marker}` };
      } finally {
        activeProviders -= 1;
      }
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    for (let index = 0; index < 100; index += 1) {
      const marker = `job-${String(index).padStart(3, "0")}`;
      const groupId = index < groupIds.length
        ? groupIds[index]!
        : groupIds[Math.floor(random() * groupIds.length)]!;
      markerGroup.set(marker, groupId);
      markerDelay.set(marker, 1 + Math.floor(random() * 8));
      expectedByGroup.get(groupId)!.push(marker);
      await harness.runtime.handleOneBotEvent(
        groupEvent(10_000 + index, groupId, marker),
        harness.gateway
      );
    }

    await harness.coordinator.waitForIdle({ timeoutMs: 10_000 });

    expect(completeRequestTurn).toHaveBeenCalledTimes(100);
    expect(maximumActiveProviders).toBeGreaterThan(1);
    for (const groupId of groupIds) {
      const expected = expectedByGroup.get(groupId)!;
      expect(startsByGroup.get(groupId)).toEqual(expected);
      expect(sentMessages(harness.gateway)
        .filter(([sentGroupId]) => sentGroupId === groupId)
        .map(([, text]) => text)).toEqual(expected.map((marker) => `reply:${marker}`));
      expect(harness.store.listEvents(`group:${groupId}`)).toHaveLength(expected.length);
    }
    const allSent = sentTexts(harness.gateway);
    expect(allSent).toHaveLength(100);
    expect(new Set(allSent).size).toBe(100);
  });

  it.each([
    { scope: "private", event: privateEvent(21_001, "retry-private"), sessionId: "private:2002" },
    { scope: "bot_group", event: botGroupEvent(21_002, 602, "retry-bot-group"), sessionId: "group:602" },
    { scope: "user_group", event: groupEvent(21_003, 603, "retry-user-group"), sessionId: "group:603" }
  ])("retries the same $scope event after a pre-commit enqueue failure", async ({ event, sessionId }) => {
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest
    ): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: `reply:${lastUserText(request).match(/retry-[a-z-]+/)?.[0] ?? "missing"}`
    }));
    const harness = createRuntimeHarness(completeRequestTurn, undefined, (config) => {
      config.onebot.autoReplyBotGroup = true;
    });
    const enqueue = vi.spyOn(harness.store, "enqueueEvent")
      .mockImplementationOnce(() => { throw new Error("simulated sqlite commit failure"); });

    await expect(harness.runtime.handleOneBotEvent(event, harness.gateway))
      .rejects.toThrow("simulated sqlite commit failure");
    expect(harness.store.listEvents(sessionId)).toHaveLength(0);
    expect(runtimeConversation(harness.runtime, sessionId)).toBeUndefined();

    enqueue.mockRestore();
    await harness.runtime.handleOneBotEvent(event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.store.listEvents(sessionId)).toHaveLength(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(runtimeConversation(harness.runtime, sessionId)?.messages
      .filter((message) => message.role === "user" && message.id === String(event.message_id)))
      .toHaveLength(1);
  });

  it("recovers a committed direct event with a missing conversation message and stays idempotent on redelivery", async () => {
    const event = privateEvent(22_001, "recover-missing-user");
    const incoming = parseIncomingMessage(event)!;
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "reply:recovered"
    }));
    const harness = createRuntimeHarness(completeRequestTurn);
    harness.store.enqueueEvent({
      sessionId: "private:2002",
      kind: "incoming_reply",
      dedupeKey: "reply:4004:private:2002:22001",
      payload: {
        type: "incoming_reply",
        route: "direct",
        incoming,
        captureSequence: 1
      }
    });

    harness.runtime.resumeUserGroupOrchestrators(harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const record = runtimeConversation(harness.runtime, "private:2002");
    expect(record?.messages.filter((message) => message.role === "user" && message.id === "22001"))
      .toHaveLength(1);
    expect(record?.orchestratorCheckedMessageCount).toBe(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.gateway.sendPrivateMessage).toHaveBeenCalledOnce();

    runtimeSeenIncoming(harness.runtime).clear();
    await harness.runtime.handleOneBotEvent(event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(record?.messages.filter((message) => message.role === "user" && message.id === "22001"))
      .toHaveLength(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.gateway.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "successful",
      toolStatus: "succeeded" as const,
      finalReply: "tool success reply"
    },
    {
      label: "failed",
      toolStatus: "failed" as const,
      finalReply: "tool failure reply"
    }
  ])("ACKs one deferred Codex turn, runs the next turn, then handles a $label completion at the tail", async ({
    toolStatus,
    finalReply
  }) => {
    const toolGate = deferred<void>();
    const toolStarted = deferred<void>();
    const completionPrompts: string[] = [];
    const providerStarts: string[] = [];
    const asyncCodexFlags: Array<boolean | undefined> = [];
    const runner: CodexRunner = {
      async run(input, context) {
        expect(input).toEqual({ task: "perform long analysis", kind: "analysis" });
        toolStarted.resolve();
        await toolGate.promise;
        if (toolStatus === "succeeded") {
          return {
            ok: true,
            status: "succeeded",
            jobId: context.jobId,
            kind: "analysis",
            content: "deep result"
          } satisfies CodexToolResult;
        }
        return {
          ok: false,
          status: "failed",
          jobId: context.jobId,
          kind: "analysis",
          error: { code: "worker_failed", message: "analysis failed" }
        } satisfies CodexToolResult;
      }
    };
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      const userText = lastUserText(request);
      asyncCodexFlags.push(options.asyncCodex);
      if (userText.includes("<tool_result>")) {
        providerStarts.push("tool_completion");
        completionPrompts.push(userText);
        return { kind: "completed", text: finalReply };
      }
      if (userText.includes("delegate")) {
        providerStarts.push("delegate");
        return {
          kind: "deferred",
          acknowledgement: "",
          toolCall: {
            name: "codex",
            callId: "call-runtime-codex",
            arguments: { task: "perform long analysis", kind: "analysis" }
          }
        };
      }
      if (userText.includes("later")) {
        providerStarts.push("later");
        return { kind: "completed", text: "later reply" };
      }
      throw new Error(`Unexpected provider request: ${userText}`);
    });
    const harness = createRuntimeHarness(completeRequestTurn, runner);
    const acknowledgement = "收到，任务已经开始处理，完成后我会继续回复。";

    await harness.runtime.handleOneBotEvent(groupEvent(301, 300, "delegate"), harness.gateway);
    await toolStarted.promise;
    await waitUntil(() => sentTexts(harness.gateway).includes(acknowledgement));
    expect(sentTexts(harness.gateway).filter((text) => text === acknowledgement)).toHaveLength(1);

    await harness.runtime.handleOneBotEvent(groupEvent(302, 300, "later"), harness.gateway);
    await waitUntil(() => sentTexts(harness.gateway).includes("later reply"));
    expect(providerStarts).toEqual(["delegate", "later"]);
    expect(sentTexts(harness.gateway)).not.toContain(finalReply);

    toolGate.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(providerStarts).toEqual(["delegate", "later", "tool_completion"]);
    expect(sentTexts(harness.gateway)).toEqual([
      acknowledgement,
      "later reply",
      finalReply
    ]);
    expect(harness.store.listEvents("group:300").map((event) => [event.sequence, event.kind])).toEqual([
      [1, "incoming_reply"],
      [2, "incoming_reply"],
      [3, "tool_completion"]
    ]);
    expect(harness.store.listToolJobs("group:300")[0]).toMatchObject({
      providerCallId: "call-runtime-codex",
      status: toolStatus
    });
    expect(completionPrompts).toHaveLength(1);
    expect(completionPrompts[0]).toContain('"providerCallId": "call-runtime-codex"');
    expect(completionPrompts[0]).toContain(`"status": "${toolStatus}"`);
    expect(asyncCodexFlags).toEqual([true, true, false]);
  });
});

interface RuntimeHarness {
  runtime: SunaRuntime;
  store: SessionStore;
  gateway: OneBotGateway;
  coordinator: {
    waitForIdle(options?: { timeoutMs?: number }): Promise<void>;
  };
}

function createRuntimeHarness(
  completeRequestTurn: (
    request: RenderedPromptRequest,
    options?: ProviderCompleteOptions
  ) => Promise<ProviderTurnResult>,
  codexRunner: CodexRunner | undefined = undefined,
  configure?: (config: ReturnType<typeof createAdminTestConfig>) => void
): RuntimeHarness {
  const resolvedCodexRunner: CodexRunner = codexRunner ?? {
    async run(_input, context) {
      return {
        ok: true,
        status: "succeeded",
        jobId: context.jobId,
        kind: "analysis",
        content: "unused"
      };
    }
  };
  const store = new SessionStore({ databasePath: ":memory:" });
  stores.push(store);
  const config = createAdminTestConfig("/tmp/sunabot-runtime-session-queue");
  configure?.(config);
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    sessionStore: store,
    codexRunner: resolvedCodexRunner
  });
  runtimes.push(runtime);
  const provider = {
    completeRequestTurn: vi.fn(completeRequestTurn),
    generateImage: vi.fn()
  } as unknown as OpenAIProvider;
  const internals = runtime as unknown as {
    persona: {
      id: "plana";
      name: string;
      files: unknown[];
      memoryItems: unknown[];
      systemPrompt: string;
    };
    conversationRecords: Map<string, ConversationRecord>;
    getProvider(): OpenAIProvider;
    prepareIncomingMessage(): Promise<void>;
    patchIncomingMessage(): void;
    scheduleAttachmentCacheRefresh(): void;
    scheduleMemoryCompression(): void;
    persistConversationRecords(): void;
    renderPromptRequest(
      id: string,
      variables: Record<string, unknown>
    ): Promise<RenderedPromptRequest>;
    sessionCoordinator: RuntimeHarness["coordinator"];
  };
  internals.persona = {
    id: "plana",
    name: "普拉娜",
    files: [],
    memoryItems: [],
    systemPrompt: "test system"
  };
  internals.conversationRecords.clear();
  internals.getProvider = () => provider;
  internals.prepareIncomingMessage = async () => undefined;
  internals.patchIncomingMessage = () => undefined;
  internals.scheduleAttachmentCacheRefresh = () => undefined;
  internals.scheduleMemoryCompression = () => undefined;
  internals.persistConversationRecords = () => undefined;
  internals.renderPromptRequest = async (_id, variables) => ({
    messages: [
      { role: "system", content: "test system" },
      { role: "user", content: String(variables["user.input"] ?? "") }
    ],
    response_format: { type: "text" }
  });

  return {
    runtime,
    store,
    gateway: fakeGateway(),
    coordinator: internals.sessionCoordinator
  };
}

function fakeGateway() {
  return {
    getStatus: vi.fn(() => ({ connected: true })),
    sendGroupMessage: vi.fn(async () => ({ status: "ok" })),
    sendGroupRichMessage: vi.fn(async () => ({ status: "ok" })),
    sendPrivateMessage: vi.fn(async () => ({ status: "ok" })),
    sendPrivateRichMessage: vi.fn(async () => ({ status: "ok" }))
  } as unknown as OneBotGateway;
}

function groupEvent(messageId: number, groupId: number, marker: string): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: messageId,
    user_id: 2002,
    group_id: groupId,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: `user-${groupId}` },
    message: `Plana ${marker}`
  };
}

function botGroupEvent(messageId: number, groupId: number, marker: string): OneBotEvent {
  return {
    ...groupEvent(messageId, groupId, marker),
    sub_type: "bot_group",
    sender: { nickname: `bot-${groupId}`, role: "bot" }
  };
}

function privateEvent(messageId: number, marker: string): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    message_id: messageId,
    user_id: 2002,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: "private-user" },
    message: marker
  };
}

function runtimeConversation(runtime: SunaRuntime, id: string) {
  return (runtime as unknown as {
    conversationRecords: Map<string, ConversationRecord>;
  }).conversationRecords.get(id);
}

function runtimeSeenIncoming(runtime: SunaRuntime) {
  return (runtime as unknown as {
    seenIncomingEvents: Map<string, number>;
  }).seenIncomingEvents;
}

function lastUserText(request: RenderedPromptRequest) {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function findMarker(text: string, markers: string[]) {
  const marker = markers.find((value) => text.includes(value));
  if (!marker) throw new Error(`No test marker in provider input: ${text}`);
  return marker;
}

function sentMessages(gateway: OneBotGateway) {
  const send = gateway.sendGroupMessage as unknown as ReturnType<typeof vi.fn>;
  return send.mock.calls.map((call) => [Number(call[0]), String(call[1])] as const);
}

function sentTexts(gateway: OneBotGateway) {
  return sentMessages(gateway).map(([, text]) => text);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime Session queue condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
