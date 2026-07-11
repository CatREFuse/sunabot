// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAttachmentImage } from "../../src/attachments/image.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("attachment image normalization", () => {
  it("resizes an opaque file-path image and emits bounded JPEG", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-image-test-"));
    const filePath = path.join(temporaryDirectory, "wide.png");
    await sharp({
      create: { width: 2_400, height: 800, channels: 3, background: { r: 20, g: 80, b: 160 } }
    }).png().toFile(filePath);

    const result = await normalizeAttachmentImage(filePath, { maxLongEdge: 512, maxPixels: 512 * 512 });

    expect(result).toMatchObject({
      contentType: "image/jpeg",
      format: "jpeg",
      resized: true,
      sourcePages: 1
    });
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(512);
    expect(result.width / result.height).toBeCloseTo(3, 1);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("preserves transparency as PNG", async () => {
    const fixture = await sharp({
      create: { width: 40, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } }
    }).png().toBuffer();

    const result = await normalizeAttachmentImage(fixture);

    expect(result).toMatchObject({
      contentType: "image/png",
      format: "png",
      width: 40,
      height: 30,
      resized: false
    });
    expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("enforces option boundaries", async () => {
    const fixture = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" }
    }).png().toBuffer();
    await expect(normalizeAttachmentImage(fixture, { maxLongEdge: 0 })).rejects.toThrow("maxLongEdge");
  });
});
