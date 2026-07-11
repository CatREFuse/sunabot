// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../src/types.js";
import { runGenerateImg } from "../../src/generateImgTool.js";

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
      referenceImageUrls: null
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
