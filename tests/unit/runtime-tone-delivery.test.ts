// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { ReplyGateEpochs } from "../../services/orchestration/groupReplyPolicy.js";
import type { ReplyDelivery } from "../../src/runtime/runtimeContracts.js";
import {
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
    const host = {
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
    const host = {
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
});
