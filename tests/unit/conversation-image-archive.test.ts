// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImageGenerationContent,
  resolveInputImageUrl
} from "../../adapters/model/provider/imageInput.js";
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
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("conversation image archive", () => {
  it("normalizes a high-resolution remote image even when its source bytes are below 8 MiB", async () => {
    const source = await sharp({
      create: {
        width: 4_000,
        height: 3_000,
        channels: 3,
        background: { r: 24, g: 96, b: 180 }
      }
    }).jpeg({ quality: 95 }).toBuffer();
    expect(source.byteLength).toBeLessThan(8 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(source.byteLength)
      }
    })));

    const resolved = await resolveInputImageUrl("https://cdn.example.test/high-resolution.jpg");
    const encoded = resolved?.split(",", 2)[1];
    expect(encoded).toBeTruthy();
    const normalized = Buffer.from(encoded!, "base64");
    const metadata = await sharp(normalized).metadata();

    expect(resolved).toMatch(/^data:image\/jpeg;base64,/);
    expect(metadata.width).toBe(2_048);
    expect(metadata.height).toBe(1_536);
  });

  it("propagates caller cancellation while downloading an image-generation reference", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = buildImageGenerationContent(
      "edit this image",
      ["https://cdn.example.test/reference.png"],
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const reason = new DOMException("cancelled", "AbortError");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

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

  it("keeps an archived Workbench reference available after the source file is removed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workbench-reference-lifecycle-"));
    roots.push(root);
    const sourcePath = path.join(root, "workbench", "references", "plana.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, PNG_BYTES);
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");

    const url = await archiveConversationImage("arona", {
      kind: "image",
      name: "plana.png",
      source: `base64://${(await fs.readFile(sourcePath)).toString("base64")}`,
      byteLength: PNG_BYTES.byteLength,
      sha256,
      mimeType: "image/png"
    }, path.join(root, "media"));
    await fs.rm(sourcePath);

    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveInputImageUrl(url, {
      generatedImageRoot: path.join(root, "media")
    })).resolves.toMatch(/^data:image\/png;base64,/);
  });

  it("keeps archived source bytes and derives separate bounded copies for vision and image generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-conversation-original-reference-"));
    roots.push(root);
    const source = await sharp({
      create: {
        width: 4_000,
        height: 3_000,
        channels: 3,
        background: { r: 48, g: 112, b: 176 }
      }
    }).jpeg({ quality: 95 }).toBuffer();
    const sha256 = createHash("sha256").update(source).digest("hex");
    const url = await archiveConversationImage("arona", {
      kind: "image",
      name: "reference.jpg",
      source: `base64://${source.toString("base64")}`,
      byteLength: source.byteLength,
      sha256,
      mimeType: "image/jpeg"
    }, root);

    const modelInput = await resolveInputImageUrl(url, { generatedImageRoot: root });
    const generationContent = await buildImageGenerationContent("edit this image", [url], {
      generatedImageRoot: root
    });
    const modelBytes = Buffer.from(modelInput!.split(",", 2)[1]!, "base64");
    const generationUrl = String(generationContent[1]?.image_url ?? "");
    const generationBytes = Buffer.from(generationUrl.split(",", 2)[1]!, "base64");
    const archivedBytes = await fs.readFile(path.join(
      root,
      "conversation-assets",
      "agents",
      "arona",
      `${sha256}.jpg`
    ));
    const generationMetadata = await sharp(generationBytes).metadata();

    await expect(sharp(modelBytes).metadata()).resolves.toMatchObject({
      width: 2_048,
      height: 1_536
    });
    expect(archivedBytes).toEqual(source);
    expect(createHash("sha256").update(archivedBytes).digest("hex")).toBe(sha256);
    expect(generationBytes).not.toEqual(source);
    expect(generationBytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(Math.max(generationMetadata.width!, generationMetadata.height!)).toBeLessThanOrEqual(3_840);
    expect(generationMetadata.width! * generationMetadata.height!).toBeLessThanOrEqual(8_294_400);
    expect(Math.max(generationMetadata.width!, generationMetadata.height!)).toBeGreaterThan(2_048);
  });

  it("normalizes data URL references through the image-generation reference pipeline", async () => {
    const source = await sharp({
      create: {
        width: 4_000,
        height: 3_000,
        channels: 3,
        background: { r: 80, g: 120, b: 160 }
      }
    }).jpeg({ quality: 95 }).toBuffer();
    const content = await buildImageGenerationContent(
      "edit this image",
      [`data:image/jpeg;base64,${source.toString("base64")}`]
    );
    const generationUrl = String(content[1]?.image_url ?? "");
    const generationBytes = Buffer.from(generationUrl.split(",", 2)[1]!, "base64");
    const metadata = await sharp(generationBytes).metadata();

    expect(generationBytes).not.toEqual(source);
    expect(generationBytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(3_840);
    expect(metadata.width! * metadata.height!).toBeLessThanOrEqual(8_294_400);
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
