// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { CacheStore } from "../../services/media/attachments/cache.js";
import { closeEmojiStores } from "../../src/emojis/emojiStore.js";
import {
  currentAndQuotedMediaSources,
  providerChatMediaForIncoming
} from "../../src/runtime/chatMedia.js";
import { buildUserPrompt } from "../../src/runtime/conversationMemoryHelpers.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";
import { testTempRoot } from "./test-temp-root.js";
import { getWorkspacePath } from "../../src/config.js";

const TEST_ROOT = testTempRoot("chat-media-runtime");
let pngBytes: Buffer;

beforeAll(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  pngBytes = await sharp({
    create: {
      width: 4,
      height: 5,
      channels: 4,
      background: { r: 50, g: 60, b: 70, alpha: 1 }
    }
  }).png().toBuffer();
});

afterAll(async () => {
  closeEmojiStores();
  closeApplicationDataStores();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("current-turn chat media capability", () => {
  it("binds only current and explicitly quoted message handles and shows them in the prompt", () => {
    const incoming = incomingMessage("171419991");
    incoming.attachments = [{
      id: "current-file",
      source: "message",
      name: "current.txt",
      status: "ready"
    }];
    incoming.quoteReferences = [{
      messageId: 78,
      text: "quoted",
      media: [inlineImage()],
      imageUrls: [inlineImage().url],
      attachments: [{
        id: "quoted-file",
        source: "quote",
        name: "quoted.txt",
        status: "ready"
      }]
    }];

    expect([...currentAndQuotedMediaSources(incoming).keys()]).toEqual([
      "message:77:image:0",
      "message:77:file:0",
      "message:78:image:0",
      "message:78:file:0"
    ]);
    const prompt = buildUserPrompt(
      incoming,
      incoming.text,
      true,
      { userId: "171419991", name: "Admin" }
    );
    expect(prompt).toContain("message:77:image:0");
    expect(prompt).toContain("message:77:file:0");
    expect(prompt).toContain("message:78:image:0");
    expect(prompt).toContain("message:78:file:0");
  });

  it("exposes export to real QQ turns while limiting emoji import to administrator QQ chats", async () => {
    const root = await fs.mkdtemp(path.join(TEST_ROOT, "gate-"));
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "arona";
    config.persona.agentWorkspace = path.join(root, "agent-workspace");
    const cache = new CacheStore(path.join(root, "cache"), { minimumFreeBytes: 0 });
    await cache.initialize();

    const administrator = incomingMessage(config.bot.adminQq, "arona");
    const adminPort = providerChatMediaForIncoming(config, administrator, undefined, cache);
    expect(adminPort?.export).toBeTypeOf("function");
    expect(adminPort?.importEmoji).toBeTypeOf("function");

    const ordinary = incomingMessage("171419992", "arona");
    const ordinaryPort = providerChatMediaForIncoming(config, ordinary, undefined, cache);
    expect(ordinaryPort?.export).toBeTypeOf("function");
    expect(ordinaryPort?.importEmoji).toBeUndefined();

    const groupAdmin = {
      ...administrator,
      scope: "user_group" as const,
      groupId: 9988
    };
    expect(providerChatMediaForIncoming(config, groupAdmin, undefined, cache)?.importEmoji)
      .toBeTypeOf("function");
    expect(providerChatMediaForIncoming(config, {
      ...ordinary,
      scope: "user_group",
      groupId: 9988
    }, undefined, cache)?.importEmoji).toBeUndefined();
    expect(providerChatMediaForIncoming(config, { ...administrator, agentId: "plana" }, undefined, cache))
      .toBeUndefined();
    expect(providerChatMediaForIncoming(config, administrator, "override", cache))
      .toBeUndefined();
    expect(providerChatMediaForIncoming(config, { ...administrator, media: [] }, undefined, cache))
      .toBeUndefined();
  });

  it("imports an administrator group image atomically with hash naming and idempotent deduplication", async () => {
    await fs.mkdir(getWorkspacePath(), { recursive: true });
    const root = await fs.mkdtemp(path.join(getWorkspacePath(), ".test-chat-media-emoji-"));
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "koharu";
    config.persona.agentWorkspace = path.join(root, "agent-workspace");
    const cache = new CacheStore(path.join(root, "cache"), { minimumFreeBytes: 0 });
    await cache.initialize();
    const incoming = incomingMessage(config.bot.adminQq, "koharu");
    incoming.scope = "user_group";
    incoming.groupId = 9988;
    const port = providerChatMediaForIncoming(config, incoming, undefined, cache)!;

    const first = await port.importEmoji!({
      handle: "message:77:image:0",
      key: "开心"
    });
    const second = await port.importEmoji!({
      handle: "message:77:image:0",
      key: "开心"
    });
    const catalogPath = path.join(config.persona.agentWorkspace, "workbench", "emoji", "emojis.jsonl");
    const catalog = await fs.readFile(catalogPath, "utf8");

    expect(first).toMatchObject({
      ok: true,
      key: "开心",
      fileName: `emoji-${first.sha256}.png`,
      width: 1024,
      height: 1024,
      deduplicated: false
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(catalog.trim().split("\n")).toHaveLength(1);
    expect(catalog).toContain(first.fileName);
    await expect(fs.readFile(
      path.join(config.persona.agentWorkspace, "workbench", "emoji", first.fileName)
    )).resolves.toHaveLength(first.byteLength);
    closeEmojiStores();
    closeApplicationDataStores();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("expires the port without publishing when the turn is no longer current", async () => {
    const root = await fs.mkdtemp(path.join(TEST_ROOT, "expired-"));
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "arona";
    config.persona.agentWorkspace = path.join(root, "agent-workspace");
    const cache = new CacheStore(path.join(root, "cache"), { minimumFreeBytes: 0 });
    await cache.initialize();
    let current = true;
    const port = providerChatMediaForIncoming(
      config,
      incomingMessage(config.bot.adminQq, "arona"),
      undefined,
      cache,
      () => current
    )!;
    current = false;

    await expect(port.export({ handle: "message:77:image:0" }))
      .rejects.toThrow("CHAT_MEDIA_TURN_EXPIRED");
  });
});

function incomingMessage(userId: string, agentId = "plana"): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    agentId,
    accountId: "primary",
    scope: "private",
    messageId: 77,
    time: "2026-07-25T00:00:00.000Z",
    userId: Number(userId),
    selfId: 12345678,
    sender: {
      id: userId,
      displayName: "User"
    },
    text: "保存这张图",
    media: [inlineImage()],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function inlineImage() {
  return {
    schemaVersion: 1 as const,
    kind: "image" as const,
    source: "inline_data" as const,
    url: `data:image/png;base64,${pngBytes.toString("base64")}`
  };
}
