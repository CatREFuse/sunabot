// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInputImageUrl } from "../../adapters/model/provider/imageInput.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("generated image references", () => {
  it("resolves legacy and Agent generated-image handles to bounded data URLs", async () => {
    const root = await temporaryRoot();
    const legacy = path.join(root, "legacy.png");
    const agent = path.join(root, "agents", "arona", "agent.png");
    await fs.mkdir(path.dirname(agent), { recursive: true });
    await Promise.all([writeFixture(legacy), writeFixture(agent)]);

    await expect(resolveInputImageUrl("/generated-images/legacy.png", { generatedImageRoot: root }))
      .resolves.toMatch(/^data:image\/jpeg;base64,/);
    await expect(resolveInputImageUrl("/generated-images/agents/arona/agent.png", { generatedImageRoot: root }))
      .resolves.toMatch(/^data:image\/jpeg;base64,/);
  });

  it("rejects traversal, arbitrary nesting, invalid Agent IDs, missing files and symlink escapes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const outsideFile = path.join(outside, "outside.png");
    await writeFixture(outsideFile);
    await fs.mkdir(path.join(root, "agents", "arona"), { recursive: true });
    await fs.symlink(outsideFile, path.join(root, "agents", "arona", "linked.png"));

    for (const value of [
      "/generated-images/../outside.png",
      "/generated-images/arbitrary/nested.png",
      "/generated-images/agents/INVALID/agent.png",
      "/generated-images/agents/arona/missing.png",
      "/generated-images/agents/arona/linked.png"
    ]) {
      await expect(resolveInputImageUrl(value, { generatedImageRoot: root })).resolves.toBeNull();
    }
  });
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-generated-reference-"));
  roots.push(root);
  return root;
}

async function writeFixture(filePath: string) {
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: "gold" }
  }).png().toFile(filePath);
}
