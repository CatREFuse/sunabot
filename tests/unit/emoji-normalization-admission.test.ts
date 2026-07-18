// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let previousWorkspace: string | undefined;
let closeStores: (() => void) | undefined;

beforeEach(async () => {
  previousWorkspace = process.env.SUNABOT_WORKSPACE;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-admission-")));
  process.env.SUNABOT_WORKSPACE = root;
  vi.resetModules();
});

afterEach(async () => {
  closeStores?.();
  closeStores = undefined;
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  await fs.rm(root, { recursive: true, force: true });
  if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
  else process.env.SUNABOT_WORKSPACE = previousWorkspace;
});

describe("emoji normalization repository admission", () => {
  it("rejects before upload decoding or generated-file reads and releases after failure", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const gate = new gateModule.EmojiNormalizationGate(1);
    const repository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate
    });
    const held = gate.tryAcquire("plana");
    expect(held.ok).toBe(true);

    const uploadDataRead = vi.fn();
    const uploadInput: Record<string, unknown> = {
      key: "开心",
      fileName: "invalid.png"
    };
    Object.defineProperty(uploadInput, "dataBase64", {
      enumerable: true,
      get: () => {
        uploadDataRead();
        return "%%%%";
      }
    });
    const generatedFileRead = vi.fn();
    const generatedImage = {
      url: "/generated-images/missing.png",
      get filePath() {
        generatedFileRead();
        return path.join(root, "missing.png");
      }
    };
    await expect(repository.upload(uploadInput))
      .rejects.toBeInstanceOf(gateModule.EmojiNormalizationBusyError);
    await expect(repository.bindGenerated("开心", generatedImage))
      .rejects.toBeInstanceOf(gateModule.EmojiNormalizationBusyError);
    expect(uploadDataRead).not.toHaveBeenCalled();
    expect(generatedFileRead).not.toHaveBeenCalled();
    await expect(fs.access(storeModule.applicationDatabasePath(config)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "business", "media", "images")))
      .rejects.toMatchObject({ code: "ENOENT" });

    if (held.ok) held.release();
    await expect(repository.upload({
      key: "开心",
      fileName: "invalid.png",
      dataBase64: "%%%%"
    })).rejects.toMatchObject({ code: "EMOJI_BASE64_INVALID" });

    const png = await sharpModule.default({
      create: {
        width: 24,
        height: 24,
        channels: 3,
        background: { r: 20, g: 80, b: 160 }
      }
    }).png().toBuffer();
    const saved = await repository.upload({
      key: "开心",
      fileName: "valid.png",
      dataBase64: png.toString("base64")
    });
    expect(saved.emojis).toHaveLength(1);
    expect(storeModule.applicationDataStore(config).readEmoji("开心")).toMatchObject({
      key: "开心",
      width: 1024,
      height: 1024
    });
  });

  it("releases the slot after parsing, Sharp, and save failures", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule, mutationModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js"),
      import("../../src/admin/mutation.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const png = await sharpModule.default({
      create: {
        width: 24,
        height: 24,
        channels: 3,
        background: { r: 20, g: 80, b: 160 }
      }
    }).png().toBuffer();
    const upload = (repository: InstanceType<typeof repositoryModule.EmojiLibraryRepository>, key: string) => (
      repository.upload({
        key,
        fileName: `${key}.png`,
        dataBase64: png.toString("base64")
      })
    );

    const parseRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1)
    });
    await expect(parseRepository.upload({
      key: "开心",
      fileName: "invalid.png",
      dataBase64: "%%%%"
    })).rejects.toMatchObject({ code: "EMOJI_BASE64_INVALID" });
    await expect(upload(parseRepository, "开心")).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "开心" })])
    });

    const sharpRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1)
    });
    const corruptPng = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await expect(sharpRepository.upload({
      key: "哭",
      fileName: "corrupt.png",
      dataBase64: corruptPng.toString("base64")
    })).rejects.toMatchObject({ code: "EMOJI_IMAGE_INVALID" });
    await expect(upload(sharpRepository, "哭")).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "哭" })])
    });

    class FailOnceMutex extends mutationModule.AdminMutationMutex {
      private failNext = true;

      override async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("injected save failure");
        }
        return super.runExclusive(operation);
      }
    }
    const saveRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1),
      mutex: new FailOnceMutex()
    });
    await expect(upload(saveRepository, "认真")).rejects.toThrow("injected save failure");
    await expect(upload(saveRepository, "认真")).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "认真" })])
    });
  });

  it("rejects a generated source path swap after descriptor open and releases the slot", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const gate = new gateModule.EmojiNormalizationGate(1);
    const sourcePath = path.join(root, "business", "media", "images", "provider.png");
    const backupPath = `${sourcePath}.opened`;
    const [green, blue] = await Promise.all([
      testPng(sharpModule.default, { r: 30, g: 180, b: 80 }),
      testPng(sharpModule.default, { r: 40, g: 70, b: 220 })
    ]);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, green);
    let swapped = false;
    const repository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate,
      hooks: {
        async afterGeneratedSourceOpened() {
          if (swapped) return;
          swapped = true;
          await fs.rename(sourcePath, backupPath);
          await fs.writeFile(sourcePath, blue);
        }
      }
    });

    await expect(repository.bindGenerated("开心", {
      url: "/generated-images/provider.png",
      filePath: sourcePath
    })).rejects.toMatchObject({ code: "EMOJI_GENERATION_UNAVAILABLE", statusCode: 502 });
    expect(storeModule.applicationDataStore(config).readEmojis()).toEqual([]);

    await fs.unlink(sourcePath);
    await fs.rename(backupPath, sourcePath);
    let mutated = false;
    const mutateRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate,
      hooks: {
        async afterGeneratedSourceRead() {
          if (mutated) return;
          mutated = true;
          await fs.writeFile(sourcePath, blue);
        }
      }
    });
    await expect(mutateRepository.bindGenerated("开心", {
      url: "/generated-images/provider.png",
      filePath: sourcePath
    })).rejects.toMatchObject({ code: "EMOJI_GENERATION_UNAVAILABLE", statusCode: 502 });
    expect(storeModule.applicationDataStore(config).readEmojis()).toEqual([]);
    await fs.writeFile(sourcePath, green);
    await expect(repository.bindGenerated("开心", {
      url: "/generated-images/provider.png",
      filePath: sourcePath
    })).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "开心", source: "generated" })])
    });
  });

  it("fails generated binding before open when O_NOFOLLOW is unavailable and releases admission", async () => {
    const sourcePath = path.join(root, "business", "media", "images", "provider.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const open = vi.fn(actualPromises.open);
    vi.doMock("node:fs", () => ({
      ...actualFs,
      default: actualFs.default,
      constants: { ...actualFs.constants, O_NOFOLLOW: undefined }
    }));
    vi.doMock("node:fs/promises", () => ({
      ...actualPromises,
      default: { ...actualPromises, open },
      open
    }));
    vi.resetModules();
    const [repositoryModule, gateModule, storeModule] = await Promise.all([
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const gate = new gateModule.EmojiNormalizationGate(1);
    const repository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate
    });

    await expect(repository.bindGenerated("开心", {
      url: "/generated-images/provider.png",
      filePath: sourcePath
    })).rejects.toMatchObject({ code: "EMOJI_GENERATION_UNAVAILABLE", statusCode: 502 });
    expect(open).not.toHaveBeenCalled();
    await expect(fs.access(storeModule.applicationDatabasePath(config)))
      .rejects.toMatchObject({ code: "ENOENT" });
    const admission = gate.tryAcquire("plana");
    expect(admission.ok).toBe(true);
    if (admission.ok) admission.release();
  });

  it("binds each missing publish directory before mkdir and never creates in a swapped outside parent", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const gate = new gateModule.EmojiNormalizationGate(1);
    const png = await testPng(sharpModule.default, { r: 120, g: 40, b: 180 });
    const directory = path.join(root, "business", "media", "images");
    const parent = path.dirname(directory);
    const movedParent = `${parent}.bound`;
    const outside = path.join(root, "outside-mkdir");
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(sentinel, "unchanged\n");
    let raced = false;
    const repository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate,
      hooks: {
        async beforePublishDirectoryCreate({ directory: candidate }) {
          if (candidate !== directory || raced) return;
          raced = true;
          await fs.rename(parent, movedParent);
          await fs.symlink(outside, parent, "dir");
        }
      }
    });

    await expect(uploadPng(repository, "开心", png))
      .rejects.toMatchObject({ code: "EMOJI_PATH_INVALID", statusCode: 500 });
    expect(raced).toBe(true);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
    expect(await fs.readdir(outside)).toEqual(["sentinel.txt"]);
    expect(await fs.readdir(path.join(movedParent, "images"))).toEqual([]);
    expect(storeModule.applicationDataStore(config).readEmojis()).toEqual([]);

    await fs.unlink(parent);
    await fs.rename(movedParent, parent);
    const cleanRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate
    });
    await expect(uploadPng(cleanRepository, "开心", png)).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "开心" })])
    });
  });

  it("rejects parent symlink and new-inode races before publishing outside the Agent media directory", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const gate = new gateModule.EmojiNormalizationGate(1);
    const png = await testPng(sharpModule.default, { r: 20, g: 80, b: 160 });
    const directory = path.join(root, "business", "media", "images");
    const movedDirectory = `${directory}.frozen`;
    const external = path.join(root, "external-media");
    await fs.mkdir(external, { recursive: true });
    let raced = false;
    const repository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate,
      hooks: {
        async afterPublishDirectoryFrozen() {
          if (raced) return;
          raced = true;
          await fs.rename(directory, movedDirectory);
          await fs.symlink(external, directory, "dir");
        }
      }
    });

    await expect(uploadPng(repository, "开心", png))
      .rejects.toMatchObject({ code: "EMOJI_PATH_INVALID", statusCode: 500 });
    expect(await fs.readdir(external)).toEqual([]);
    expect(storeModule.applicationDataStore(config).readEmojis()).toEqual([]);

    await fs.unlink(directory);
    await fs.rename(movedDirectory, directory);
    const cleanRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: gate
    });
    await expect(uploadPng(cleanRepository, "开心", png)).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "开心" })])
    });
  });

  it("rejects worker-bound parent and published inode swaps with zero mapping writes", async () => {
    const [sharpModule, repositoryModule, gateModule, storeModule] = await Promise.all([
      import("sharp"),
      import("../../src/admin/emojiLibrary.js"),
      import("../../services/emojis/emojiOperationGate.js"),
      import("../../adapters/sqlite/applicationDataStore.js")
    ]);
    closeStores = storeModule.closeApplicationDataStores;
    const config = createAdminTestConfig(root);
    const png = await testPng(sharpModule.default, { r: 180, g: 70, b: 20 });
    const directory = path.join(root, "business", "media", "images");

    const movedDirectory = `${directory}.before-publish`;
    const outsideDirectory = path.join(root, "outside-publish");
    const outsideSentinel = path.join(outsideDirectory, "sentinel.txt");
    await fs.mkdir(outsideDirectory, { mode: 0o700 });
    await fs.writeFile(outsideSentinel, "unchanged\n");
    let publishTarget = "";
    let entriesBeforeCommand: string[] | undefined;
    const parentSwapRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1),
      hooks: {
        async beforePublish({ filePath }) {
          publishTarget = path.basename(filePath);
          entriesBeforeCommand = await fs.readdir(directory);
          await fs.rename(directory, movedDirectory);
          await fs.symlink(outsideDirectory, directory, "dir");
        }
      }
    });
    await expect(uploadPng(parentSwapRepository, "惊慌", png))
      .rejects.toMatchObject({ code: "EMOJI_PATH_INVALID", statusCode: 500 });
    expect(entriesBeforeCommand).toEqual([]);
    expect(await fs.readFile(outsideSentinel, "utf8")).toBe("unchanged\n");
    expect(await fs.readdir(outsideDirectory)).toEqual(["sentinel.txt"]);
    expect(await fs.readdir(movedDirectory)).toEqual([]);
    await expect(fs.access(path.join(movedDirectory, publishTarget)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(storeModule.applicationDataStore(config).readEmoji("惊慌")).toBeUndefined();
    await fs.unlink(directory);
    await fs.rename(movedDirectory, directory);

    let publishedBackup = "";
    const publishedSwapRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1),
      hooks: {
        async afterPublish({ filePath }) {
          publishedBackup = `${filePath}.published`;
          await fs.rename(filePath, publishedBackup);
          await fs.writeFile(filePath, Buffer.from("replacement"));
        }
      }
    });
    await expect(uploadPng(publishedSwapRepository, "汗颜", png))
      .rejects.toMatchObject({ code: "EMOJI_IMAGE_CONFLICT", statusCode: 409 });
    expect(storeModule.applicationDataStore(config).readEmoji("汗颜")).toBeUndefined();
    await fs.unlink(path.join(directory, path.basename(publishedBackup).replace(/\.published$/u, "")));
    await fs.rename(publishedBackup, publishedBackup.replace(/\.published$/u, ""));

    const cleanRepository = new repositoryModule.EmojiLibraryRepository({
      getConfig: () => config,
      normalizationGate: new gateModule.EmojiNormalizationGate(1)
    });
    await expect(uploadPng(cleanRepository, "汗颜", png)).resolves.toMatchObject({
      emojis: expect.arrayContaining([expect.objectContaining({ key: "汗颜" })])
    });
  });
});

function uploadPng(
  repository: { upload(input: unknown): Promise<unknown> },
  key: string,
  png: Buffer
) {
  return repository.upload({
    key,
    fileName: `${key}.png`,
    dataBase64: png.toString("base64")
  });
}

function testPng(
  sharp: typeof import("sharp")["default"],
  background: { r: number; g: number; b: number }
) {
  return sharp({
    create: { width: 24, height: 24, channels: 3, background }
  }).png().toBuffer();
}
