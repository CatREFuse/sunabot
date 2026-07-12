import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { probeProviderMultimodal } from "../../adapters/model/providerDiscovery.js";
import { defaultConfig } from "../../src/config.js";

describe("provider multimodal discovery", () => {
  it("accepts a completion that identifies the probe image", async () => {
    const complete = vi.fn(async () => "RED");

    await expect(probeProviderMultimodal(defaultConfig().providers.items[0]!, complete))
      .resolves.toEqual({ multimodal: true });
    const imageUrl = complete.mock.calls[0]?.[1][0]?.imageUrls[0] ?? "";
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    const pixel = await sharp(Buffer.from(imageUrl.split(",")[1]!, "base64")).ensureAlpha().raw().toBuffer();
    expect([...pixel.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it("rejects successful responses that did not identify the image", async () => {
    await expect(probeProviderMultimodal(defaultConfig().providers.items[0]!, async () => "BLUE"))
      .resolves.toEqual({ multimodal: false, reason: "模型未识别探测图片：BLUE" });
  });

  it("reports transport failures as a negative probe", async () => {
    await expect(probeProviderMultimodal(defaultConfig().providers.items[0]!, async () => {
      throw new Error("unsupported image");
    })).resolves.toEqual({ multimodal: false, reason: "unsupported image" });
  });
});
