// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  CacheStore,
  InvalidBase64Error
} from "../../services/media/attachments/cache.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import {
  CACHE_MIN_FREE_BYTES,
  CACHE_UNREFERENCED_TTL_MS,
  FILE_SIZE_LIMIT_BYTES
} from "../../services/media/attachments/limits.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("attachment cache", () => {
  it("uses an exact 256 MiB production hard limit", () => {
    expect(FILE_SIZE_LIMIT_BYTES).toBe(268_435_456);
    expect(CACHE_UNREFERENCED_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CACHE_MIN_FREE_BYTES).toBe(2_147_483_648);
  });

  it("streams HTTP bytes, hashes them and atomically records the index", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("hello streamed attachment");
    const fetchImpl = vi.fn(async () => responseFromChunks([
      bytes.subarray(0, 6),
      bytes.subarray(6)
    ], { "content-length": String(bytes.length) })) as unknown as typeof fetch;
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      fetchImpl,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    const cached = await store.downloadHttp("https://cdn.example.test/report.txt");
    const expectedHash = createHash("sha256").update(bytes).digest("hex");

    expect(cached).toMatchObject({
      sha256: expectedHash,
      cacheKey: expectedHash,
      sizeBytes: bytes.length,
      cacheHit: false
    });
    expect(await readFile(cached.filePath)).toEqual(bytes);
    expect(await store.getEntry(expectedHash)).toEqual({
      sha256: expectedHash,
      originalFile: path.join(expectedHash, "original"),
      originalSizeBytes: bytes.length,
      artifactsSizeBytes: 0,
      lastAccessAt: "2026-07-10T00:00:00.000Z",
      parseStatus: "pending",
      activeReferences: []
    });
    expect(JSON.parse(await readFile(path.join(root, "index.json"), "utf8")))
      .toEqual(await store.getIndex());
    expect((await readdir(root)).filter((name) => name.startsWith(".index-") && name.endsWith(".tmp")))
      .toEqual([]);
    expect(await partFiles(root)).toEqual([]);
  });

  it("cancels a never-ending error response instead of waiting for its body", async () => {
    const root = await temporaryRoot();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("error body prefix"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const store = new CacheStore(root, {
      fetchImpl: vi.fn(async () => new Response(body, { status: 404 })) as unknown as typeof fetch,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      maxFileBytes: 1_024,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    const result = Promise.race([
      store.downloadHttp("https://downloads.example.com/missing"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("download hung")), 1_000))
    ]);

    await expect(result).rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
      code: "http_status"
    }));
    expect(cancelled).toBe(true);
  });

  it("tears down a real Undici connection before cancelling a never-ending error body", async () => {
    const root = await temporaryRoot();
    let disconnected = false;
    const server = createServer((request, response) => {
      request.socket.once("close", () => {
        disconnected = true;
      });
      response.writeHead(404, { "content-type": "text/plain" });
      response.write("error body prefix");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP test server did not expose a TCP port.");
    }
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      maxFileBytes: 1_024,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    try {
      const result = Promise.race([
        store.downloadHttp(`http://127.0.0.1:${address.port}/slow-error`),
        new Promise((_, reject) => setTimeout(() => reject(new Error("download hung")), 1_500))
      ]);

      await expect(result).rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "http_status"
      }));
      await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1_000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reuses identical content by SHA-256", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("same bytes");
    const fetchImpl = vi.fn(async () => responseFromChunks([bytes])) as unknown as typeof fetch;
    const store = new CacheStore(root, { allowPrivateNetwork: true, fetchImpl });

    const first = await store.downloadHttp("https://cdn.example.test/one");
    const second = await store.downloadHttp("https://cdn.example.test/two");

    expect(second.filePath).toBe(first.filePath);
    expect(second.cacheHit).toBe(true);
    expect(Object.keys((await store.getIndex()).entries)).toEqual([first.sha256]);
    expect(await partFiles(root)).toEqual([]);
  });

  it("rejects an oversized Content-Length before accessing the body", async () => {
    const root = await temporaryRoot();
    let bodyAccessed = false;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "9" }),
      get body() {
        bodyAccessed = true;
        return null;
      }
    } as unknown as Response;
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      maxFileBytes: 8,
      fetchImpl: vi.fn(async () => response) as unknown as typeof fetch
    });

    await expect(store.downloadHttp("https://cdn.example.test/large"))
      .rejects.toEqual(expect.objectContaining({ code: "too_large" }));
    expect(bodyAccessed).toBe(false);
    expect(await partFiles(root)).toEqual([]);
  });

  it("accepts the exact byte boundary and removes a partial file after overflow", async () => {
    const root = await temporaryRoot();
    const responses = [
      responseFromChunks([Buffer.alloc(4), Buffer.alloc(4)]),
      responseFromChunks([Buffer.alloc(4), Buffer.alloc(5)])
    ];
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      maxFileBytes: 8,
      fetchImpl: vi.fn(async () => responses.shift()!) as unknown as typeof fetch
    });

    await expect(store.downloadHttp("https://cdn.example.test/exact"))
      .resolves.toEqual(expect.objectContaining({ sizeBytes: 8 }));
    await expect(store.downloadHttp("https://cdn.example.test/overflow"))
      .rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await partFiles(root)).toEqual([]);
  });

  it("validates and decodes Base64 in aligned chunks", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("chunked base64 data");
    const store = new CacheStore(root, { maxFileBytes: bytes.length });

    const cached = await store.writeBase64(
      `data:application/octet-stream;base64,${bytes.toString("base64")}`,
      { chunkCharacters: 4 }
    );

    expect(cached.sizeBytes).toBe(bytes.length);
    expect(await readFile(cached.filePath)).toEqual(bytes);
    expect(await partFiles(root)).toEqual([]);
  });

  it("rejects Base64 theoretical overflow and invalid input without residue", async () => {
    const root = await temporaryRoot();
    const store = new CacheStore(root, { maxFileBytes: 8 });

    await expect(store.writeBase64(Buffer.alloc(9).toString("base64")))
      .rejects.toBeInstanceOf(AttachmentTooLargeError);
    for (const value of ["abc", "ab=c", "!!!!"]) {
      await expect(store.writeBase64(value)).rejects.toBeInstanceOf(InvalidBase64Error);
    }
    expect(await partFiles(root)).toEqual([]);
  });

  it("cleans stale parts and serializes reference index updates", async () => {
    const root = await temporaryRoot();
    const temp = path.join(root, ".tmp");
    await mkdir(temp, { recursive: true });
    await writeFile(path.join(temp, "stale.part"), "partial");
    const store = new CacheStore(root, {
      now: () => new Date("2026-07-10T08:00:00.000Z")
    });

    await store.initialize();
    expect(await partFiles(root)).toEqual([]);
    const cached = await store.writeBase64(Buffer.from("refs").toString("base64"));
    await Promise.all([
      store.addReference(cached.sha256, "conversation-b/message-2/file"),
      store.addReference(cached.sha256, "conversation-a/message-1/file")
    ]);
    await store.removeReference(cached.sha256, "conversation-b/message-2/file");

    expect((await store.getEntry(cached.sha256))?.activeReferences)
      .toEqual(["conversation-a/message-1/file"]);
    expect(JSON.parse(await readFile(path.join(root, "index.json"), "utf8")))
      .toEqual(await store.getIndex());
    expect((await readdir(root)).filter((name) => name.startsWith(".index-") && name.endsWith(".tmp")))
      .toEqual([]);
  });

  it("imports a shared file as a bounded stream through the same SHA cache", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "shared-report.bin");
    const cacheRoot = path.join(root, "cache");
    const bytes = Buffer.from("shared path attachment");
    await writeFile(sourcePath, bytes);
    const store = new CacheStore(cacheRoot, {
      maxFileBytes: bytes.length,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    const imported = await store.importFile(sourcePath);
    const duplicate = await store.writeBase64(bytes.toString("base64"));

    expect(imported.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(imported.filePath)).toEqual(bytes);
    expect(duplicate).toMatchObject({
      sha256: imported.sha256,
      filePath: imported.filePath,
      cacheHit: true
    });
    expect(Object.keys((await store.getIndex()).entries)).toEqual([imported.sha256]);
  });

  it("rejects a symbolic-link import source without reading its target", async () => {
    const root = await temporaryRoot();
    const outsidePath = path.join(root, "outside.bin");
    const linkPath = path.join(root, "source-link.bin");
    await writeFile(outsidePath, "outside bytes");
    await symlink(outsidePath, linkPath);
    const store = new CacheStore(path.join(root, "cache"), {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await expect(store.importFile(linkPath)).rejects.toEqual(
      expect.objectContaining({ code: "import_failed" })
    );
    expect(await partFiles(path.join(root, "cache"))).toEqual([]);
  });

  it("never imports replacement bytes when the source path changes mid-stream", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "source.bin");
    const movedPath = path.join(root, "source-opened.bin");
    const originalBytes = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const replacementBytes = Buffer.from("replacement path bytes");
    await writeFile(sourcePath, originalBytes);
    const store = new CacheStore(path.join(root, "cache"), {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });
    await store.initialize();
    let releaseRead!: () => void;
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const continueRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const ensureAvailableSpace = store.janitor.ensureAvailableSpace.bind(store.janitor);
    let blocked = false;
    vi.spyOn(store.janitor, "ensureAvailableSpace").mockImplementation(async (bytes) => {
      await ensureAvailableSpace(bytes);
      if (!blocked) {
        blocked = true;
        signalRead();
        await continueRead;
      }
    });

    const importing = store.importFile(sourcePath);
    await readStarted;
    await rename(sourcePath, movedPath);
    await writeFile(sourcePath, replacementBytes);
    releaseRead();
    const outcome = await importing.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );
    if (outcome.ok) {
      expect(outcome.value.sha256)
        .toBe(createHash("sha256").update(originalBytes).digest("hex"));
      await expect(readFile(outcome.value.filePath)).resolves.toEqual(originalBytes);
    } else {
      expect(outcome.error).toEqual(expect.objectContaining({ code: "import_failed" }));
    }
    expect(await store.getEntry(createHash("sha256").update(replacementBytes).digest("hex")))
      .toBeUndefined();
    await expect(readFile(sourcePath)).resolves.toEqual(replacementBytes);
  });

  it("releases a retained active task when post-commit cleanup fails", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "source.bin");
    const bytes = Buffer.from("cleanup failure fixture");
    await writeFile(sourcePath, bytes);
    const store = new CacheStore(path.join(root, "cache"), {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });
    await store.initialize();
    vi.spyOn(store.janitor, "cleanup").mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(store.importFile(sourcePath, { retainActiveTask: true }))
      .rejects.toEqual(expect.objectContaining({ code: "import_failed" }));

    expect(store.indexRepository.listReclaimableEntries().map((entry) => entry.sha256))
      .toContain(createHash("sha256").update(bytes).digest("hex"));
  });

  it("rejects an oversized shared file before creating a part", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "oversized.bin");
    const cacheRoot = path.join(root, "cache");
    await writeFile(sourcePath, Buffer.alloc(9));
    const store = new CacheStore(cacheRoot, {
      maxFileBytes: 8,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await expect(store.importFile(sourcePath)).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await partFiles(cacheRoot)).toEqual([]);
  });

  it("rejects writes before fetch when statfs cannot preserve free space", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn();
    const statfsImpl = vi.fn(async () => ({ bavail: 5, bsize: 1 }));
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minimumFreeBytes: 10,
      statfsImpl
    });

    await expect(store.downloadHttp("https://cdn.example.test/no-space"))
      .rejects.toEqual(expect.objectContaining({ code: "storage_exhausted" }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statfsImpl).toHaveBeenCalled();
    expect(await partFiles(root)).toEqual([]);
  });

  it("stops and removes the part when free space drops during streaming", async () => {
    const root = await temporaryRoot();
    let statfsReads = 0;
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      minimumFreeBytes: 10,
      fetchImpl: vi.fn(async () => responseFromChunks([Buffer.from("streaming")])) as unknown as typeof fetch,
      statfsImpl: async () => {
        statfsReads += 1;
        return { bavail: statfsReads <= 3 ? 100 : 5, bsize: 1 };
      }
    });

    await expect(store.downloadHttp("https://cdn.example.test/disk-fills"))
      .rejects.toEqual(expect.objectContaining({ code: "storage_exhausted" }));
    expect(statfsReads).toBeGreaterThan(3);
    expect(await partFiles(root)).toEqual([]);
  });

  it("reserves the hard limit despite a low Content-Length and rejects a concurrent writer", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.alloc(8, 1);
    let signalReaderStarted!: () => void;
    let releaseReader!: () => void;
    const readerStarted = new Promise<void>((resolve) => {
      signalReaderStarted = resolve;
    });
    const readerReleased = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let readCount = 0;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "1" }),
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount++ === 0) {
              signalReaderStarted();
              await readerReleased;
              return { done: false, value: bytes };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => undefined
        })
      }
    } as unknown as Response;
    const store = new CacheStore(root, {
      allowPrivateNetwork: true,
      maxFileBytes: bytes.length,
      minimumFreeBytes: 0,
      statfsImpl: async () => ({ bavail: 15, bsize: 1 }),
      fetchImpl: vi.fn(async () => response) as unknown as typeof fetch
    });

    const firstWrite = store.downloadHttp("https://cdn.example.test/first");
    await readerStarted;
    try {
      await expect(store.writeBase64(bytes.toString("base64"))).rejects.toEqual(
        expect.objectContaining({ code: "storage_exhausted" })
      );
    } finally {
      releaseReader();
    }

    await expect(firstWrite).resolves.toEqual(expect.objectContaining({ sizeBytes: bytes.length }));
    expect(await partFiles(root)).toEqual([]);
  });

  it("stores cache files as 0600 and cache directories as 0700", async () => {
    const root = await temporaryRoot();
    const temporaryDir = path.join(root, ".tmp");
    await chmod(root, 0o777);
    await mkdir(temporaryDir, { mode: 0o777 });
    await chmod(temporaryDir, 0o777);
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    const cached = await store.writeBase64(Buffer.from("private cache data").toString("base64"));
    const entryDir = path.dirname(cached.filePath);

    await expect(Promise.all([
      fileMode(root),
      fileMode(temporaryDir),
      fileMode(path.join(root, ".trash")),
      fileMode(entryDir)
    ])).resolves.toEqual([0o700, 0o700, 0o700, 0o700]);
    await expect(Promise.all([
      fileMode(cached.filePath),
      fileMode(path.join(root, "index.json"))
    ])).resolves.toEqual([0o600, 0o600]);
  });

  it("removes content-addressed cache directories missing from the index on startup", async () => {
    const root = await temporaryRoot();
    const orphanKey = "a".repeat(64);
    const orphanDir = path.join(root, orphanKey);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, "original"), "orphaned cache bytes");

    await new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    }).initialize();

    await expect(stat(orphanDir)).rejects.toEqual(expect.objectContaining({ code: "ENOENT" }));
  });

  it("rebuilds all active references in one deterministic index update", async () => {
    const root = await temporaryRoot();
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      unreferencedTtlMs: Number.MAX_SAFE_INTEGER,
      statfsImpl: ampleStatFs
    });
    const first = await store.writeBase64(Buffer.from("first").toString("base64"));
    const second = await store.writeBase64(Buffer.from("second").toString("base64"));
    await store.addReference(first.sha256, "stale-reference");
    await store.addReference(second.sha256, "another-stale-reference");

    await store.rebuildReferences([
      { cacheKey: first.sha256, reference: "conversation-b/message-2/file" },
      { cacheKey: first.sha256, reference: "conversation-a/message-1/file" },
      { cacheKey: first.sha256, reference: "conversation-b/message-2/file" },
      { cacheKey: "missing-cache-key", reference: "ignored" }
    ]);

    expect((await store.getEntry(first.sha256))?.activeReferences).toEqual([
      "conversation-a/message-1/file",
      "conversation-b/message-2/file"
    ]);
    expect((await store.getEntry(second.sha256))?.activeReferences).toEqual([]);
  });

  it("updates parse metadata and reclaims the complete entry directory after TTL", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      unreferencedTtlMs: 100,
      statfsImpl: ampleStatFs,
      now: () => new Date(now)
    });
    const cached = await store.writeBase64(Buffer.from("original").toString("base64"));
    const entryDir = path.dirname(cached.filePath);
    const artifactPath = path.join(entryDir, "chunks.sqlite");
    await writeFile(artifactPath, "parsed text");

    await expect(store.updateParseState(cached.sha256, {
      parseStatus: "ready",
      artifactsSizeBytes: 11
    })).resolves.toEqual(expect.objectContaining({
      parseStatus: "ready",
      artifactsSizeBytes: 11
    }));
    await expect(store.updateParseState(cached.sha256, {
      parseStatus: "ready",
      artifactsSizeBytes: -1
    })).rejects.toEqual(expect.objectContaining({ code: "write_failed" }));

    now += 101;
    const cleanup = await store.cleanup();

    expect(cleanup.removedCacheKeys).toEqual([cached.sha256]);
    expect(cleanup.reclaimedBytes).toBe(Buffer.byteLength("original") + 11);
    await expect(stat(entryDir)).rejects.toEqual(expect.objectContaining({ code: "ENOENT" }));
    expect(await store.getEntry(cached.sha256)).toBeUndefined();
    expect(await readdir(path.join(root, ".trash"))).toEqual([]);
  });

  it("reconciles stale artifact byte accounting when the cache restarts", async () => {
    const root = await temporaryRoot();
    const first = new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });
    const cached = await first.writeBase64(Buffer.from("source").toString("base64"));
    const artifactsDir = path.join(root, cached.cacheKey, "artifacts", "visual");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "page-1.png"), Buffer.alloc(321));
    await first.updateParseState(cached.cacheKey, {
      parseStatus: "ready",
      artifactsSizeBytes: 0
    });

    const restarted = new CacheStore(root, {
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });
    await restarted.initialize();

    expect((await restarted.getEntry(cached.cacheKey))?.artifactsSizeBytes).toBe(321);
  });

  it("uses deterministic LRU cleanup until the free-space target is restored", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    let lowDisk = false;
    let lowDiskReads = 0;
    const store = new CacheStore(root, {
      minimumFreeBytes: 100,
      unreferencedTtlMs: Number.MAX_SAFE_INTEGER,
      now: () => new Date(now),
      statfsImpl: async () => {
        if (!lowDisk) return { bavail: 1_000, bsize: 1 };
        lowDiskReads += 1;
        return { bavail: lowDiskReads === 1 ? 50 : 150, bsize: 1 };
      }
    });
    const oldest = await store.writeBase64(Buffer.from("oldest").toString("base64"));
    now += 10;
    const middle = await store.writeBase64(Buffer.from("middle").toString("base64"));
    now += 10;
    const newest = await store.writeBase64(Buffer.from("newest").toString("base64"));

    lowDisk = true;
    const cleanup = await store.cleanup();

    expect(cleanup.removedCacheKeys).toEqual([oldest.sha256]);
    expect(cleanup.availableBytes).toBe(150);
    expect(await store.getEntry(oldest.sha256)).toBeUndefined();
    expect(await store.getEntry(middle.sha256)).toBeDefined();
    expect(await store.getEntry(newest.sha256)).toBeDefined();
  });

  it("never reclaims referenced entries or entries with nested active tasks", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    const store = new CacheStore(root, {
      minimumFreeBytes: 0,
      unreferencedTtlMs: 100,
      statfsImpl: ampleStatFs,
      now: () => new Date(now)
    });
    const referenced = await store.writeBase64(Buffer.from("referenced").toString("base64"));
    now += 1;
    const active = await store.writeBase64(Buffer.from("active").toString("base64"));
    now += 1;
    const disposable = await store.writeBase64(Buffer.from("disposable").toString("base64"));
    await store.addReference(referenced.sha256, "conversation/message/file");
    await store.beginActiveTask(active.sha256);
    await store.beginActiveTask(active.sha256);

    now += 200;
    expect((await store.cleanup()).removedCacheKeys).toEqual([disposable.sha256]);
    await store.endActiveTask(active.sha256);
    expect((await store.cleanup()).removedCacheKeys).toEqual([]);

    await store.endActiveTask(active.sha256);
    await store.removeReference(referenced.sha256, "conversation/message/file");
    now += 101;
    expect((await store.cleanup()).removedCacheKeys).toEqual([
      active.sha256,
      referenced.sha256
    ]);
  });

  it("rejects local, private, link-local, reserved, multicast and mapped IP targets", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn(async () => responseFromChunks([Buffer.from("unreachable")])) as unknown as typeof fetch;
    const store = new CacheStore(root, {
      fetchImpl,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });
    const unsafeUrls = [
      "http://localhost/file",
      "http://localhost./file",
      "http://127.0.0.1/file",
      "http://2130706433/file",
      "http://10.0.0.1/file",
      "http://100.64.0.1/file",
      "http://169.254.169.254/latest/meta-data",
      "http://172.16.0.1/file",
      "http://192.168.0.1/file",
      "http://192.0.2.1/file",
      "http://198.18.0.1/file",
      "http://224.0.0.1/file",
      "http://240.0.0.1/file",
      "http://[::1]/file",
      "http://[::ffff:127.0.0.1]/file",
      "http://[::ffff:8.8.8.8]/file",
      "http://[fc00::1]/file",
      "http://[fe80::1]/file",
      "http://[ff02::1]/file",
      "http://[2001:db8::1]/file",
      "http://[2002:7f00:1::]/file"
    ];

    for (const url of unsafeUrls) {
      await expect(store.downloadHttp(url)).rejects.toEqual(
        expect.objectContaining<Partial<AttachmentCacheError>>({ code: "unsafe_url" })
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS lookup result is not public", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn(async () => responseFromChunks([Buffer.from("unreachable")])) as unknown as typeof fetch;
    const lookupImpl = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]);
    const store = new CacheStore(root, {
      fetchImpl,
      lookupImpl,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await expect(store.downloadHttp("https://downloads.example.com/file"))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "unsafe_url"
      }));
    expect(lookupImpl).toHaveBeenCalledOnce();
    expect(lookupImpl).toHaveBeenCalledWith("downloads.example.com");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows Clash fake-IP only for fixed QQ attachment CDN hostnames", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("trusted QQ CDN fixture");
    const fetchImpl = vi.fn(async () => responseFromChunks([bytes]));
    const lookupImpl = vi.fn(async () => [{ address: "198.18.0.226", family: 4 }]);
    const store = new CacheStore(root, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl,
      maxFileBytes: 1_024,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs,
      trustedResolvedAddress: isTrustedQqFakeIp
    });

    const cached = await store.downloadHttp("https://multimedia.nt.qq.com.cn/download?id=fixture");
    expect(await readFile(cached.filePath)).toEqual(bytes);

    await expect(store.downloadHttp("https://attacker.example/download"))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "unsafe_url"
      }));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("validates DNS before a custom fetch implementation", async () => {
    const root = await temporaryRoot();
    const fetchMock = vi.fn(async () => responseFromChunks([Buffer.from("pinned")]));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const store = new CacheStore(root, {
      fetchImpl,
      lookupImpl: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
      maxFileBytes: 1_024,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await store.downloadHttp("https://downloads.example.com/file");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      redirect: "manual"
    }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
  });

  it("revalidates every redirect target before issuing its request", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://private.example.com/latest" }
    }));
    const lookupImpl = vi.fn(async (hostname: string) => hostname === "public.example.com"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }]);
    const store = new CacheStore(root, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await expect(store.downloadHttp("https://public.example.com/file"))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "unsafe_url"
      }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    expect(lookupImpl.mock.calls.map(([hostname]) => hostname)).toEqual([
      "public.example.com",
      "private.example.com"
    ]);
  });

  it("follows at most five manually validated redirects", async () => {
    const root = await temporaryRoot();
    let responseCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => {
      responseCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${responseCount}` }
      });
    });
    const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const store = new CacheStore(root, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl,
      minimumFreeBytes: 0,
      statfsImpl: ampleStatFs
    });

    await expect(store.downloadHttp("https://public.example.com/start"))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "redirect_limit"
      }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(lookupImpl).toHaveBeenCalledTimes(6);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ redirect: "manual" }));
    }
  });

  it("rejects non-HTTP download URLs", async () => {
    const root = await temporaryRoot();
    const store = new CacheStore(root, {
      fetchImpl: vi.fn() as unknown as typeof fetch
    });

    await expect(store.downloadHttp("file:///tmp/secret"))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentCacheError>>({
        code: "invalid_url"
      }));
  });
});

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "sunabot-attachment-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}

function responseFromChunks(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  });
  return new Response(body, { status: 200, headers });
}

async function partFiles(root: string) {
  const temp = path.join(root, ".tmp");
  try {
    return (await readdir(temp)).filter((name) => name.endsWith(".part"));
  } catch {
    return [];
  }
}

async function ampleStatFs() {
  return { bavail: 10_000_000, bsize: 1 };
}

async function fileMode(filePath: string) {
  return (await stat(filePath)).mode & 0o777;
}
