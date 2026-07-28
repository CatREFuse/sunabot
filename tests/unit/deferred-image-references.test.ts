// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ParsedIncomingMessage } from "../../src/types.js";
import {
  readGenerateImgReferenceContext,
  snapshotDeferredChatImages
} from "../../src/runtime/deferredImageReferences.js";

describe("deferred chat image references", () => {
  it("freezes required current and exact-handle images as digest-bound archive references", async () => {
    const currentUrl = "https://multimedia.nt.qq.com.cn/current";
    const quotedUrl = "https://multimedia.nt.qq.com.cn/quoted";
    const archive = vi.fn(async (sourceUrl: string) => ({
      schemaVersion: 1 as const,
      sha256: sourceUrl === currentUrl ? "a".repeat(64) : "b".repeat(64),
      url: `/generated-images/conversation-assets/agents/arona/${sourceUrl === currentUrl ? "a".repeat(64) : "b".repeat(64)}.png`
    }));
    const incoming = fixtureIncoming(currentUrl, quotedUrl);
    const context = {
      currentImageUrls: [currentUrl],
      historyImageUrls: [],
      previousOutputImageUrls: [],
      mediaByHandle: {
        "message:930102:image:0": quotedUrl
      }
    };

    const snapshot = await snapshotDeferredChatImages(
      {} as never,
      incoming,
      {
        name: "generate_img",
        callId: "call-current",
        arguments: {
          referenceImageUrls: [currentUrl],
          referenceMediaHandles: ["message:930102:image:0"],
          referenceImageSource: "none"
        }
      },
      context,
      () => true,
      { archive }
    );

    expect(archive).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(snapshot)).not.toContain(currentUrl);
    expect(JSON.stringify(snapshot)).not.toContain(quotedUrl);
    expect(snapshot.toolCall.arguments.referenceImageUrls).toEqual([
      `/generated-images/conversation-assets/agents/arona/${"a".repeat(64)}.png`
    ]);
    expect(snapshot.imageReferences.currentImageUrls).toEqual([
      {
        schemaVersion: 1,
        sha256: "a".repeat(64),
        url: `/generated-images/conversation-assets/agents/arona/${"a".repeat(64)}.png`
      }
    ]);
    expect(snapshot.imageReferences.explicitImageUrls).toEqual(
      snapshot.imageReferences.currentImageUrls
    );
    expect(readGenerateImgReferenceContext(snapshot.imageReferences)?.mediaByHandle).toEqual({
      "message:930102:image:0": `/generated-images/conversation-assets/agents/arona/${"b".repeat(64)}.png`
    });
  });

  it("fails dispatch when a required exact handle has no source image", async () => {
    await expect(snapshotDeferredChatImages(
      {} as never,
      fixtureIncoming("", ""),
      {
        name: "generate_img",
        callId: "call-missing",
        arguments: {
          referenceImageUrls: [],
          referenceMediaHandles: ["message:missing:image:0"],
          referenceImageSource: "none"
        }
      },
      {
        currentImageUrls: [],
        historyImageUrls: [],
        previousOutputImageUrls: [],
        mediaByHandle: {}
      },
      () => true,
      { archive: vi.fn() }
    )).rejects.toThrow("必需参考图无法解析");
  });
});

function fixtureIncoming(currentUrl: string, quotedUrl: string): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "user_group",
    messageId: 930103,
    time: "2026-07-28T00:00:00.000Z",
    userId: 10001,
    groupId: 30003,
    sender: { id: "10001" },
    text: "use images",
    media: currentUrl ? [{
      schemaVersion: 1,
      kind: "image",
      source: "remote_url",
      url: currentUrl
    }] : [],
    attachments: [],
    replyMessageIds: quotedUrl ? [930102] : [],
    quoteReferences: quotedUrl ? [{
      messageId: 930102,
      imageUrls: [quotedUrl],
      media: [{
        schemaVersion: 1,
        kind: "image",
        source: "remote_url",
        url: quotedUrl
      }]
    }] : [],
    mentionedSelf: true
  };
}
