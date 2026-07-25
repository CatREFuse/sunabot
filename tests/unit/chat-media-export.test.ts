// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatMediaPublisher } from "../../adapters/filesystem/chatMediaPublisher.js";
import { CacheStore } from "../../services/media/attachments/cache.js";
import { ChatMediaExportService } from "../../services/media/chatMediaExport.js";
import {
  readExportChatMediaInput,
  readImportChatEmojiInput
} from "../../services/tools/chatMediaTool.js";
import { testTempRoot } from "./test-temp-root.js";

const TEST_ROOT = testTempRoot("chat-media-export");
const roots: string[] = [];
let pngBytes: Buffer;

beforeAll(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  pngBytes = await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 }
    }
  }).png().toBuffer();
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("chat media export", () => {
  it("exports an exact current-message image under a content hash and deduplicates retries", async () => {
    const fixture = await imageFixture("message:101:image:0", pngDataUrl("image/png"));

    const first = await fixture.service.export({ handle: "message:101:image:0" });
    const second = await fixture.service.export({ handle: "message:101:image:0" });
    const stored = await fs.readFile(path.join(fixture.agentWorkspace, "workbench", first.path));
    const stats = await fs.lstat(path.join(fixture.agentWorkspace, "workbench", first.path));

    expect(first).toMatchObject({
      ok: true,
      path: `chat-media-${first.sha256}.png`,
      mimeType: "image/png",
      extension: "png",
      byteLength: pngBytes.length,
      width: 3,
      height: 2,
      deduplicated: false
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(stored).toEqual(pngBytes);
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.nlink).toBe(1);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("exports a parsed file from the current Agent cache and preserves the detected extension", async () => {
    const root = await fixtureRoot();
    const agentWorkspace = path.join(root, "agent");
    const cache = await cacheFixture(root);
    const content = Buffer.from("status: ready\n", "utf8");
    const cached = await cache.writeBase64(content.toString("base64"));
    const service = new ChatMediaExportService({
      agentWorkspace,
      cache,
      sources: new Map([["message:102:file:0", {
        kind: "file" as const,
        attachment: {
          id: "file-1",
          source: "message" as const,
          name: "status.txt",
          status: "ready" as const,
          sizeBytes: cached.sizeBytes,
          sha256: cached.sha256,
          cacheKey: cached.cacheKey,
          mimeType: "text/plain",
          format: "txt"
        }
      }]]),
      publisher: chatMediaPublisher
    });

    const result = await service.export({ handle: "message:102:file:0" });

    expect(result).toMatchObject({
      mimeType: "text/plain",
      extension: "txt",
      byteLength: content.length,
      width: null,
      height: null
    });
    await expect(fs.readFile(path.join(agentWorkspace, "workbench", result.path)))
      .resolves.toEqual(content);
  });

  it("rejects unknown handles before resolving any source", async () => {
    const fixture = await imageFixture("message:103:image:0", pngDataUrl("image/png"));

    await expect(fixture.service.export({ handle: "message:999:image:0" }))
      .rejects.toThrow("CHAT_MEDIA_HANDLE_UNAVAILABLE");
    await expect(workbenchExports(fixture.agentWorkspace)).resolves.toEqual([]);
  });

  it("rejects MIME and extension mismatches without publishing a workbench file", async () => {
    const inlineMismatch = await imageFixture(
      "message:104:image:0",
      pngDataUrl("image/jpeg")
    );
    await expect(inlineMismatch.service.export({ handle: "message:104:image:0" }))
      .rejects.toThrow("CHAT_MEDIA_TYPE_INVALID");
    await expect(workbenchExports(inlineMismatch.agentWorkspace)).resolves.toEqual([]);

    const root = await fixtureRoot();
    const agentWorkspace = path.join(root, "agent");
    const cache = await cacheFixture(root);
    const cached = await cache.writeBase64(pngBytes.toString("base64"));
    const fileMismatch = new ChatMediaExportService({
      agentWorkspace,
      cache,
      sources: new Map([["message:105:file:0", {
        kind: "file" as const,
        attachment: {
          id: "file-2",
          source: "message" as const,
          name: "forged.pdf",
          status: "ready" as const,
          sizeBytes: cached.sizeBytes,
          sha256: cached.sha256,
          cacheKey: cached.cacheKey,
          mimeType: "image/png",
          format: "png"
        }
      }]]),
      publisher: chatMediaPublisher
    });
    await expect(fileMismatch.export({ handle: "message:105:file:0" }))
      .rejects.toThrow("CHAT_MEDIA_TYPE_INVALID");
    await expect(workbenchExports(agentWorkspace)).resolves.toEqual([]);
  });

  it("does not follow a replaced cache symlink or overwrite a conflicting hash target", async () => {
    const root = await fixtureRoot();
    const agentWorkspace = path.join(root, "agent");
    const cache = await cacheFixture(root);
    const cached = await cache.writeBase64(Buffer.from("safe\n").toString("base64"));
    const attachment = {
      id: "file-3",
      source: "message" as const,
      name: "safe.txt",
      status: "ready" as const,
      sizeBytes: cached.sizeBytes,
      sha256: cached.sha256,
      cacheKey: cached.cacheKey,
      mimeType: "text/plain",
      format: "txt"
    };
    const service = new ChatMediaExportService({
      agentWorkspace,
      cache,
      sources: new Map([["message:106:file:0", { kind: "file" as const, attachment }]]),
      publisher: chatMediaPublisher
    });
    await fs.mkdir(path.join(agentWorkspace, "workbench"), { recursive: true });
    const conflictPath = path.join(
      agentWorkspace,
      "workbench",
      `chat-media-${cached.sha256}.txt`
    );
    await fs.writeFile(conflictPath, "attacker", { mode: 0o600 });
    await expect(service.export({ handle: "message:106:file:0" }))
      .rejects.toThrow("CHAT_MEDIA_PUBLISH_CONFLICT");
    await expect(fs.readFile(conflictPath, "utf8")).resolves.toBe("attacker");

    await fs.unlink(conflictPath);
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside");
    await fs.unlink(cached.filePath);
    await fs.symlink(outside, cached.filePath);
    await expect(service.export({ handle: "message:106:file:0" })).rejects.toBeTruthy();
    await expect(workbenchExports(agentWorkspace)).resolves.toEqual([]);
  });

  it("rejects URL, destination path, Agent ID and malformed handle arguments", () => {
    for (const input of [
      {},
      { handle: "https://example.test/image.png" },
      { handle: "message:1:image:0", path: "../outside.png" },
      { handle: "message:1:image:0", agentId: "other" },
      { handle: "message:1:image:-1" }
    ]) {
      expect(() => readExportChatMediaInput(input)).toThrow();
    }
    for (const input of [
      { handle: "message:1:file:0", key: "ok" },
      { handle: "message:1:image:0", key: "../bad" },
      { handle: "message:1:image:0", key: "ok", url: "https://example.test" }
    ]) {
      expect(() => readImportChatEmojiInput(input)).toThrow();
    }
  });
});

async function imageFixture(handle: string, url: string) {
  const root = await fixtureRoot();
  const agentWorkspace = path.join(root, "agent");
  const cache = await cacheFixture(root);
  return {
    agentWorkspace,
    service: new ChatMediaExportService({
      agentWorkspace,
      cache,
      sources: new Map([[handle, {
        kind: "image" as const,
        asset: {
          schemaVersion: 1 as const,
          kind: "image" as const,
          source: "inline_data" as const,
          url
        }
      }]]),
      publisher: chatMediaPublisher
    })
  };
}

async function cacheFixture(root: string) {
  const cache = new CacheStore(path.join(root, "cache"), {
    minimumFreeBytes: 0
  });
  await cache.initialize();
  return cache;
}

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(TEST_ROOT, "case-"));
  roots.push(root);
  return root;
}

function pngDataUrl(mimeType: string) {
  return `data:${mimeType};base64,${pngBytes.toString("base64")}`;
}

async function workbenchExports(agentWorkspace: string) {
  try {
    return (await fs.readdir(path.join(agentWorkspace, "workbench")))
      .filter((name) => name.startsWith("chat-media-"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
