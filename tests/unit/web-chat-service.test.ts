import { describe, expect, it, vi } from "vitest";
import type {
  InboundMessageV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { WebChatService } from "../../services/webChat/webChatService.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";

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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
