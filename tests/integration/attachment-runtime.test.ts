import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  extractMessageDetailsFromActionPayload,
  hasIncomingReplyContent,
  parseIncomingMessage,
  sanitizeAttachmentForPersistence,
  selectRelevantConversationAttachments
} from "../../src/runtime.js";
import type { ParsedAttachment } from "../../services/media/attachments/types.js";
import type {
  ConversationRecord,
  OneBotEvent,
  ParsedIncomingMessage
} from "../../src/types.js";
import {
  ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES,
  ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES,
  ONEBOT_UNAUTHENTICATED_MAX_PAYLOAD_BYTES
} from "../../adapters/onebot/onebotGateway.js";
import { FILE_SIZE_LIMIT_BYTES } from "../../services/media/attachments/limits.js";

describe("attachment runtime integration", () => {
  it("allows an authenticated bounded OneBot payload large enough for a 256 MiB Base64 fallback", () => {
    const maximumBase64Characters = 4 * Math.ceil(FILE_SIZE_LIMIT_BYTES / 3);
    expect(ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES).toBeGreaterThan(maximumBase64Characters + 1024 * 1024);
    expect(ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES).toBe(384 * 1024 * 1024);
    expect(ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES).toBeGreaterThan(maximumBase64Characters + 1024 * 1024);
    expect(ONEBOT_UNAUTHENTICATED_MAX_PAYLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it("parses a current array-message file segment", () => {
    const incoming = parseIncomingMessage({
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

    expect(incoming?.text).toBe("请读一下");
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
    const incoming = parseIncomingMessage({
      post_type: "message",
      message_type: "private",
      message_id: 1002,
      user_id: 2002,
      raw_message: "[CQ:file,file=cq-file-id,name=发布计划.pdf,file_size=4096,busid=103]"
    });

    expect(incoming?.text).toBe("");
    expect(incoming?.attachments).toEqual([
      expect.objectContaining({
        source: "message",
        status: "pending",
        name: "发布计划.pdf",
        fileId: "cq-file-id",
        sizeBytes: 4096,
        busId: 103,
        userId: 2002
      })
    ]);
  });

  it("extracts a quoted file from a get_msg response", () => {
    const details = extractMessageDetailsFromActionPayload({
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

    expect(details.text).toBe("原文件");
    expect(details.senderName).toBe("引用用户");
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
    const incoming = parseIncomingMessage({
      post_type: "message",
      message_type: "private",
      message_id: 1003,
      user_id: 2002,
      message: [{ type: "file", data: { name: "说明.txt", file_id: "only-file" } }]
    });

    expect(incoming).toBeDefined();
    expect(incoming?.text).toBe("");
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
      [],
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
  const event: OneBotEvent = {
    post_type: "message",
    message_type: "private",
    message_id: 99,
    user_id: 7
  };
  return {
    scope: "private",
    userId: 7,
    text: "",
    imageUrls: [],
    attachments,
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false,
    event
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
