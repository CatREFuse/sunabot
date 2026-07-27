// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInputImageUrl } from "../../adapters/model/provider/imageInput.js";
import { archiveConversationImage } from "../../services/media/conversationImageArchive.js";

const roots: string[] = [];
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("conversation image archive", () => {
  it("archives a sent image by content hash and resolves it for image generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-conversation-image-"));
    roots.push(root);
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");

    const url = await archiveConversationImage("arona", {
      kind: "image",
      name: "reference.png",
      source: `base64://${PNG_BYTES.toString("base64")}`,
      byteLength: PNG_BYTES.byteLength,
      sha256,
      mimeType: "image/png"
    }, root);

    expect(url).toBe(`/generated-images/conversation-assets/agents/arona/${sha256}.png`);
    expect(await fs.readFile(path.join(
      root,
      "conversation-assets",
      "agents",
      "arona",
      `${sha256}.png`
    ))).toEqual(PNG_BYTES);
    await expect(resolveInputImageUrl(url, { generatedImageRoot: root }))
      .resolves.toMatch(/^data:image\/png;base64,/);
  });
});
