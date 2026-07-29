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
});
