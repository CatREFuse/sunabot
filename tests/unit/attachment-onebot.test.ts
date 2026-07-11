// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { OneBotMessageSegment } from "../../adapters/onebot/protocol.js";
import {
  extractOneBotAttachments,
  sanitizeAttachmentName
} from "../../adapters/onebot/inboundMessageAdapter.js";

describe("OneBot attachment extraction", () => {
  it("extracts and normalizes a Chinese file segment", () => {
    const message: OneBotMessageSegment[] = [{
      type: "file",
      data: {
        file: "ignored-display-token",
        name: "  研究报告/终稿.pdf  ",
        file_id: "file-中文-1",
        file_size: "1048576",
        url: "https://cdn.example.test/files/report.pdf?token=secret",
        busid: "42"
      }
    }];

    const first = extractOneBotAttachments(message, {
      source: "message",
      messageId: 9001,
      groupId: 12345,
      userId: 67890
    });
    const second = extractOneBotAttachments(message, {
      source: "message",
      messageId: 9001,
      groupId: 12345,
      userId: 67890
    });

    expect(first).toEqual(second);
    expect(first).toEqual([{
      id: expect.stringMatching(/^attachment_[a-f0-9]{20}$/),
      source: "message",
      name: "研究报告_终稿.pdf",
      fileId: "file-中文-1",
      sizeBytes: 1048576,
      url: "https://cdn.example.test/files/report.pdf?token=secret",
      busId: 42,
      groupId: 12345,
      userId: 67890
    }]);
  });

  it("decodes CQ parameters and uses an HTTP file value as the URL", () => {
    const attachments = extractOneBotAttachments(
      "说明[CQ:file,file=https://cdn.example.test/%E8%B5%84%E6%96%99.txt,name=资料&amp;清单&#44;v2&#91;终&#93;.txt,file_size=12,busid=7]尾部",
      { source: "quote", messageId: "quoted-2" }
    );

    expect(attachments).toEqual([{
      id: expect.stringMatching(/^attachment_[a-f0-9]{20}$/),
      source: "quote",
      name: "资料&清单,v2[终].txt",
      sizeBytes: 12,
      url: "https://cdn.example.test/%E8%B5%84%E6%96%99.txt",
      busId: 7
    }]);
  });

  it("keeps useful metadata when optional fields are missing", () => {
    const attachments = extractOneBotAttachments([
      { type: "file" },
      { type: "file", data: { file_id: "only-id" } },
      { type: "file", data: { file: "fallback-name.md", file_size: "invalid", busid: -1 } }
    ]);

    expect(attachments.map(({ id: _id, ...attachment }) => attachment)).toEqual([
      { source: "message", name: "未命名文件" },
      { source: "message", name: "only-id", fileId: "only-id" },
      { source: "message", name: "fallback-name.md", fileId: "fallback-name.md" }
    ]);
  });

  it("deduplicates stably and merges missing fields from later copies", () => {
    const attachments = extractOneBotAttachments([
      { type: "file", data: { name: "first.txt", file_id: "same-file", file_size: 10 } },
      {
        type: "file",
        data: {
          name: "second.txt",
          file_id: "same-file",
          url: "https://cdn.example.test/same-file",
          busid: 9
        }
      },
      { type: "file", data: { name: "other.txt", file_id: "other-file" } }
    ], { messageId: 3 });

    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      name: "first.txt",
      fileId: "same-file",
      sizeBytes: 10,
      url: "https://cdn.example.test/same-file",
      busId: 9
    });
    expect(attachments[1]).toMatchObject({ name: "other.txt", fileId: "other-file" });
  });

  it("ignores non-file segments in a mixed message", () => {
    const attachments = extractOneBotAttachments([
      { type: "text", data: { text: "请读这个文件" } },
      { type: "image", data: { url: "https://cdn.example.test/image.png" } },
      { type: "reply", data: { id: "100" } },
      { type: "file", data: { name: "answer.json", file_id: "answer-id" } }
    ], { userId: 7 });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      source: "message",
      name: "answer.json",
      fileId: "answer-id",
      userId: 7
    });
  });

  it("removes path separators and control characters and limits the display name", () => {
    expect(sanitizeAttachmentName("  ../目录\\报\u0000告.txt\n ")).toBe(".._目录_报告.txt");
    expect([...sanitizeAttachmentName("文".repeat(220))]).toHaveLength(180);
    expect(sanitizeAttachmentName("\u0000\n\t")).toBe("未命名文件");
  });
});
