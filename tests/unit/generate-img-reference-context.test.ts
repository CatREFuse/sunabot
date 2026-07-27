// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { toContextChatMessage } from "../../src/runtime/conversationMemoryHelpers.js";
import {
  runtime_generateImgReferenceContext,
  runtime_processDeferredToolJob
} from "../../src/runtime/reply.js";
import { runtime_collectSelfieChatReferenceImages } from "../../src/runtime/selfie.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";
import { runGenerateImg } from "../../services/tools/generateImgTool.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("generate_img historical reference context", () => {
  it("exposes stable media handles to the model", () => {
    const message = conversationMessage({
      id: "generated-1",
      role: "assistant",
      imageUrls: ["/generated-images/agents/arona/result.png"]
    });

    expect(toContextChatMessage(message, false, { userId: "9", name: "Admin" }).content)
      .toContain("message:generated-1:image:0");
  });

  it("passes a sent catalog emoji handle through the next generate_img call", async () => {
    const incoming = incomingMessage();
    const emojiUrl = "/generated-images/conversation-assets/agents/arona/emoji.png";
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 2,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "sent-catalog-emoji",
          role: "assistant",
          sequence: 0,
          imageUrls: [emojiUrl]
        }),
        conversationMessage({
          id: String(incoming.messageId),
          role: "user",
          sequence: 1
        })
      ]
    };
    const references = runtime_generateImgReferenceContext.call({
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48
    } as never, incoming, 2);
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/output.png",
      filePath: "/tmp/output.png"
    }));

    await runGenerateImg({
      prompt: "use the exact sent sticker",
      referenceMediaHandles: ["message:sent-catalog-emoji:image:0"],
      referenceImageSource: "none"
    }, createAdminTestConfig(process.cwd()).bot, generateImage, {
      imageReferences: references
    });

    expect(generateImage.mock.calls[0]?.[3]).toEqual([emojiUrl]);
  });

  it("keeps explicit handles conversation-scoped while automatic history stays on the same user", () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: "user_group",
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 6,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({ id: "generated-old", role: "assistant", sequence: 0, userId: 100, imageUrls: ["/generated-images/agents/arona/old.png"] }),
        conversationMessage({ id: "original", role: "user", sequence: 1, userId: 100, imageUrls: ["https://example.test/original.png"] }),
        conversationMessage({ id: "other-user", role: "user", sequence: 2, userId: 200, imageUrls: ["https://example.test/other.png"] }),
        conversationMessage({ id: "generated", role: "assistant", sequence: 3, userId: 100, imageUrls: ["/generated-images/agents/arona/generated.png"] }),
        conversationMessage({ id: String(incoming.messageId), role: "user", sequence: 4, userId: 100 }),
        conversationMessage({ id: "later", role: "assistant", sequence: 5, userId: 100, imageUrls: ["/generated-images/agents/arona/later.png"] })
      ]
    };
    const host = {
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48
    };

    const references = runtime_generateImgReferenceContext.call(host as never, incoming, 4);

    expect(references.currentImageUrls).toEqual([]);
    expect(references.previousOutputImageUrls).toEqual(["/generated-images/agents/arona/generated.png"]);
    expect(references.historyImageUrls).toEqual([
      "/generated-images/agents/arona/generated.png",
      "https://example.test/original.png",
      "/generated-images/agents/arona/old.png"
    ]);
    expect(references.mediaByHandle).toMatchObject({
      "message:generated:image:0": "/generated-images/agents/arona/generated.png",
      "message:other-user:image:0": "https://example.test/other.png"
    });
    expect(references.mediaByHandle).not.toHaveProperty("message:later:image:0");
  });

  it("uses the dispatch-time media snapshot when the deferred image job runs", async () => {
    const incoming = incomingMessage();
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/output.png",
      filePath: "/tmp/output.png"
    }));
    const host = {
      config: createAdminTestConfig(process.cwd()),
      getProvider: () => ({ generateImage }),
      conversationRecords: new Map(),
      contextMessageLimit: () => 48
    };
    const result = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-image-1",
      toolName: "generate_img",
      arguments: {
        prompt: "edit the selected image",
        referenceImageUrls: null,
        referenceImagePaths: ["references/workbench.png"],
        referenceMediaHandles: ["message:generated:image:0"],
        referenceImageSource: "none"
      },
      originalRequest: {
        incoming,
        captureSequence: 4,
        imageReferences: {
          mediaByHandle: {
            "message:generated:image:0": "/generated-images/agents/arona/generated.png"
          }
        },
        workbenchImagesByPath: {
          "references/workbench.png": "/generated-images/conversation-assets/agents/arona/workbench.png"
        }
      }
    } as never, new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(generateImage).toHaveBeenCalledWith(
      "edit the selected image",
      expect.any(String),
      expect.any(String),
      [
        "/generated-images/agents/arona/generated.png",
        "/generated-images/conversation-assets/agents/arona/workbench.png"
      ],
      expect.objectContaining({ stage: "async_image_tool" })
    );
  });

  it("keeps deferred selfie chat references inside the dispatch-time debounce boundary", async () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 4,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "inside-boundary",
          role: "user",
          sequence: 1,
          imageUrls: ["https://example.test/inside.png"]
        }),
        conversationMessage({
          id: "after-handoff",
          role: "user",
          sequence: 3,
          imageUrls: ["https://example.test/after.png"]
        })
      ]
    };
    const runSelfie = vi.fn(async () => ({ ok: true, image: { url: "/selfie.png" } }));
    const host = {
      config: createAdminTestConfig(process.cwd()),
      getProvider: () => ({}),
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48,
      collectSelfieChatReferenceImages: runtime_collectSelfieChatReferenceImages,
      runSelfie
    };

    const result = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-selfie-1",
      toolName: "selfie",
      arguments: { prompt: "take a selfie" },
      originalRequest: {
        incoming,
        captureSequence: 99,
        contextThroughSequence: 2
      }
    } as never, new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(runSelfie).toHaveBeenCalledOnce();
    expect(runSelfie.mock.calls[0]?.[2]).toMatchObject({
      chatReferenceImageUrls: ["https://example.test/inside.png"]
    });

    runSelfie.mockClear();
    const legacyResult = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-selfie-legacy",
      toolName: "selfie",
      arguments: { prompt: "take a legacy selfie" },
      originalRequest: { incoming, captureSequence: 2 }
    } as never, new AbortController().signal);

    expect(legacyResult.status).toBe("succeeded");
    expect(runSelfie.mock.calls[0]?.[2]).toMatchObject({
      chatReferenceImageUrls: ["https://example.test/inside.png"]
    });
  });
});

function incomingMessage(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "user_group",
    messageId: 400,
    time: "2026-07-14T01:00:00.000Z",
    userId: 100,
    groupId: 300,
    selfId: 500,
    sender: { id: "100", displayName: "User" },
    text: "继续修改上一张",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: true,
    accountId: "primary",
    agentId: "arona"
  };
}

function conversationMessage(input: Partial<ConversationRecord["messages"][number]> & Pick<ConversationRecord["messages"][number], "id" | "role">) {
  return {
    text: input.imageUrls?.length ? "[图片]" : "message",
    at: "2026-07-14T00:00:00.000Z",
    userId: 100,
    ...input
  } satisfies ConversationRecord["messages"][number];
}
