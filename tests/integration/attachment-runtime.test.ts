import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  hasIncomingReplyContent
} from "../../src/runtime/conversationMemoryHelpers.js";
import {
  sanitizeAttachmentForPersistence,
  selectRelevantConversationAttachments
} from "../../src/runtime/messagingAttachmentHelpers.js";
import {
  extractOneBotMessageDetails,
  parseOneBotInboundMessage
} from "../../adapters/onebot/inboundMessageAdapter.js";
import type { ParsedAttachment } from "../../services/media/attachments/types.js";
import type {
  ConversationRecord,
  ParsedIncomingMessage
} from "../../src/types.js";
import {
  ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES,
  ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES
} from "../../adapters/onebot/onebotGateway.js";

describe("attachment runtime integration", () => {
  it("caps ordinary OneBot events and rejects large inline media payloads", () => {
    expect(ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
    expect(ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
  });

  it("parses a current array-message file segment", () => {
    const incoming = parseOneBotInboundMessage({
      post_type: "message",
      message_type: "group",
      message_id: 1001,
      user_id: 2002,
      group_id: 3003,
      self_id: 4004,
      message: [
        { type: "text", data: { text: "请读一下" } },
        {
          type: "file",
          data: {
            name: "需求说明.docx",
            file_id: "array-file-id",
            file_size: 8192,
            busid: 102
          }
        }
      ]
    });

    expect(incoming?.text).toBe("请读一下 [文件：需求说明.docx]");
    expect(incoming?.attachments).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^attachment_[a-f0-9]{20}$/),
        source: "message",
        status: "pending",
        name: "需求说明.docx",
        fileId: "array-file-id",
        sizeBytes: 8192,
        busId: 102,
        groupId: 3003,
        userId: 2002
      })
    ]);
  });

  it("parses a current CQ file segment", () => {
    const incoming = parseOneBotInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 1002,
      user_id: 2002,
      raw_message: "[CQ:file,file=cq-file-id,name=发布计划.pdf,file_size=4096,busid=103]"
    });

    expect(incoming?.text).toBe("[文件：发布计划.pdf]");
    expect(incoming?.attachments).toEqual([
      expect.objectContaining({
        source: "message",
        status: "pending",
        name: "发布计划.pdf",
        fileToken: "cq-file-id",
        sizeBytes: 4096,
        busId: 103,
        userId: 2002
      })
    ]);
  });

  it("keeps OneBot file_id, file token, temporary URL and display name separate", () => {
    const incoming = parseOneBotInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 1004,
      user_id: 2002,
      message: [{
        type: "file",
        data: {
          name: "显示名称.pdf",
          file_id: "protocol-file-id",
          file: "protocol-file-token",
          url: "https://cdn.example.test/temporary.pdf",
          file_size: 64
        }
      }]
    });

    expect(incoming?.attachments[0]).toMatchObject({
      name: "显示名称.pdf",
      fileId: "protocol-file-id",
      fileToken: "protocol-file-token",
      url: "https://cdn.example.test/temporary.pdf",
      sizeBytes: 64
    });
  });

  it("rejects path-like and non-token file identifiers before runtime and persistence", () => {
    const unsafeIdentifiers = [
      "/private/tmp/qq-private.pdf",
      "C:\\NapCat\\temp\\qq-private.pdf",
      "relative\\windows\\qq-private.pdf",
      "https://qq.example.test/temporary.pdf",
      "protocol-token\u0000suffix"
    ];

    for (const identifier of unsafeIdentifiers) {
      const incoming = parseOneBotInboundMessage({
        post_type: "message",
        message_type: "private",
        message_id: 1005,
        user_id: 2002,
        message: [{
          type: "file",
          data: {
            name: "显示名称.pdf",
            file_id: identifier,
            file: identifier
          }
        }]
      });
      expect(incoming?.attachments[0]).not.toHaveProperty("fileId");
      expect(incoming?.attachments[0]).not.toHaveProperty("fileToken");

      const persisted = sanitizeAttachmentForPersistence({
        ...readyAttachment(`unsafe-${unsafeIdentifiers.indexOf(identifier)}`, "显示名称.pdf"),
        fileId: identifier,
        fileToken: identifier
      });
      expect(persisted.fileId).toBeUndefined();
      expect(persisted.fileToken).toBeUndefined();
    }

    const persistedTokens = sanitizeAttachmentForPersistence({
      ...readyAttachment("safe-identifiers", "显示名称.pdf"),
      fileId: "protocol-file-id",
      fileToken: "protocol-file-token"
    });
    expect(persistedTokens).toMatchObject({
      fileId: "protocol-file-id",
      fileToken: "protocol-file-token"
    });
  });

  it("extracts a quoted file from a get_msg response", () => {
    const details = extractOneBotMessageDetails({
      status: "ok",
      data: {
        message_id: 5678,
        group_id: 3003,
        user_id: 9009,
        sender: { card: "引用用户" },
        message: [
          { type: "text", data: { text: "原文件" } },
          {
            type: "file",
            data: {
              name: "会议材料.pptx",
              file_id: "quoted-file-id",
              file_size: 16384,
              busid: 104
            }
          }
        ]
      }
    }, { source: "quote" });

    expect(details.text).toBe("原文件 [文件：会议材料.pptx]");
    expect(details.sender.displayName).toBe("引用用户");
    expect(details.attachments).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^attachment_[a-f0-9]{20}$/),
        source: "quote",
        status: "pending",
        name: "会议材料.pptx",
        fileId: "quoted-file-id",
        sizeBytes: 16384,
        busId: 104,
        groupId: 3003,
        userId: 9009
      })
    ]);
  });

  it("treats a file-only message as replyable content", () => {
    const incoming = parseOneBotInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 1003,
      user_id: 2002,
      message: [{ type: "file", data: { name: "说明.txt", file_id: "only-file" } }]
    });

    expect(incoming).toBeDefined();
    expect(incoming?.text).toBe("[文件：说明.txt]");
    expect(hasIncomingReplyContent(incoming!)).toBe(true);
  });

  it("selects current files before named recent files and the latest recent message", () => {
    const current = readyAttachment("current", "当前文件.pdf");
    const olderNamed = readyAttachment("older-named", "预算终版.xlsx");
    const newerNamed = readyAttachment("newer-named", "预算终版.xlsx");
    const latestA = readyAttachment("latest-a", "会议记录.txt");
    const latestB = readyAttachment("latest-b", "附图.png");
    const record = conversationRecord([
      conversationMessage("11", [olderNamed]),
      conversationMessage("12", [newerNamed]),
      conversationMessage("13", [latestA, latestB])
    ]);

    expect(selectRelevantConversationAttachments(
      incomingMessage([current]),
      record,
      48,
      "请看预算终版.xlsx"
    )).toEqual([current]);

    expect(selectRelevantConversationAttachments(
      incomingMessage([]),
      record,
      48,
      "请看预算终版.xlsx"
    )).toEqual([newerNamed]);

    expect(selectRelevantConversationAttachments(
      incomingMessage([]),
      record,
      48,
      "继续分析"
    )).toEqual([latestA, latestB]);
  });

  it("includes attachment context in the user prompt", () => {
    const prompt = buildUserPrompt(
      incomingMessage([readyAttachment("current", "财务报告.pdf")]),
      "总结重点",
      false,
      { userId: "42", name: "猫老师" },
      "【财务报告.pdf】\n第一页：年度收入增长 20%。"
    );

    expect(prompt).toContain("文件内容：\n【财务报告.pdf】\n第一页：年度收入增长 20%。");
    expect(prompt).toContain("内容：总结重点");
  });

  it("removes temporary URLs and Base64 file identifiers before persistence", () => {
    const persisted = sanitizeAttachmentForPersistence({
      ...readyAttachment("secret", "截图.png"),
      url: "https://example.test/private-download-token",
      fileId: "data:application/octet-stream;base64,c2VjcmV0"
    });

    expect(persisted).not.toHaveProperty("url");
    expect(persisted.fileId).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("private-download-token");
    expect(JSON.stringify(persisted)).not.toContain("c2VjcmV0");

    const persistedUrlIdentifier = sanitizeAttachmentForPersistence({
      ...readyAttachment("secret-url", "下载文件.pdf"),
      fileId: "https://qq-cdn.example/file?token=SECRET-URL-881"
    });
    expect(persistedUrlIdentifier.fileId).toBeUndefined();
    expect(JSON.stringify(persistedUrlIdentifier)).not.toContain("SECRET-URL-881");

    const persistedShortText = sanitizeAttachmentForPersistence({
      ...readyAttachment("short-text", "校验.txt"),
      textPreview: "完整的小文件正文",
      textCharacterCount: 8
    });
    expect(persistedShortText.textPreview).toBe("完整的小…");
    expect(persistedShortText.textPreview).not.toContain("文件正文");
  });
});

function readyAttachment(id: string, name: string): ParsedAttachment {
  return {
    id,
    source: "message",
    name,
    status: "ready",
    cacheKey: `sha256-${id}`
  };
}

function incomingMessage(attachments: ParsedAttachment[]): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "private",
    messageId: 99,
    time: "2026-07-11T00:00:00.000Z",
    userId: 7,
    sender: { id: "7", displayName: "7" },
    text: "",
    media: [],
    attachments,
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function conversationMessage(id: string, attachments: ParsedAttachment[]) {
  return {
    id,
    role: "user" as const,
    text: "[文件]",
    at: `2026-07-10T00:00:${id}Z`,
    userId: 7,
    attachments
  };
}

function conversationRecord(messages: ConversationRecord["messages"]): ConversationRecord {
  return {
    id: "private:7",
    scope: "private",
    title: "用户 7",
    userId: 7,
    messageCount: messages.length,
    lastAt: messages.at(-1)?.at ?? "2026-07-10T00:00:00Z",
    lastText: messages.at(-1)?.text ?? "",
    messages
  };
}
