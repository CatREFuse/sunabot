// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboundMediaDelivery } from "../../services/delivery/outboundMedia.js";

describe("OutboundMediaDelivery", () => {
  let rootDir = "";
  let imagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-"));
    imagePath = path.join(rootDir, "generated-image.png");
    await fs.writeFile(imagePath, Buffer.from("png-fixture"));
    delivery = new OutboundMediaDelivery({
      rootDir
    });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns a validated absolute local path", async () => {
    await expect(delivery.createReference(imagePath)).resolves.toBe(imagePath);
  });

  it("rejects traversal, nested, non-PNG, missing and symlink assets", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-outside-"));
    const outsideImage = path.join(outsideDir, "outside.png");
    const textFile = path.join(rootDir, "note.txt");
    const nestedDir = path.join(rootDir, "nested");
    const nestedImage = path.join(nestedDir, "nested.png");
    const symlinkPath = path.join(rootDir, "linked.png");
    await fs.writeFile(outsideImage, Buffer.from("outside"));
    await fs.writeFile(textFile, Buffer.from("text"));
    await fs.mkdir(nestedDir);
    await fs.writeFile(nestedImage, Buffer.from("nested"));
    let symlinkCreated = true;
    try {
      await fs.symlink(outsideImage, symlinkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
      symlinkCreated = false;
    }

    try {
      await expect(delivery.createReference(outsideImage)).rejects.toThrow("outside the outbound media root");
      await expect(delivery.createReference(textFile)).rejects.toThrow("PNG");
      await expect(delivery.createReference(nestedImage)).rejects.toThrow("direct child");
      await expect(delivery.createReference(path.join(rootDir, "missing.png"))).rejects.toThrow("not a regular file");
      if (symlinkCreated) {
        await expect(delivery.createReference(symlinkPath)).rejects.toThrow("not a regular file");
      }
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
