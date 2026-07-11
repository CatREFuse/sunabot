// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { OneBotEvent } from "../../src/types.js";

describe("OneBot sender name resolution", () => {
  it("uses a non-empty nickname when the group card is blank", () => {
    expect(senderDisplayName({ card: "", nickname: "海斗[I.R.I.S接入]", user_id: 841623333 }))
      .toBe("海斗[I.R.I.S接入]");
  });

  it("prefers a non-empty group card without querying member info", async () => {
    const resolver = new SenderNameResolver();
    const gateway = { sendAction: vi.fn() };
    const event = groupEvent({ card: "群名片", nickname: "QQ昵称" });

    await expect(resolver.hydrate(event, gateway)).resolves.toBe("群名片");
    expect(gateway.sendAction).not.toHaveBeenCalled();
  });

  it("queries missing group member names and caches the result", async () => {
    const resolver = new SenderNameResolver();
    const gateway = {
      sendAction: vi.fn(async () => ({
        status: "ok",
        data: { card: "", nickname: "海斗[I.R.I.S接入]", user_id: 841623333 }
      }))
    };
    const first = groupEvent({ card: "", nickname: "" });
    const second = groupEvent(undefined);

    await expect(resolver.hydrate(first, gateway)).resolves.toBe("海斗[I.R.I.S接入]");
    await expect(resolver.hydrate(second, gateway)).resolves.toBe("海斗[I.R.I.S接入]");
    expect(first.sender?.nickname).toBe("海斗[I.R.I.S接入]");
    expect(first.sender?.card).toBe("");
    expect(second.sender?.nickname).toBe("海斗[I.R.I.S接入]");
    expect(gateway.sendAction).toHaveBeenCalledOnce();
    expect(gateway.sendAction).toHaveBeenCalledWith("get_group_member_info", {
      group_id: 1030412235,
      user_id: 841623333,
      no_cache: false
    });
  });

  it("keeps the original QQ nickname and group card as separate fields", async () => {
    const resolver = new SenderNameResolver();
    const gateway = {
      sendAction: vi.fn(async () => ({
        status: "ok",
        data: { card: "群名片", nickname: "QQ 原昵称", user_id: 841623333 }
      }))
    };
    const event = groupEvent({ card: "群名片", nickname: "" });

    await expect(resolver.hydrate(event, gateway)).resolves.toBe("群名片");
    expect(senderIdentity(event.sender)).toMatchObject({
      nickname: "QQ 原昵称",
      card: "群名片",
      displayName: "群名片"
    });
  });

  it("loads a missing private nickname without a group lookup", async () => {
    const resolver = new SenderNameResolver();
    const gateway = {
      sendAction: vi.fn(async () => ({ data: { nickname: "私聊昵称", user_id: 841623333 } }))
    };
    const event: OneBotEvent = { message_type: "private", user_id: 841623333, sender: undefined };

    await expect(resolver.hydrate(event, gateway)).resolves.toBe("私聊昵称");
    expect(gateway.sendAction).toHaveBeenCalledWith("get_stranger_info", { user_id: 841623333, no_cache: false });
  });

  it("keeps processing with an empty name when member lookup fails", async () => {
    const resolver = new SenderNameResolver();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gateway = { sendAction: vi.fn(async () => { throw new Error("offline"); }) };
    const first = groupEvent(undefined);
    const second = groupEvent(undefined);

    await expect(resolver.hydrate(first, gateway)).resolves.toBe("");
    await expect(resolver.hydrate(second, gateway)).resolves.toBe("");
    expect(gateway.sendAction).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

function groupEvent(sender: Record<string, unknown> | undefined): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: 1001,
    user_id: 841623333,
    group_id: 1030412235,
    sender,
    message: "那我呢"
  };
}
