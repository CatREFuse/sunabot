import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import type { ConversationRecord } from "../../src/types.js";

describe("ConversationDirectory", () => {
  it("uses recognizable friend and group names while keeping identity fields", async () => {
    const sendAction = vi.fn(async (action: string) => {
      if (action === "get_friend_list") {
        return { data: [{ user_id: 171419991, nickname: "好吃的猫头菇", remark: "猫老师" }] };
      }
      return { data: [{ group_id: 1030412235, group_name: "相当于你这周啥也没干啊" }] };
    });
    const gateway = { getStatus: () => ({ connectedAt: "2026-07-10T00:00:00.000Z" }), sendAction };
    const directory = new ConversationDirectory();

    const result = await directory.enrich([
      conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
      conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
    ], gateway);

    expect(result[0]).toMatchObject({ title: "猫老师", nickname: "好吃的猫头菇", remark: "猫老师" });
    expect(result[1]).toMatchObject({ title: "相当于你这周啥也没干啊", groupName: "相当于你这周啥也没干啊" });
    await directory.enrich(result, gateway);
    expect(sendAction).toHaveBeenCalledTimes(2);
  });

  it("falls back to the latest message nickname and readable stored titles", async () => {
    const gateway = {
      getStatus: () => ({ connectedAt: "2026-07-10T00:00:00.000Z" }),
      sendAction: vi.fn(async () => { throw new Error("offline"); })
    };
    const directory = new ConversationDirectory();
    const privateRecord = conversation({
      id: "private:2744113623",
      userId: 2744113623,
      title: "2744113623",
      messages: [{ id: "m1", role: "user", userId: 2744113623, text: "hi", at: "2026-07-10T00:00:00.000Z", senderNickname: "不是外行黄悟我" }]
    });
    const groupRecord = conversation({ id: "group:7", userId: 1, groupId: 7, title: "产品讨论群" });

    const result = await directory.enrich([privateRecord, groupRecord], gateway);
    expect(result[0]?.title).toBe("不是外行黄悟我");
    expect(result[1]?.title).toBe("产品讨论群");
  });

  it("retries once when OneBot is connected before its directory actions are ready", async () => {
    let attempts = 0;
    const sendAction = vi.fn(async (action: string) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("not ready");
      return action === "get_group_list"
        ? { data: [{ group_id: 7, group_name: "七号讨论组" }] }
        : { data: [] };
    });
    const directory = new ConversationDirectory();
    const result = await directory.enrich(
      [conversation({ id: "group:7", userId: 1, groupId: 7, title: "7" })],
      { getStatus: () => ({ connectedAt: "generation-1" }), sendAction }
    );

    expect(result[0]?.title).toBe("七号讨论组");
    expect(sendAction).toHaveBeenCalledTimes(4);
  });

  it("keeps recognizable names across restarts when OneBot temporarily returns empty directories", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-directory-"));
    const cachePath = path.join(temporaryDirectory, "conversation-directory.json");
    try {
      const first = new ConversationDirectory({ cachePath });
      await first.enrich([
        conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
        conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
      ], {
        getStatus: () => ({ connectedAt: "generation-1" }),
        sendAction: vi.fn(async (action: string) => action === "get_friend_list"
          ? { status: "ok", retcode: 0, data: [{ user_id: 171419991, nickname: "好吃的猫头菇", remark: "猫老师" }] }
          : { status: "ok", retcode: 0, data: [{ group_id: 1030412235, group_name: "相当于你这周啥也没干啊" }] })
      });

      const second = new ConversationDirectory({ cachePath });
      const result = await second.enrich([
        conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
        conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
      ], {
        getStatus: () => ({ connectedAt: "generation-2" }),
        sendAction: vi.fn(async () => ({ status: "ok", retcode: 0, data: [] }))
      });

      expect(result[0]).toMatchObject({ title: "猫老师", nickname: "好吃的猫头菇", remark: "猫老师" });
      expect(result[1]).toMatchObject({ title: "相当于你这周啥也没干啊", groupName: "相当于你这周啥也没干啊" });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not treat a failed OneBot response as a ready directory", async () => {
    const sendAction = vi.fn(async () => ({ status: "failed", retcode: 100, data: null }));
    const directory = new ConversationDirectory();
    await directory.enrich(
      [conversation({ id: "group:7", userId: 1, groupId: 7, title: "产品讨论群" })],
      { getStatus: () => ({ connectedAt: "generation-1" }), sendAction }
    );

    expect(sendAction).toHaveBeenCalledTimes(4);
  });
});

function conversation(overrides: Partial<ConversationRecord> & Pick<ConversationRecord, "id" | "userId" | "title">): ConversationRecord {
  return {
    scope: overrides.groupId ? "user_group" : "private",
    messageCount: overrides.messages?.length ?? 0,
    lastAt: "2026-07-10T00:00:00.000Z",
    lastText: "",
    messages: [],
    ...overrides
  };
}
