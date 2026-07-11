// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { InboundMessageV1, SenderIdentityV1 } from "../../packages/contracts/messaging/messages.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";

describe("sender name resolution", () => {
  it("uses a non-empty nickname when the group card is blank", () => {
    expect(senderDisplayName({ id: "841623333", card: "", nickname: "海斗[I.R.I.S接入]" }))
      .toBe("海斗[I.R.I.S接入]");
  });

  it("prefers a non-empty group card without querying member info", async () => {
    const resolver = new SenderNameResolver();
    const gateway = senderGateway();
    const message = groupMessage({ card: "群名片", nickname: "QQ昵称" });

    await expect(resolver.hydrate(message, gateway)).resolves.toBe("群名片");
    expect(gateway.resolveSender).not.toHaveBeenCalled();
  });

  it("queries missing group member names and caches the result", async () => {
    const resolver = new SenderNameResolver();
    const gateway = senderGateway({ id: "841623333", nickname: "海斗[I.R.I.S接入]" });
    const first = groupMessage({ card: "", nickname: "" });
    const second = groupMessage(undefined);

    await expect(resolver.hydrate(first, gateway)).resolves.toBe("海斗[I.R.I.S接入]");
    await expect(resolver.hydrate(second, gateway)).resolves.toBe("海斗[I.R.I.S接入]");
    expect(first.sender.nickname).toBe("海斗[I.R.I.S接入]");
    expect(second.sender.nickname).toBe("海斗[I.R.I.S接入]");
    expect(gateway.resolveSender).toHaveBeenCalledOnce();
    expect(gateway.resolveSender).toHaveBeenCalledWith({ userId: 841623333, groupId: 1030412235 });
  });

  it("keeps the original nickname and group card as separate fields", async () => {
    const resolver = new SenderNameResolver();
    const gateway = senderGateway({ id: "841623333", card: "群名片", nickname: "QQ 原昵称" });
    const message = groupMessage({ card: "", nickname: "" });

    await expect(resolver.hydrate(message, gateway)).resolves.toBe("群名片");
    expect(senderIdentity(message.sender)).toMatchObject({
      nickname: "QQ 原昵称",
      card: "群名片",
      displayName: "群名片"
    });
  });

  it("loads a missing private nickname without a group lookup", async () => {
    const resolver = new SenderNameResolver();
    const gateway = senderGateway({ id: "841623333", nickname: "私聊昵称" });
    const message = privateMessage();

    await expect(resolver.hydrate(message, gateway)).resolves.toBe("私聊昵称");
    expect(gateway.resolveSender).toHaveBeenCalledWith({ userId: 841623333, groupId: undefined });
  });

  it("keeps processing with an empty name when lookup fails", async () => {
    const resolver = new SenderNameResolver();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gateway = { resolveSender: vi.fn(async () => { throw new Error("offline"); }) };
    const first = groupMessage(undefined);
    const second = groupMessage(undefined);

    await expect(resolver.hydrate(first, gateway)).resolves.toBe("841623333");
    await expect(resolver.hydrate(second, gateway)).resolves.toBe("841623333");
    expect(gateway.resolveSender).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

function senderGateway(identity: SenderIdentityV1 = { id: "841623333" }) {
  return { resolveSender: vi.fn(async () => identity) };
}

function groupMessage(sender: SenderIdentityV1 | undefined): InboundMessageV1 {
  return {
    schemaVersion: 1,
    scope: "user_group",
    messageId: 1001,
    time: "2026-07-11T12:00:00.000Z",
    userId: 841623333,
    groupId: 1030412235,
    sender: sender ?? { id: "841623333" },
    text: "那我呢",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function privateMessage(): InboundMessageV1 {
  return { ...groupMessage(undefined), scope: "private", groupId: undefined };
}
