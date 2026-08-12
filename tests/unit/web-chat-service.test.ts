import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InboundMessageV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import {
  WEB_CHAT_REPLY_TIMEOUT_MS,
  WebChatService
} from "../../services/webChat/webChatService.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("WebChatService", () => {
  it("uses an isolated web delivery target and keeps deferred tools unavailable", async () => {
    let incoming: InboundMessageV1 | undefined;
    const recordIncomingMessage = vi.fn();
    const replyToIncoming = vi.fn(async (
      channel: string,
      message: InboundMessageV1,
      delivery: MessagingPort,
      options: {
        allowAsyncCodex?: boolean;
        allowAsyncImage?: boolean;
        allowImageTools?: boolean;
        captureSequence?: number;
        signal?: AbortSignal;
      }
    ) => {
      incoming = message;
      expect(channel).toBe("web:admin");
      expect(delivery.getStatus().selfIds).toEqual(["web"]);
      expect(options).toMatchObject({
        captureSequence: 1,
        allowAsyncCodex: false,
        allowAsyncImage: false,
        allowImageTools: false
      });
      expect(options.signal?.aborted).toBe(false);
      await delivery.send({
        schemaVersion: 1,
        id: "reply-1",
        conversationId: "web:admin",
        scope: "private",
        userId: 171419991,
        text: "你好",
        media: []
      });
    });
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage,
      replyToIncoming,
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;

    const result = await new WebChatService(runtime).send("测试");

    expect(incoming).toMatchObject({
      transport: "web",
      scope: "private",
      userId: 171419991,
      mentionedSelf: true
    });
    expect(conversationRecordId(incoming!)).toBe("web:admin");
    expect(recordIncomingMessage).toHaveBeenCalledWith(incoming, { expectedSequence: 1 });
    expect(WEB_CHAT_REPLY_TIMEOUT_MS).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: true, delivered: 1, conversationId: "web:admin" });
  });

  it("rejects a missing administrator QQ before starting a model turn", async () => {
    const replyToIncoming = vi.fn();
    const runtime = {
      adminIdentity: () => ({ userId: "", name: "管理员" }),
      replyToIncoming
    } as unknown as SunaRuntime;

    await expect(new WebChatService(runtime).send("测试")).rejects.toMatchObject({
      statusCode: 409,
      code: "WEB_CHAT_ADMIN_QQ_REQUIRED",
      message: "请先在 Bot 设置中配置管理员 QQ。"
    });
    expect(replyToIncoming).not.toHaveBeenCalled();
  });

  it("serializes turns from multiple Web Chat tabs", async () => {
    const firstTurn = deferred<void>();
    const starts: string[] = [];
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (_channel: string, incoming: InboundMessageV1) => {
        starts.push(incoming.text);
        if (incoming.text === "第一条") await firstTurn.promise;
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);

    const first = service.send("第一条");
    const second = service.send("第二条");
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(["第一条"]);

    firstTurn.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual(["第一条", "第二条"]);
  });

  it("hard-settles at 600 seconds and releases the queue when the callee ignores abort", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    let firstSignal: AbortSignal | undefined;
    let firstDelivery: MessagingPort | undefined;
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (
        _channel: string,
        incoming: InboundMessageV1,
        delivery: MessagingPort,
        options: { signal: AbortSignal }
      ) => {
        starts.push(incoming.text);
        if (incoming.text === "第一条") {
          firstSignal = options.signal;
          firstDelivery = delivery;
          await new Promise<never>(() => undefined);
        }
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);
    const first = service.send("第一条").catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WEB_CHAT_REPLY_TIMEOUT_MS - 1);
    const second = service.send("第二条");

    expect(firstSignal?.aborted).toBe(false);
    expect(starts).toEqual(["第一条"]);

    await vi.advanceTimersByTimeAsync(1);

    await expect(first).resolves.toMatchObject({
      statusCode: 504,
      code: "WEB_CHAT_REPLY_TIMEOUT"
    });
    expect(firstSignal?.aborted).toBe(true);
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(starts).toEqual(["第一条", "第二条"]);
    await expect(firstDelivery!.send({
      schemaVersion: 1,
      id: "late-reply",
      conversationId: "web:admin",
      scope: "private",
      userId: 171419991,
      text: "迟到回复",
      media: []
    })).rejects.toMatchObject({ code: "WEB_CHAT_REPLY_TIMEOUT" });
  });

  it("counts queue wait against the same 600-second deadline", async () => {
    vi.useFakeTimers();
    const firstTurn = deferred<void>();
    const starts: string[] = [];
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (_channel: string, incoming: InboundMessageV1) => {
        starts.push(incoming.text);
        if (incoming.text === "第一条") await firstTurn.promise;
        else await new Promise<never>(() => undefined);
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);
    const first = service.send("第一条");
    const second = service.send("第二条").catch((error) => error);
    await vi.advanceTimersByTimeAsync(400_000);
    firstTurn.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(starts).toEqual(["第一条", "第二条"]);

    await vi.advanceTimersByTimeAsync(WEB_CHAT_REPLY_TIMEOUT_MS - 400_001);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({
      statusCode: 504,
      code: "WEB_CHAT_REPLY_TIMEOUT"
    });
  });

  it("cancels a running turn when its caller disconnects", async () => {
    const started = deferred<AbortSignal>();
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (
        _channel: string,
        _incoming: InboundMessageV1,
        _delivery: MessagingPort,
        options: { signal: AbortSignal }
      ) => {
        started.resolve(options.signal);
        await new Promise<never>(() => undefined);
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);
    const caller = new AbortController();
    const turn = service.send("测试断开", caller.signal);
    const taskSignal = await started.promise;

    caller.abort(new Error("WEB_CHAT_REQUEST_ABORTED"));

    await expect(turn).rejects.toMatchObject({
      statusCode: 499,
      code: "WEB_CHAT_REQUEST_ABORTED"
    });
    expect(taskSignal.aborted).toBe(true);
  });

  it("hard-settles a running turn when its runtime is closed or replaced", async () => {
    const runtimeController = new AbortController();
    const started = deferred<AbortSignal>();
    const runtime = {
      runtimeSignal: runtimeController.signal,
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (
        _channel: string,
        _incoming: InboundMessageV1,
        _delivery: MessagingPort,
        options: { signal: AbortSignal }
      ) => {
        started.resolve(options.signal);
        await new Promise<never>(() => undefined);
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);
    const turn = service.send("运行时替换");
    const taskSignal = await started.promise;

    runtimeController.abort(new DOMException("Runtime closed.", "AbortError"));

    await expect(turn).rejects.toMatchObject({
      statusCode: 503,
      code: "WEB_CHAT_SHUTTING_DOWN"
    });
    expect(taskSignal.aborted).toBe(true);
  });

  it("does not record a queued turn cancelled before it starts", async () => {
    const firstStarted = deferred<void>();
    const recordIncomingMessage = vi.fn();
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage,
      replyToIncoming: vi.fn(async (_channel: string, incoming: InboundMessageV1) => {
        if (incoming.text === "第一条") {
          firstStarted.resolve();
          await new Promise<never>(() => undefined);
        }
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const service = new WebChatService(runtime);
    const first = service.send("第一条").catch((error) => error);
    await firstStarted.promise;
    const caller = new AbortController();
    const second = service.send("第二条", caller.signal);

    caller.abort(new Error("WEB_CHAT_REQUEST_ABORTED"));

    await expect(second).rejects.toMatchObject({
      statusCode: 499,
      code: "WEB_CHAT_REQUEST_ABORTED"
    });
    expect(recordIncomingMessage).toHaveBeenCalledTimes(1);
    service.close();
    await expect(first).resolves.toMatchObject({
      statusCode: 503,
      code: "WEB_CHAT_SHUTTING_DOWN"
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
