// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { OutboxDeliveryContext } from "../../services/sessions/sessionCoordinator.js";
import { ReplyGateEpochs } from "../../services/orchestration/groupReplyPolicy.js";
import { defaultConfig } from "../../src/config.js";
import type { ReplyDelivery } from "../../src/runtime/runtimeContracts.js";
import {
  runtime_deliverReplyOutbox,
  runtime_replyDeliveryDraft,
  runtime_sendAssistantReply
} from "../../src/runtime/delivery.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

describe("tone outbound delivery", () => {
  it("replaces only text while preserving generated media and reply metadata in one durable payload", async () => {
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      transport: "onebot",
      agentId: "plana",
      accountId: "primary",
      scope: "private",
      messageId: 101,
      time: "2026-07-18T08:00:00.000Z",
      userId: 1,
      selfId: 2,
      sender: { id: "1", displayName: "猫老师" },
      text: "用户输入",
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: false
    };
    const images = [{
      url: "data:image/png;base64,AA==",
      filePath: "/tmp/generated.png",
      revisedPrompt: "unchanged prompt"
    }];
    const rewriteToneText = vi.fn(async () => "改写后的正文");
    const config = defaultConfig();
    const host = {
      config,
      isReplySenderAllowed: () => true,
      hooks: { run: vi.fn(async () => ({ text: "before_reply 后的正文" })) },
      rewriteToneText,
      replyGates: new ReplyGateEpochs(),
      groupReplyOptions: () => ({ replyToMessageId: undefined }),
      replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>) {
        return runtime_replyDeliveryDraft.call(host as unknown as SunaRuntime, ...args);
      }
    };
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const gateway = { send: vi.fn() } as unknown as MessagingPort;

    await runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      true,
      images,
      "run-1",
      () => true,
      delivery,
      true,
      { messageOrigin: "assistant_text", toolNames: ["assistant_text"] }
    );

    expect(rewriteToneText).toHaveBeenCalledWith("before_reply 后的正文", expect.objectContaining({
      incoming,
      logContext: {
        conversationId: "private:1",
        incomingMessageId: "101",
        runId: "run-1"
      }
    }));
    expect(gateway.send).not.toHaveBeenCalled();
    expect(delivery.outbox).toHaveLength(1);
    const draft = delivery.outbox[0];
    expect(draft?.kind).toBe("onebot.reply");
    if (draft?.kind !== "onebot.reply") throw new Error("expected assistant reply draft");
    expect(draft.payload.payload).toMatchObject({
      text: "改写后的正文",
      generatedImages: images,
      messageOrigin: "assistant_text",
      toolNames: ["assistant_text"],
      logRunId: "run-1"
    });
  });

  it("does not create an outbox draft or bypass raw text when tone fails", async () => {
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      scope: "private",
      time: "2026-07-18T08:00:00.000Z",
      userId: 1,
      sender: { id: "1" },
      text: "用户输入",
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: false
    };
    const failure = new Error("tone unavailable");
    const config = defaultConfig();
    const host = {
      config,
      isReplySenderAllowed: () => true,
      hooks: { run: vi.fn(async () => ({ text: "原始正文" })) },
      rewriteToneText: vi.fn(async () => { throw failure; })
    };
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const gateway = { send: vi.fn() } as unknown as MessagingPort;

    await expect(runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      false,
      [],
      undefined,
      () => true,
      delivery
    )).rejects.toBe(failure);

    expect(delivery.outbox).toEqual([]);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("turns each XML node into one durable QQ bubble and quotes only the first bubble", async () => {
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      transport: "onebot",
      agentId: "plana",
      accountId: "primary",
      scope: "user_group",
      messageId: 101,
      time: "2026-07-18T08:00:00.000Z",
      userId: 1,
      groupId: 99,
      selfId: 2,
      sender: { id: "1", displayName: "猫老师" },
      text: "用户输入",
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: true
    };
    const image = { url: "data:image/png;base64,AA==", revisedPrompt: "unchanged" };
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const rawXmlDraft = "<dialog>命令：<br/>npm run check</dialog>";
    const host = {
      config,
      isReplySenderAllowed: () => true,
      hooks: { run: vi.fn(async () => ({ text: rawXmlDraft })) },
      rewriteToneDelivery: vi.fn(async () => ({
        segmented: true,
        content: [
          '<dialogc replay="msg_id">老师！</dialogc>',
          "<dialog>阿罗娜一直在等你！</dialog>",
          '<img src="asset:image:0"/>'
        ].join("")
      })),
      replyGates: new ReplyGateEpochs(),
      groupReplyOptions: () => ({ replyToMessageId: 101 }),
      replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>) {
        return runtime_replyDeliveryDraft.call(host as unknown as SunaRuntime, ...args);
      }
    };
    const delivery: ReplyDelivery = {
      outbox: [],
      replyQuote: { enabled: true, replyToMessageId: 101 },
      mentionUserIds: [1]
    };
    const gateway = { send: vi.fn() } as unknown as MessagingPort;

    await runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "user_group:99",
      incoming,
      gateway,
      "原始正文",
      true,
      [image],
      "run-segmented",
      () => true,
      delivery
    );

    expect(delivery.outbox).toHaveLength(3);
    expect(host.rewriteToneDelivery).toHaveBeenCalledWith(
      rawXmlDraft,
      [{ kind: "image", src: "asset:image:0" }],
      expect.any(Object),
      []
    );
    const payloads = delivery.outbox.map((draft) => {
      if (draft.kind !== "onebot.reply") throw new Error("expected reply draft");
      return draft.payload.payload;
    });
    expect(payloads.map((payload) => payload.text)).toEqual([
      "老师！",
      "阿罗娜一直在等你！",
      ""
    ]);
    expect(payloads.map((payload) => payload.replyToMessageId)).toEqual([101, null, null]);
    expect(payloads.map((payload) => payload.mentionUserIds)).toEqual([[1], undefined, undefined]);
    expect(payloads.map((payload) => payload.bubbleSequence)).toEqual([
      { schemaVersion: 1, index: 0, total: 3 },
      { schemaVersion: 1, index: 1, total: 3 },
      { schemaVersion: 1, index: 2, total: 3 }
    ]);
    expect(payloads[2]?.generatedImages).toEqual([image]);

    delivery.outbox.length = 0;
    await runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "user_group:99",
      incoming,
      gateway,
      "原始正文",
      true,
      [image],
      "run-atomic-image",
      () => true,
      delivery,
      true,
      { messageOrigin: "text" },
      "buffered",
      undefined,
      undefined,
      true
    );
    expect(delivery.outbox).toHaveLength(1);
    if (delivery.outbox[0]?.kind !== "onebot.reply") throw new Error("expected atomic reply draft");
    expect(delivery.outbox[0].payload.payload).toMatchObject({
      text: "老师！\n阿罗娜一直在等你！",
      generatedImages: [image],
      replyToMessageId: 101,
      mentionUserIds: [1]
    });
    expect(delivery.outbox[0].payload.payload.bubbleSequence).toBeUndefined();
  });

  it("restores an omitted generated-image suffix while rejecting a changed media sequence", async () => {
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      transport: "onebot",
      agentId: "plana",
      accountId: "primary",
      scope: "private",
      messageId: 102,
      time: "2026-07-22T06:18:28.000Z",
      userId: 1,
      selfId: 2,
      sender: { id: "1", displayName: "猫老师" },
      text: "用户输入",
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: false
    };
    const images = [
      { url: "data:image/png;base64,AA==", revisedPrompt: "first" },
      { url: "data:image/png;base64,AQ==", revisedPrompt: "second" }
    ];
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const rewriteToneDelivery = vi.fn(async () => ({
      segmented: true as const,
      content: '<dialogc replay="msg_id">正文</dialogc>'
    }));
    const host = {
      config,
      isReplySenderAllowed: () => true,
      hooks: { run: vi.fn(async () => ({ text: "原始正文" })) },
      rewriteToneDelivery,
      replyGates: new ReplyGateEpochs(),
      groupReplyOptions: () => ({ replyToMessageId: undefined }),
      replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>) {
        return runtime_replyDeliveryDraft.call(host as unknown as SunaRuntime, ...args);
      }
    };
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const gateway = { send: vi.fn() } as unknown as MessagingPort;

    await runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      true,
      images,
      "run-missing-image",
      () => true,
      delivery
    );

    expect(delivery.outbox).toHaveLength(3);
    expect(delivery.outbox.map((draft) => draft.kind === "onebot.reply"
      ? draft.payload.payload.generatedImages.map((image) => image.revisedPrompt)
      : [])).toEqual([[], ["first"], ["second"]]);

    delivery.outbox.length = 0;
    rewriteToneDelivery.mockResolvedValueOnce({
      segmented: true,
      content: '<dialogc replay="msg_id">正文</dialogc><img src="asset:image:0"/>'
    });
    await runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      true,
      images,
      "run-missing-image-suffix",
      () => true,
      delivery
    );
    expect(delivery.outbox).toHaveLength(3);

    delivery.outbox.length = 0;
    rewriteToneDelivery.mockResolvedValueOnce({
      segmented: true,
      content: '<dialogc replay="msg_id">正文</dialogc><img src="asset:image:1"/>'
    });
    await expect(runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      true,
      images,
      "run-changed-image",
      () => true,
      delivery
    )).rejects.toMatchObject({ code: "SEGMENTED_REPLY_CONTRACT_INVALID" });
    expect(delivery.outbox).toEqual([]);

    rewriteToneDelivery.mockResolvedValueOnce({
      segmented: true,
      content: Array.from({ length: 32 }, (_, index) => `<dialog>气泡 ${index + 1}</dialog>`).join("")
    });
    await expect(runtime_sendAssistantReply.call(
      host as unknown as SunaRuntime,
      "private:1",
      incoming,
      gateway,
      "原始正文",
      true,
      [images[0]!],
      "run-bubble-overflow",
      () => true,
      delivery
    )).rejects.toThrow("分段回复最多包含 32 个气泡");
    expect(delivery.outbox).toEqual([]);
  });

  it("waits after outbox claim before sending a later bubble", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const gateway = {
      send: vi.fn(async () => ({ accepted: true, messageId: "bubble-2" }))
    } as unknown as MessagingPort;
    let phase: OutboxDeliveryContext["phase"] = "send";
    let remoteReceipt: unknown;
    const context: OutboxDeliveryContext = {
      signal: new AbortController().signal,
      get phase() { return phase; },
      get remoteReceipt() { return remoteReceipt; },
      async sendRemote(operation) {
        const receipt = await operation();
        remoteReceipt = receipt;
        phase = "settle";
        return receipt;
      },
      async settleStep() { return undefined; },
      async settleEffectStep() { return undefined; }
    };
    const host = {
      hooks: { runEach: vi.fn(async () => undefined) }
    };

    try {
      const delivery = runtime_deliverReplyOutbox.call(host as unknown as SunaRuntime, {
        type: "assistant_reply",
        incoming: {
          schemaVersion: 1,
          transport: "onebot",
          agentId: "plana",
          accountId: "primary",
          scope: "private",
          time: "2026-07-18T08:00:00.000Z",
          userId: 1,
          selfId: 2,
          sender: { id: "1" },
          text: "用户输入",
          media: [],
          attachments: [],
          replyMessageIds: [],
          quoteReferences: [],
          mentionedSelf: false
        },
        text: "第二个气泡",
        generatedImages: [],
        isAdmin: false,
        quoteReply: false,
        bubbleSequence: { schemaVersion: 1, index: 1, total: 2 }
      }, gateway, context);

      await vi.advanceTimersByTimeAsync(499);
      expect(gateway.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await delivery;
      expect(gateway.send).toHaveBeenCalledOnce();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
