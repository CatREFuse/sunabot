// @vitest-environment node
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { OutboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import { defaultConfig } from "../../src/config.js";

describe("OneBot outbound mentions", () => {
  it("sends reply, deduplicated mentions, then text as structured group segments", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.send(groupMessage({
      text: "定时提醒",
      replyToMessageId: 7,
      mentionUserIds: [10001, 10002, 10001]
    }));

    expect(sendAction).toHaveBeenCalledWith("send_group_msg", {
      group_id: 42,
      message: [
        { type: "reply", data: { id: "7" } },
        { type: "at", data: { qq: "10001" } },
        { type: "at", data: { qq: "10002" } },
        { type: "text", data: { text: "定时提醒" } }
      ]
    });
  });

  it("keeps all mentions before ordered text and image content", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.send(groupMessage({
      text: "前后",
      mentionUserIds: [10001, 10002],
      media: [{
        schemaVersion: 1,
        kind: "image",
        source: "remote_url",
        url: "https://cdn.example.test/reminder.png"
      }],
      contentSegments: [
        { type: "text", text: "前" },
        { type: "image", imageIndex: 0 },
        { type: "text", text: "后" }
      ]
    }));

    expect(sendAction.mock.calls[0]?.[1].message).toEqual([
      { type: "at", data: { qq: "10001" } },
      { type: "at", data: { qq: "10002" } },
      { type: "text", data: { text: "前" } },
      { type: "image", data: { file: "https://cdn.example.test/reminder.png" } },
      { type: "text", data: { text: "后" } }
    ]);
  });

  it("fails closed when a private message requests mentions", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await expect(gateway.send({
      ...groupMessage(),
      conversationId: "private:7",
      scope: "private",
      groupId: undefined,
      mentionUserIds: [10001]
    })).rejects.toThrow("Outbound mentions require a group message.");
    expect(sendAction).not.toHaveBeenCalled();
  });

  it.each([
    [[0]],
    [[-1]],
    [[1.5]],
    [[Number.NaN]],
    [[Number.POSITIVE_INFINITY]],
    [[Number.MAX_SAFE_INTEGER + 1]]
  ])("rejects invalid mention user IDs before sending: %j", async (mentionUserIds) => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await expect(gateway.send(groupMessage({ mentionUserIds }))).rejects.toThrow(
      "Outbound mention user IDs must contain only positive safe integers."
    );
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("allows 20 unique mentions after deduplication", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const mentionUserIds = Array.from({ length: 20 }, (_, index) => index + 1);

    await gateway.send(groupMessage({ mentionUserIds: [1, ...mentionUserIds] }));

    const segments = sendAction.mock.calls[0]?.[1].message as Array<{ type: string }>;
    expect(segments.filter((segment) => segment.type === "at")).toHaveLength(20);
  });

  it("rejects more than 20 unique mentions before sending", async () => {
    const gateway = oneBotGateway();
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const mentionUserIds = Array.from({ length: 21 }, (_, index) => index + 1);

    await expect(gateway.send(groupMessage({ mentionUserIds }))).rejects.toThrow(
      "Outbound mention user IDs cannot exceed 20 unique users."
    );
    expect(sendAction).not.toHaveBeenCalled();
  });
});

function oneBotGateway() {
  return new OneBotGateway(http.createServer(), defaultConfig(), {
    handleInboundMessage: vi.fn(async () => undefined)
  });
}

function groupMessage(overrides: Partial<OutboundMessageV1> = {}): OutboundMessageV1 {
  return {
    schemaVersion: 1,
    id: "outbound-mentions",
    conversationId: "group:42",
    scope: "user_group",
    userId: 7,
    groupId: 42,
    text: "提醒",
    media: [],
    ...overrides
  };
}
