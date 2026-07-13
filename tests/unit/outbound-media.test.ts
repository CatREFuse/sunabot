// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboundMediaDelivery } from "../../services/delivery/outboundMedia.js";

describe("OutboundMediaDelivery", () => {
  let rootDir = "";
  let imagePath = "";
  let agentImagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-"));
    imagePath = path.join(rootDir, "generated-image.png");
    agentImagePath = path.join(rootDir, "agents", "arona", "generated-image.png");
    await fs.mkdir(path.dirname(agentImagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from("png-fixture"));
    await fs.writeFile(agentImagePath, Buffer.from("agent-png-fixture"));
    delivery = new OutboundMediaDelivery({
      rootDir,
      referenceMode: "shared-path"
    });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("accepts validated legacy and Agent-scoped image paths", async () => {
    await expect(delivery.createReference(imagePath)).resolves.toBe(imagePath);
    await expect(delivery.createReference(agentImagePath)).resolves.toBe(agentImagePath);
  });

  it("rejects traversal, nested, non-PNG, missing and symlink assets", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-outside-"));
    const outsideImage = path.join(outsideDir, "outside.png");
    const outsideAgentDir = path.join(outsideDir, "agent-images");
    const linkedAgentDir = path.join(rootDir, "agents", "linked-agent");
    const linkedAgentImage = path.join(linkedAgentDir, "linked.png");
    const textFile = path.join(rootDir, "note.txt");
    const nestedDir = path.join(rootDir, "nested");
    const nestedImage = path.join(nestedDir, "nested.png");
    const deeplyNestedAgentImage = path.join(rootDir, "agents", "arona", "nested", "nested.png");
    const invalidAgentImage = path.join(rootDir, "agents", "Arona", "invalid.png");
    const symlinkPath = path.join(rootDir, "linked.png");
    await fs.writeFile(outsideImage, Buffer.from("outside"));
    await fs.mkdir(outsideAgentDir);
    await fs.writeFile(path.join(outsideAgentDir, "linked.png"), Buffer.from("linked-agent"));
    await fs.writeFile(textFile, Buffer.from("text"));
    await fs.mkdir(nestedDir);
    await fs.writeFile(nestedImage, Buffer.from("nested"));
    await fs.mkdir(path.dirname(deeplyNestedAgentImage), { recursive: true });
    await fs.writeFile(deeplyNestedAgentImage, Buffer.from("nested-agent"));
    await fs.mkdir(path.dirname(invalidAgentImage), { recursive: true });
    await fs.writeFile(invalidAgentImage, Buffer.from("invalid-agent"));
    let symlinkCreated = true;
    let directorySymlinkCreated = true;
    try {
      await fs.symlink(outsideImage, symlinkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
      symlinkCreated = false;
    }
    try {
      await fs.symlink(outsideAgentDir, linkedAgentDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
      directorySymlinkCreated = false;
    }

    try {
      await expect(delivery.createReference(outsideImage)).rejects.toThrow("outside the outbound media root");
      await expect(delivery.createReference(textFile)).rejects.toThrow("PNG");
      await expect(delivery.createReference(nestedImage)).rejects.toThrow("direct child");
      await expect(delivery.createReference(deeplyNestedAgentImage)).rejects.toThrow("direct child");
      await expect(delivery.createReference(invalidAgentImage)).rejects.toThrow("direct child");
      await expect(delivery.createReference(path.join(rootDir, "missing.png"))).rejects.toThrow("not a regular file");
      if (symlinkCreated) {
        await expect(delivery.createReference(symlinkPath)).rejects.toThrow("not a regular file");
      }
      if (directorySymlinkCreated) {
        await expect(delivery.createReference(linkedAgentImage)).rejects.toThrow("symbolic links");
      }
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
