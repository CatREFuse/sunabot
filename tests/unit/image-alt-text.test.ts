import { describe, expect, it, vi } from "vitest";
import { imageMediaAsset } from "../../packages/contracts/media/media.js";
import {
  normalizeImageAltText,
  populateInboundImageAltTexts
} from "../../src/runtime/imageAltText.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

describe("image alt text", () => {
  it("writes one concise description to direct and quoted copies of the same image", async () => {
    const complete = vi.fn().mockResolvedValue("红色方块");
    const runtime = {
      config: {
        bot: {
          imageReader: {
            enabled: true,
            providerId: "vision",
            model: "gpt-vision",
            reasoningEffort: "low" as const
          }
        }
      },
      getProviderForModel: vi.fn(() => ({ complete }))
    };
    const incoming = message();
    incoming.media = [imageMediaAsset("https://example.test/red.png")];
    incoming.quoteReferences = [{
      messageId: 9,
      media: [imageMediaAsset("https://example.test/red.png")],
      imageUrls: ["https://example.test/red.png"]
    }];

    await populateInboundImageAltTexts(runtime as never, incoming);

    expect(runtime.getProviderForModel).toHaveBeenCalledWith("gpt-vision", "low", "vision");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(incoming.media[0]?.altText).toBe("一张红色方块");
    expect(incoming.quoteReferences[0]?.media?.[0]?.altText).toBe("一张红色方块");
  });

  it("does not block inbound preparation when the image reader fails", async () => {
    const incoming = message();
    incoming.media = [imageMediaAsset("https://example.test/unavailable.png")];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(populateInboundImageAltTexts({
      config: { bot: { imageReader: { enabled: true, providerId: "", model: "vision" } } },
      getProviderForModel: () => ({ complete: vi.fn().mockRejectedValue(new Error("offline")) })
    } as never, incoming)).resolves.toBeUndefined();
    expect(incoming.media[0]?.altText).toBeUndefined();
    error.mockRestore();
  });

  it("normalizes model output to one image sentence", () => {
    expect(normalizeImageAltText("  “两个人正在看文件”  ")).toBe("一张两个人正在看文件");
  });
});

function message(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "private",
    time: "2026-07-28T00:00:00.000Z",
    userId: 1,
    sender: { id: "1" },
    text: "",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}
