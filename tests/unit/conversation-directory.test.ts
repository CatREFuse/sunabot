import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeConversationDirectoryPort } from "../../packages/testkit/fakeMessagingPort.js";
import { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import type { ConversationRecord } from "../../src/types.js";

describe("ConversationDirectory", () => {
  it("uses recognizable friend and group names while keeping identity fields", async () => {
    const gateway = new FakeConversationDirectoryPort({
      friendsReady: true,
      groupsReady: true,
      friends: [{ userId: 171419991, nickname: "好吃的猫头菇", remark: "猫老师" }],
      groups: [{ groupId: 1030412235, groupName: "相当于你这周啥也没干啊" }]
    });
    const directory = new ConversationDirectory();

    const result = await directory.enrich([
      conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
      conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
    ], gateway);

    expect(result[0]).toMatchObject({ title: "猫老师", nickname: "好吃的猫头菇", remark: "猫老师" });
    expect(result[1]).toMatchObject({ title: "相当于你这周啥也没干啊", groupName: "相当于你这周啥也没干啊" });
    await directory.enrich(result, gateway);
    expect(gateway.loadCount).toBe(1);
  });

  it("loads display names from each conversation account", async () => {
    const gateway = new FakeConversationDirectoryPort({
      friendsReady: true,
      groupsReady: true,
      friends: [],
      groups: [{ groupId: 7, groupName: "Plana 群" }]
    });
    gateway.setAccountSnapshots("qq-koharu", {
      friendsReady: true,
      groupsReady: true,
      friends: [],
      groups: [{ groupId: 7, groupName: "Koharu 群" }]
    });
    const directory = new ConversationDirectory();

    const result = await directory.enrich([
      conversation({ id: "group:7", accountId: "primary", userId: 1, groupId: 7, title: "7" }),
      conversation({ id: "account:qq-koharu:group:7", accountId: "qq-koharu", userId: 1, groupId: 7, title: "7" })
    ], gateway);

    expect(result[0]?.title).toBe("Plana 群");
    expect(result[1]?.title).toBe("Koharu 群");
    expect(gateway.loadedAccountIds).toEqual(["primary", "qq-koharu"]);
  });

  it("keeps account-specific display names across restarts", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-directory-accounts-"));
    const cachePath = path.join(temporaryDirectory, "conversation-directory.json");
    const records = [
      conversation({ id: "group:7", accountId: "primary", userId: 1, groupId: 7, title: "7" }),
      conversation({ id: "account:qq-koharu:group:7", accountId: "qq-koharu", userId: 1, groupId: 7, title: "7" })
    ];
    try {
      const firstGateway = new FakeConversationDirectoryPort({
        friendsReady: true,
        groupsReady: true,
        friends: [],
        groups: [{ groupId: 7, groupName: "Plana 群" }]
      });
      firstGateway.setAccountSnapshots("qq-koharu", {
        friendsReady: true,
        groupsReady: true,
        friends: [],
        groups: [{ groupId: 7, groupName: "Koharu 群" }]
      });
      await new ConversationDirectory({ cachePath }).enrich(records, firstGateway);

      const secondGateway = new FakeConversationDirectoryPort({
        friendsReady: true,
        groupsReady: true,
        friends: [],
        groups: []
      });
      secondGateway.setAccountSnapshots("qq-koharu", {
        friendsReady: true,
        groupsReady: true,
        friends: [],
        groups: []
      });
      const result = await new ConversationDirectory({ cachePath }).enrich(records, secondGateway);

      expect(result[0]?.title).toBe("Plana 群");
      expect(result[1]?.title).toBe("Koharu 群");
      await expect(fs.readFile(cachePath, "utf8")).resolves.toContain('"version": 2');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reads a legacy v1 cache only for the primary account", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-directory-v1-"));
    const cachePath = path.join(temporaryDirectory, "conversation-directory.json");
    try {
      await fs.writeFile(cachePath, JSON.stringify({
        version: 1,
        friends: [],
        groups: [{ groupId: 7, groupName: "旧版主账号群" }]
      }));
      const result = new ConversationDirectory({ cachePath }).describe([
        conversation({ id: "group:7", accountId: "primary", userId: 1, groupId: 7, title: "7" }),
        conversation({ id: "account:qq-koharu:group:7", accountId: "qq-koharu", userId: 1, groupId: 7, title: "7" })
      ]);

      expect(result[0]?.title).toBe("旧版主账号群");
      expect(result[1]?.title).toBe("群 7");
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("falls back to the latest message nickname and readable stored titles", async () => {
    const gateway = new FakeConversationDirectoryPort();
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
    const gateway = new FakeConversationDirectoryPort();
    gateway.snapshots.push(
      { friendsReady: false, groupsReady: false, friends: [], groups: [] },
      { friendsReady: true, groupsReady: true, friends: [], groups: [{ groupId: 7, groupName: "七号讨论组" }] }
    );
    const directory = new ConversationDirectory();
    const result = await directory.enrich(
      [conversation({ id: "group:7", userId: 1, groupId: 7, title: "7" })],
      gateway
    );

    expect(result[0]?.title).toBe("七号讨论组");
    expect(gateway.loadCount).toBe(2);
  });

  it("keeps recognizable names across restarts when OneBot temporarily returns empty directories", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-directory-"));
    const cachePath = path.join(temporaryDirectory, "conversation-directory.json");
    try {
      const first = new ConversationDirectory({ cachePath });
      await first.enrich([
        conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
        conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
      ], new FakeConversationDirectoryPort({
        friendsReady: true,
        groupsReady: true,
        friends: [{ userId: 171419991, nickname: "好吃的猫头菇", remark: "猫老师" }],
        groups: [{ groupId: 1030412235, groupName: "相当于你这周啥也没干啊" }]
      }));

      const second = new ConversationDirectory({ cachePath });
      const result = await second.enrich([
        conversation({ id: "private:171419991", userId: 171419991, title: "171419991" }),
        conversation({ id: "group:1030412235", userId: 1, groupId: 1030412235, title: "1030412235" })
      ], new FakeConversationDirectoryPort({
        friendsReady: true,
        groupsReady: true,
        friends: [],
        groups: []
      }));

      expect(result[0]).toMatchObject({ title: "猫老师", nickname: "好吃的猫头菇", remark: "猫老师" });
      expect(result[1]).toMatchObject({ title: "相当于你这周啥也没干啊", groupName: "相当于你这周啥也没干啊" });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not treat a failed OneBot response as a ready directory", async () => {
    const gateway = new FakeConversationDirectoryPort();
    const directory = new ConversationDirectory();
    await directory.enrich(
      [conversation({ id: "group:7", userId: 1, groupId: 7, title: "产品讨论群" })],
      gateway
    );

    expect(gateway.loadCount).toBe(2);
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
