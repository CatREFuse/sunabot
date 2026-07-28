// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInputImageUrl } from "../../adapters/model/provider/imageInput.js";
import {
  archiveConversationImage,
  archiveConversationImageReference
} from "../../services/media/conversationImageArchive.js";
import { CacheStore } from "../../services/media/attachments/cache.js";

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

  it("downloads a remote reference with three retry opportunities before archiving it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-conversation-reference-"));
    roots.push(root);
    const fetchImpl = vi.fn()
        .mockRejectedValueOnce(new Error("network-1"))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockRejectedValueOnce(new Error("network-3"))
        .mockResolvedValueOnce(new Response(PNG_BYTES, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(PNG_BYTES.byteLength)
          }
        })) as unknown as typeof fetch;
    const cache = new CacheStore(path.join(root, "cache"), {
      fetchImpl,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4_096 })
    });
    const sleep = vi.fn(async () => undefined);

    const archived = await archiveConversationImageReference(
      "arona",
      "https://cdn.example.test/current.png",
      cache,
      { mediaRoot: path.join(root, "media"), retrySleep: sleep }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[250], [500], [1_000]]);
    expect(archived).toEqual({
      schemaVersion: 1,
      sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
      url: expect.stringMatching(/^\/generated-images\/conversation-assets\/agents\/arona\/[a-f0-9]{64}\.png$/)
    });
    await expect(resolveInputImageUrl(archived.url, {
      generatedImageRoot: path.join(root, "media")
    })).resolves.toMatch(/^data:image\/png;base64,/);
  });

  it("copies an existing generated image into the immutable conversation archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-generated-reference-"));
    roots.push(root);
    const mediaRoot = path.join(root, "media");
    const generatedDirectory = path.join(mediaRoot, "agents", "arona");
    await fs.mkdir(generatedDirectory, { recursive: true });
    await fs.writeFile(path.join(generatedDirectory, "generated.png"), PNG_BYTES);
    const cache = new CacheStore(path.join(root, "cache"), {
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4_096 })
    });

    const archived = await archiveConversationImageReference(
      "arona",
      "/generated-images/agents/arona/generated.png",
      cache,
      { mediaRoot }
    );

    expect(archived.sha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
    expect(await fs.readFile(path.join(
      mediaRoot,
      archived.url.slice("/generated-images/".length)
    ))).toEqual(PNG_BYTES);
  });

  it("rejects a generated image owned by another Agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-cross-agent-reference-"));
    roots.push(root);
    const mediaRoot = path.join(root, "media");
    const generatedDirectory = path.join(mediaRoot, "agents", "plana");
    await fs.mkdir(generatedDirectory, { recursive: true });
    await fs.writeFile(path.join(generatedDirectory, "generated.png"), PNG_BYTES);
    const cache = new CacheStore(path.join(root, "cache"), {
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4_096 })
    });

    await expect(archiveConversationImageReference(
      "arona",
      "/generated-images/agents/plana/generated.png",
      cache,
      { mediaRoot }
    )).rejects.toThrow("不属于当前 Agent");
  });
});
