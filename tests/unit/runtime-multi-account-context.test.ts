// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  MessageDetailsV1,
  MessageLookupContextV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { inboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import { runtime_performHydrateConversationRecords } from "../../src/runtime/intake.js";
import { runtime_hydrateConversationIdentities } from "../../src/runtime/lifecycle.js";
import {
  runtime_attachReplyReferences,
  runtime_loadMessageDetails,
  runtime_loadQuoteReferences
} from "../../src/runtime/replyContext.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";

describe("runtime multi-account context", () => {
  it("uses the incoming account when loading referenced images and files", async () => {
    const details: MessageDetailsV1 = {
      text: "引用内容",
      media: [{
        schemaVersion: 1,
        kind: "image",
        source: "remote_url",
        url: "https://example.test/quoted.png"
      }],
      attachments: [{
        id: "quoted-file",
        source: "quote",
        name: "quoted.pdf",
        fileId: "file-quoted",
        status: "pending"
      }],
      replyMessageIds: [],
      sender: { id: "99887766", nickname: "引用发送者" }
    };
    const getMessage = vi.fn(async () => details);
    const gateway = { getMessage } as unknown as MessagingPort;
    const host = {
      loadMessageDetails(
        currentGateway: MessagingPort,
        messageId: number,
        context?: MessageLookupContextV1
      ) {
        return runtime_loadMessageDetails.call(host as never, currentGateway, messageId, context);
      }
    };
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      agentId: "arona",
      accountId: "secondary-a",
      scope: "user_group",
      messageId: 2002,
      time: "2026-07-14T09:00:00.000Z",
      userId: 11223344,
      groupId: 55667788,
      selfId: 12345678,
      sender: { id: "11223344" },
      text: "看看引用里的图片和文件",
      media: [],
      attachments: [],
      replyMessageIds: [1001],
      quoteReferences: [],
      mentionedSelf: true
    };

    await runtime_attachReplyReferences.call(host as never, incoming, gateway);

    expect(getMessage).toHaveBeenCalledWith(1001, {
      accountId: "secondary-a",
      source: "quote",
      groupId: 55667788,
      userId: 11223344
    });
    expect(inboundImageUrls(incoming)).toEqual(["https://example.test/quoted.png"]);
    expect(incoming.attachments).toEqual([expect.objectContaining({
      id: "quoted-file",
      fileId: "file-quoted"
    })]);
    expect(incoming.quoteReferences).toEqual([expect.objectContaining({
      messageId: 1001,
      imageUrls: ["https://example.test/quoted.png"],
      attachments: [expect.objectContaining({ id: "quoted-file" })]
    })]);
  });

  it("uses the conversation account when hydrating stored sender identities", async () => {
    const message: ConversationRecord["messages"][number] = {
      id: "1001",
      role: "user",
      text: "历史消息",
      at: "2026-07-14T09:00:00.000Z",
      userId: 11223344,
      groupId: 55667788
    };
    const record: ConversationRecord = {
      id: "account:secondary-a:group:55667788",
      agentId: "arona",
      accountId: "secondary-a",
      scope: "user_group",
      title: "群聊",
      userId: 11223344,
      groupId: 55667788,
      selfId: 12345678,
      messageCount: 1,
      lastAt: message.at,
      lastText: message.text,
      messages: [message]
    };
    const resolve = vi.fn(async () => ({
      userId: "11223344",
      nickname: "账号昵称",
      card: "账号群名片",
      displayName: "账号群名片"
    }));
    const persistConversationRecords = vi.fn();
    const host = {
      conversationRecords: new Map([[record.id, record]]),
      senderNameResolver: { resolve },
      persistConversationRecords
    };

    await runtime_hydrateConversationIdentities.call(host as never, record.id, {} as MessagingPort);

    expect(resolve).toHaveBeenCalledWith({
      accountId: "secondary-a",
      userId: 11223344,
      groupId: 55667788,
      sender: { id: "11223344" }
    }, expect.anything());
    expect(message).toMatchObject({
      senderNickname: "账号昵称",
      senderCard: "账号群名片",
      senderName: "账号群名片"
    });
    expect(persistConversationRecords).toHaveBeenCalledOnce();
  });

  it("uses the stored account for message and nested quote hydration after reconnect", async () => {
    const message: ConversationRecord["messages"][number] = {
      id: "2002",
      role: "user",
      text: "[文件]",
      at: new Date().toISOString(),
      userId: 11223344,
      groupId: 55667788
    };
    const record: ConversationRecord = {
      id: "account:secondary-a:group:55667788",
      agentId: "arona",
      accountId: "secondary-a",
      scope: "user_group",
      title: "群聊",
      userId: 11223344,
      groupId: 55667788,
      selfId: 12345678,
      messageCount: 1,
      lastAt: message.at,
      lastText: message.text,
      messages: [message]
    };
    const getMessage = vi.fn(async (messageId: number): Promise<MessageDetailsV1> => messageId === 2002
      ? {
          text: "带附件的消息",
          media: [],
          attachments: [{
            id: "main-file",
            source: "message",
            name: "main.pdf",
            fileId: "main-file-id",
            status: "pending"
          }],
          replyMessageIds: [1001],
          sender: { id: "11223344" }
        }
      : {
          text: "嵌套引用",
          media: [{
            schemaVersion: 1,
            kind: "image",
            source: "remote_url",
            url: "https://example.test/nested.png"
          }],
          attachments: [{
            id: "nested-file",
            source: "quote",
            name: "nested.pdf",
            fileId: "nested-file-id",
            status: "pending"
          }],
          replyMessageIds: [],
          sender: { id: "99887766" }
        });
    const gateway = {
      getStatus: () => ({ connected: true, connections: 1, selfIds: ["12345678"], connectedAt: "generation-1" }),
      getMessage,
      resolveAttachment: vi.fn(),
      resolveAttachmentFallback: vi.fn()
    } as unknown as MessagingPort;
    const persistConversationRecords = vi.fn();
    const refreshAttachmentCacheReferences = vi.fn(async () => undefined);
    const processIncoming = vi.fn(async (attachments: ConversationRecord["messages"][number]["attachments"]) =>
      (attachments ?? []).map((attachment) => ({ ...attachment, status: "ready" as const })));
    const host = {
      hydrationGeneration: "",
      hydrationFailures: new Map(),
      hydratedMessageIds: new Set<string>(),
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 20,
      loadMessageDetails(
        currentGateway: MessagingPort,
        messageId: number,
        context?: MessageLookupContextV1
      ) {
        return runtime_loadMessageDetails.call(host as never, currentGateway, messageId, context);
      },
      loadQuoteReferences(
        currentGateway: MessagingPort,
        messageIds: number[],
        context?: MessageLookupContextV1
      ) {
        return runtime_loadQuoteReferences.call(host as never, currentGateway, messageIds, context);
      },
      attachmentService: { processIncoming },
      persistConversationRecords,
      refreshAttachmentCacheReferences
    };

    await runtime_performHydrateConversationRecords.call(host as never, gateway);

    expect(getMessage).toHaveBeenNthCalledWith(1, 2002, {
      accountId: "secondary-a",
      source: "message",
      groupId: 55667788,
      userId: 11223344
    });
    expect(getMessage).toHaveBeenNthCalledWith(2, 1001, {
      accountId: "secondary-a",
      source: "quote",
      groupId: 55667788,
      userId: 11223344
    });
    expect(message).toMatchObject({
      imageUrls: ["https://example.test/nested.png"],
      attachments: [expect.objectContaining({ id: "main-file", status: "ready" })],
      quoteReferences: [expect.objectContaining({
        messageId: 1001,
        attachments: [expect.objectContaining({ id: "nested-file", status: "ready" })]
      })]
    });
    expect(processIncoming).toHaveBeenCalledOnce();
    expect(persistConversationRecords).toHaveBeenCalledOnce();
    expect(refreshAttachmentCacheReferences).toHaveBeenCalledOnce();
  });
});
