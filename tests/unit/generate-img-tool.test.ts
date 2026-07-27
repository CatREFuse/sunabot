// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../src/types.js";
import { runGenerateImg } from "../../services/tools/generateImgTool.js";

describe("generate_img quality", () => {
  it("passes an explicit high quality request to the image provider", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/test.png",
      filePath: "/tmp/test.png"
    }));

    const result = await runGenerateImg({
      prompt: "highest detail portrait",
      size: null,
      resolution: null,
      quality: "high",
      referenceImageUrls: null,
      referenceMediaHandles: null,
      referenceImageSource: "none"
    }, botConfig("medium"), generateImage);

    expect(generateImage).toHaveBeenCalledWith(
      "highest detail portrait",
      "1024x1024",
      "high",
      [],
      undefined
    );
    expect(result).toMatchObject({ ok: true, quality: "high" });
  });

  it("uses the configured quality when the tool leaves it unset", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/test.png",
      filePath: "/tmp/test.png"
    }));

    const result = await runGenerateImg({
      prompt: "portrait",
      quality: null
    }, botConfig("low"), generateImage);

    expect(generateImage.mock.calls[0]?.[2]).toBe("low");
    expect(result).toMatchObject({ ok: true, quality: "low" });
  });

  it("prioritizes exact media handles before explicit URLs and the selected source", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/test.png",
      filePath: "/tmp/test.png"
    }));

    const result = await runGenerateImg({
      prompt: "continue the previous edit",
      size: null,
      resolution: "1K",
      quality: "high",
      referenceImageUrls: ["https://example.test/explicit.png"],
      referenceImagePaths: ["references/workbench.png"],
      referenceMediaHandles: ["message:generated-1:image:0"],
      referenceImageSource: "previous_output"
    }, botConfig("high"), generateImage, {
      imageReferences: {
        currentImageUrls: ["https://example.test/current.png"],
        previousOutputImageUrls: ["/generated-images/previous.png"],
        historyImageUrls: ["/generated-images/previous.png", "https://example.test/original.png"],
        mediaByHandle: {
          "message:generated-1:image:0": "/generated-images/handled.png"
        }
      },
      resolveWorkbenchImagePaths: vi.fn(async () => [
        "/generated-images/conversation-assets/agents/arona/workbench.png"
      ])
    });

    expect(generateImage.mock.calls[0]?.[3]).toEqual([
      "/generated-images/handled.png",
      "/generated-images/conversation-assets/agents/arona/workbench.png",
      "https://example.test/explicit.png",
      "/generated-images/previous.png"
    ]);
    expect(result).toMatchObject({
      referenceImageSource: "previous_output",
      referenceImagePathCount: 1,
      resolvedReferenceImagePathCount: 1,
      referenceMediaHandleCount: 1,
      resolvedReferenceMediaHandleCount: 1,
      referenceImageCount: 4
    });
  });

  it("passes an absolute workbench path to the authorized resolver unchanged", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/absolute.png",
      filePath: "/tmp/absolute.png"
    }));
    const resolveWorkbenchImagePaths = vi.fn(async () => [
      "/generated-images/conversation-assets/agents/arona/absolute.png"
    ]);

    await runGenerateImg({
      prompt: "use the exact workbench file",
      referenceImagePaths: ["/workbench/fixtures/reference.png"],
      referenceImageUrls: null,
      referenceMediaHandles: null,
      referenceImageSource: "none"
    }, botConfig("high"), generateImage, {
      resolveWorkbenchImagePaths
    });

    expect(resolveWorkbenchImagePaths).toHaveBeenCalledWith([
      "/workbench/fixtures/reference.png"
    ]);
  });

  it("honors the model choice to generate without automatic reference images", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/test.png",
      filePath: "/tmp/test.png"
    }));

    await runGenerateImg({
      prompt: "new image",
      size: null,
      resolution: "1K",
      quality: "high",
      referenceImageUrls: null,
      referenceMediaHandles: null,
      referenceImageSource: "none"
    }, botConfig("high"), generateImage, {
      imageReferences: {
        currentImageUrls: ["https://example.test/current.png"],
        previousOutputImageUrls: ["/generated-images/previous.png"],
        historyImageUrls: ["https://example.test/history.png"]
      }
    });

    expect(generateImage.mock.calls[0]?.[3]).toEqual([]);
  });
});

function botConfig(quality: BotConfig["tools"]["generateImg"]["quality"]) {
  return {
    tools: {
      generateImg: {
        provider: "codex-image-gen",
        size: "1024x1024",
        resolution: "1K",
        quality
      }
    }
  } as unknown as BotConfig;
}
