import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("generated image writer", () => {
  let root = "";
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-generated-image-writer-"));
    previousWorkspace = process.env.SUNABOT_WORKSPACE;
    process.env.SUNABOT_WORKSPACE = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
    else process.env.SUNABOT_WORKSPACE = previousWorkspace;
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes the exact requested 4K dimensions when the Provider returns a smaller image", async () => {
    const source = await sharp({
      create: {
        width: 1023,
        height: 1537,
        channels: 3,
        background: { r: 80, g: 120, b: 160 }
      }
    }).png().toBuffer();
    const { FileGeneratedImageWriter } = await import(
      "../../adapters/model/provider/imageWriter.js"
    );

    const image = await new FileGeneratedImageWriter().write({
      output: [{
        type: "image_generation_call",
        result: source.toString("base64")
      }]
    }, "gpt-image-2", "2160x3840");

    await expect(sharp(image.filePath).metadata()).resolves.toMatchObject({
      width: 2160,
      height: 3840,
      format: "png"
    });
  });

  it("preserves both edges when the Provider result and requested canvas have different aspects", async () => {
    const source = await sharp(Buffer.from([
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">',
      '<rect width="160" height="90" fill="#202020"/>',
      '<rect width="18" height="90" fill="#ff0000"/>',
      '<rect x="142" width="18" height="90" fill="#0066ff"/>',
      '<circle cx="80" cy="45" r="22" fill="#00cc66"/>',
      "</svg>"
    ].join(""))).png().toBuffer();
    const { FileGeneratedImageWriter } = await import(
      "../../adapters/model/provider/imageWriter.js"
    );

    const image = await new FileGeneratedImageWriter().write({
      output: [{
        type: "image_generation_call",
        result: source.toString("base64")
      }]
    }, "gpt-image-2", "320x480");

    const { data, info } = await sharp(image.filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 4)];
    };
    expect(info).toMatchObject({ width: 320, height: 480, channels: 4 });
    expect(pixelAt(160, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(0, 240)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(319, 240)).toEqual([0, 102, 255, 255]);
    expect(pixelAt(160, 240)).toEqual([0, 204, 102, 255]);
  });
});
