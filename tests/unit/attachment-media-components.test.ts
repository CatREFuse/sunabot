// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentFetcher,
  CacheIndexRepository,
  CacheJanitor,
  CacheStore,
  ContentAddressedStore
} from "../../services/media/attachments/cache.js";
import { AttachmentContextBuilder } from "../../services/media/attachments/attachmentContextBuilder.js";
import { ParserPipeline } from "../../services/media/attachments/parserPipeline.js";
import type { ParsedAttachment } from "../../services/media/attachments/types.js";
import type { AttachmentWorkerSupervisor } from "../../services/media/attachments/worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("attachment media components", () => {
  it("composes fetch, CAS, index and janitor components behind CacheStore", async () => {
    const root = await temporaryRoot();
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 1 })
    });

    expect(store.fetcher).toBeInstanceOf(AttachmentFetcher);
    expect(store.contentStore).toBeInstanceOf(ContentAddressedStore);
    expect(store.indexRepository).toBeInstanceOf(CacheIndexRepository);
    expect(store.janitor).toBeInstanceOf(CacheJanitor);

    const cached = await store.contentStore.writeBase64(Buffer.from("component CAS").toString("base64"));
    await expect(store.indexRepository.getEntry(cached.cacheKey)).resolves.toMatchObject({
      sha256: cached.sha256,
      originalSizeBytes: cached.sizeBytes,
      parseStatus: "pending"
    });
  });

  it("runs ParserPipeline and context selection without AttachmentService", async () => {
    const root = await temporaryRoot();
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 1 })
    });
    const cached = await store.writeBase64(
      Buffer.from("Migration checklist includes a verified backup.", "utf8").toString("base64")
    );
    const worker = { run: vi.fn() } as unknown as AttachmentWorkerSupervisor;
    const parser = new ParserPipeline({ cacheRoot: root, cache: store, worker });
    const pending: ParsedAttachment = {
      id: "component-text",
      source: "message",
      name: "checklist.txt",
      status: "pending",
      cacheKey: cached.cacheKey,
      sha256: cached.sha256,
      sizeBytes: cached.sizeBytes
    };

    const parsed = await parser.parseCached(pending, cached.filePath, "verified backup");
    const context = await new AttachmentContextBuilder(root, parser)
      .build([parsed], "verified backup");

    expect(parsed).toMatchObject({ status: "ready", format: "txt" });
    expect(context.text).toContain("verified backup");
    expect(context.localImagePaths).toEqual([]);
    expect(worker.run).not.toHaveBeenCalled();
  });
});

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sunabot-media-components-"));
  temporaryDirectories.push(directory);
  return directory;
}
