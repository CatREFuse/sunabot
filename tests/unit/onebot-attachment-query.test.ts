import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import {
  resolveOneBotAttachment,
  resolveOneBotAttachmentFallback
} from "../../adapters/onebot/queryAdapter.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import { attachmentSourcePort } from "../../src/runtime/messagingAttachmentHelpers.js";
import type { AttachmentSourcePort } from "../../packages/contracts/media/media.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";

describe("OneBot attachment account routing", () => {
  it("uses the receiving QQ account for private file URL resolution", async () => {
    const sendAction = vi.fn(async () => ({
      status: "ok",
      retcode: 0,
      data: { url: "https://qq.example.test/fixture-private-pdf" }
    }));

    await expect(resolveOneBotAttachment({ sendAction }, {
      fileId: "fixture-private-pdf",
      file: "fixture.pdf",
      accountId: "fixture-secondary"
    } as Parameters<typeof resolveOneBotAttachment>[1])).resolves.toEqual({
      kind: "url",
      url: "https://qq.example.test/fixture-private-pdf",
      via: "private_file_url"
    });
    expect(sendAction).toHaveBeenCalledWith(
      "get_private_file_url",
      { file_id: "fixture-private-pdf" },
      "fixture-secondary"
    );
  });

  it("keeps the receiving QQ account on the get_file fallback", async () => {
    const sendAction = vi.fn(async () => ({
      status: "ok",
      retcode: 0,
      data: { base64: "JVBERi0xLjQK" }
    }));

    await expect(resolveOneBotAttachmentFallback({ sendAction }, {
      fileId: "fixture-private-pdf",
      file: "fixture.pdf",
      accountId: "fixture-secondary"
    } as Parameters<typeof resolveOneBotAttachmentFallback>[1])).resolves.toEqual({
      kind: "base64",
      base64: "JVBERi0xLjQK",
      via: "file_content"
    });
    expect(sendAction).toHaveBeenCalledWith(
      "get_file",
      { file_id: "fixture-private-pdf" },
      "fixture-secondary"
    );
  });

  it("keeps the secondary account when private URL lookup falls through to get_file", async () => {
    const sendAction = vi.fn()
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: {} })
      .mockResolvedValueOnce({
        status: "ok",
        retcode: 0,
        data: { base64: "JVBERi0xLjQK" }
      });

    await expect(resolveOneBotAttachment({ sendAction }, {
      fileId: "fixture-private-pdf",
      file: "fixture.pdf",
      accountId: "fixture-secondary"
    })).resolves.toEqual({
      kind: "base64",
      base64: "JVBERi0xLjQK",
      via: "file_content"
    });
    expect(sendAction.mock.calls).toEqual([
      [
        "get_private_file_url",
        { file_id: "fixture-private-pdf" },
        "fixture-secondary"
      ],
      [
        "get_file",
        { file_id: "fixture-private-pdf" },
        "fixture-secondary"
      ]
    ]);
  });

  it("keeps the secondary account when private URL lookup fails before get_file", async () => {
    const sendAction = vi.fn()
      .mockRejectedValueOnce(new Error("real fileUUID not found"))
      .mockResolvedValueOnce({
        status: "ok",
        retcode: 0,
        data: { base64: "JVBERi0xLjQK" }
      });

    await expect(resolveOneBotAttachment({ sendAction }, {
      fileId: "fixture-private-pdf",
      file: "fixture.pdf",
      accountId: "fixture-secondary"
    })).resolves.toEqual({
      kind: "base64",
      base64: "JVBERi0xLjQK",
      via: "file_content"
    });
    expect(sendAction.mock.calls).toEqual([
      [
        "get_private_file_url",
        { file_id: "fixture-private-pdf" },
        "fixture-secondary"
      ],
      [
        "get_file",
        { file_id: "fixture-private-pdf" },
        "fixture-secondary"
      ]
    ]);
  });

  it("binds the current turn account before the attachment service resolves a source", async () => {
    const resolveAttachment = vi.fn(async () => ({
      kind: "url" as const,
      url: "https://qq.example.test/fixture-private-pdf",
      via: "private_file_url" as const
    }));
    const resolveAttachmentFallback = vi.fn(async () => undefined);
    const port = {
      resolveAttachment,
      resolveAttachmentFallback
    } as unknown as MessagingPort & AttachmentSourcePort;
    const bound = attachmentSourcePort(port, " fixture-secondary ");

    await bound.resolveAttachment({
      accountId: "wrong-account",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    });
    expect(resolveAttachment).toHaveBeenCalledWith({
      accountId: "fixture-secondary",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    }, undefined);
    await bound.resolveAttachmentFallback({
      accountId: "wrong-account",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    });
    expect(resolveAttachmentFallback).toHaveBeenCalledWith({
      accountId: "fixture-secondary",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    }, undefined);
  });

  it("uses a token-only raw OneBot file event for get_file instead of its display name", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sunabot-file-token-"));
    try {
      const sendAction = vi.fn(async () => ({
        status: "ok",
        retcode: 0,
        data: { base64: Buffer.from("token-only attachment content").toString("base64") }
      }));
      const port = {
        resolveAttachment(input, options) {
          return resolveOneBotAttachment({ sendAction }, input, options);
        },
        resolveAttachmentFallback(input, options) {
          return resolveOneBotAttachmentFallback({ sendAction }, input, options);
        }
      } as unknown as MessagingPort & AttachmentSourcePort;
      const incoming = parseOneBotInboundMessage({
        post_type: "message",
        message_type: "private",
        message_id: 885282519,
        user_id: 2002,
        message: [{
          type: "file",
          data: {
            name: "湖北省耕地质量等级评价成果交接单.txt",
            file: "opaque-protocol-file-token"
          }
        }]
      })!;
      const service = new AttachmentService(temporaryDirectory, {
        cacheOptions: { minimumFreeBytes: 0 }
      });

      const [attachment] = await service.processIncoming(
        incoming.attachments ?? [],
        attachmentSourcePort(port, "fixture-secondary")
      );

      expect(attachment).toMatchObject({ status: "ready", format: "txt" });
      expect(sendAction).toHaveBeenCalledWith(
        "get_file",
        { file: "opaque-protocol-file-token" },
        "fixture-secondary"
      );
      expect(sendAction).not.toHaveBeenCalledWith(
        "get_file",
        { file: "湖北省耕地质量等级评价成果交接单.txt" },
        expect.anything()
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
