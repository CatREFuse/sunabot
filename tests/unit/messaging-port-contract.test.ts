// @vitest-environment node
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { MessagingPort, OutboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import { FakeMessagingPort } from "../../packages/testkit/fakeMessagingPort.js";
import { defaultConfig } from "../../src/config.js";

describe("MessagingPort contract", () => {
  it("runs the same outbound business use case through the in-memory fake", async () => {
    const port = new FakeMessagingPort();
    const receipt = await sendReplyUseCase(port);

    expect(receipt).toMatchObject({ accepted: true, messageId: "fake-1" });
    expect(port.sent).toEqual([replyMessage()]);
  });

  it("runs the same outbound business use case through the OneBot adapter", async () => {
    const gateway = new OneBotGateway(http.createServer(), defaultConfig(), {
      handleInboundMessage: vi.fn(async () => undefined)
    });
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({
      status: "ok",
      data: { message_id: 987 }
    });

    const receipt = await sendReplyUseCase(gateway);

    expect(receipt).toEqual({ accepted: true, messageId: "987" });
    expect(sendAction).toHaveBeenCalledWith("send_group_msg", {
      group_id: 42,
      message: [
        { type: "reply", data: { id: "7" } },
        { type: "text", data: { text: "生成完成" } },
        { type: "image", data: { file: "https://cdn.example.test/image.png" } }
      ]
    });
  });
});

async function sendReplyUseCase(port: MessagingPort) {
  return port.send(replyMessage());
}

function replyMessage(): OutboundMessageV1 {
  return {
    schemaVersion: 1,
    id: "outbound-1",
    conversationId: "group:42",
    scope: "user_group",
    userId: 99,
    groupId: 42,
    text: "生成完成",
    media: [{
      schemaVersion: 1,
      kind: "image",
      source: "remote_url",
      url: "https://cdn.example.test/image.png"
    }],
    replyToMessageId: 7
  };
}
