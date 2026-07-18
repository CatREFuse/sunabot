// @vitest-environment node
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { AttachmentSourcePort } from "../../packages/contracts/media/media.js";
import type {
  ConversationDirectoryPort,
  MessagingPort,
  OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  FakeAttachmentSourcePort,
  FakeConversationDirectoryPort,
  FakeMessagingPort
} from "../../packages/testkit/fakeMessagingPort.js";
import { defaultConfig } from "../../src/config.js";

describe("MessagingPort contract", () => {
  it("runs the same outbound business use case through the in-memory fake", async () => {
    const port = new FakeMessagingPort();
    const receipt = await sendReplyUseCase(port);

    expect(receipt).toMatchObject({ accepted: true, messageId: "fake-1" });
    expect(port.sent).toEqual([replyMessage()]);
  });

  it("runs the same outbound business use case through the OneBot adapter", async () => {
    const gateway = oneBotGateway();
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

  it("maps private and group pokes to the NapCat send_poke action", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.poke({ accountId: "account-b", userId: 99, groupId: 42 });
    await gateway.poke({ userId: 100 });

    expect(sendAction).toHaveBeenNthCalledWith(1, "send_poke", {
      group_id: 42,
      user_id: 99
    }, "account-b");
    expect(sendAction).toHaveBeenNthCalledWith(2, "send_poke", {
      user_id: 100
    });
  });

  it("runs the same directory use case through fake and OneBot ports", async () => {
    const expected = {
      friendsReady: true,
      groupsReady: true,
      friends: [{ userId: 99, nickname: "测试用户", remark: "管理员" }],
      groups: [{ groupId: 42, groupName: "测试群" }]
    };
    const fake = new FakeConversationDirectoryPort(expected);
    const gateway = oneBotGateway();
    vi.spyOn(gateway, "sendAction").mockImplementation(async (action) => action === "get_friend_list"
      ? { status: "ok", data: [{ user_id: 99, nickname: "测试用户", remark: "管理员" }] }
      : { status: "ok", data: [{ group_id: 42, group_name: "测试群" }] });

    await expect(loadDirectoryUseCase(fake)).resolves.toEqual(expected);
    await expect(loadDirectoryUseCase(gateway)).resolves.toEqual(expected);
  });

  it("targets directory actions to the requested OneBot account", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok", data: [] });

    await gateway.loadConversationDirectory("qq-koharu");

    expect(sendAction).toHaveBeenNthCalledWith(1, "get_friend_list", {}, "qq-koharu");
    expect(sendAction).toHaveBeenNthCalledWith(2, "get_group_list", {}, "qq-koharu");
  });

  it("runs the same attachment source use case through fake and OneBot ports", async () => {
    const expected = {
      kind: "url" as const,
      url: "https://cdn.example.test/report.pdf",
      via: "group_file_url" as const
    };
    const fake = new FakeAttachmentSourcePort(expected);
    const gateway = oneBotGateway();
    vi.spyOn(gateway, "sendAction").mockResolvedValue({ data: { url: expected.url } });

    await expect(resolveAttachmentUseCase(fake)).resolves.toEqual(expected);
    await expect(resolveAttachmentUseCase(gateway)).resolves.toEqual(expected);
  });
});

async function sendReplyUseCase(port: MessagingPort) {
  return port.send(replyMessage());
}

function loadDirectoryUseCase(port: ConversationDirectoryPort) {
  return port.loadConversationDirectory();
}

function resolveAttachmentUseCase(port: AttachmentSourcePort) {
  return port.resolveAttachment({ fileId: "report-file", groupId: 42 });
}

function oneBotGateway() {
  return new OneBotGateway(http.createServer(), defaultConfig(), {
    handleInboundMessage: vi.fn(async () => undefined)
  });
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
