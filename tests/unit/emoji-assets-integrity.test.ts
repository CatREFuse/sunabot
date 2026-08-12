// @vitest-environment node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmojiJsonlStore } from "../../adapters/filesystem/emojiJsonlStore.js";
import type { EmojiRecord } from "../../adapters/sqlite/applicationDataStore.js";
import type { AppConfig } from "../../src/types.js";

let root = "";
let previousWorkspace: string | undefined;
let config: AppConfig;
let store: EmojiJsonlStore;
let closeStores: typeof import("../../adapters/sqlite/applicationDataStore.js")["closeApplicationDataStores"];
let assets: typeof import("../../src/emojis/emojiAssets.js");
let jsonlStores: typeof import("../../src/emojis/emojiStore.js");
let pngA = Buffer.alloc(0);
let pngB = Buffer.alloc(0);
let agentOrdinal = 0;

beforeAll(async () => {
  previousWorkspace = process.env.SUNABOT_WORKSPACE;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-integrity-")));
  process.env.SUNABOT_WORKSPACE = root;
  vi.resetModules();
  const [sharpModule, storeModule, assetModule, jsonlStoreModule] = await Promise.all([
    import("sharp"),
    import("../../adapters/sqlite/applicationDataStore.js"),
    import("../../src/emojis/emojiAssets.js"),
    import("../../src/emojis/emojiStore.js")
  ]);
  closeStores = storeModule.closeApplicationDataStores;
  assets = assetModule;
  jsonlStores = jsonlStoreModule;
  const sharp = sharpModule.default;
  [pngA, pngB] = await Promise.all([
    sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 240, g: 80, b: 80 } } })
      .png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer(),
    sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 80, g: 80, b: 240 } } })
      .png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer()
  ]);
  expect(pngA.byteLength).toBe(pngB.byteLength);
});

beforeEach(async () => {
  const fixtures = await import("./admin-fixtures.js");
  agentOrdinal += 1;
  const agentId = `integrity-agent-${agentOrdinal}`;
  config = fixtures.createAdminTestConfig(root);
  config.persona.defaultAgentId = agentId;
  config.persona.agentWorkspace = path.join(root, "business", "agents", agentId);
  await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  store = jsonlStores.emojiStore(config);
});

afterAll(async () => {
  closeStores?.();
  if (previousWorkspace === undefined) delete process.env.SUNABOT_WORKSPACE;
  else process.env.SUNABOT_WORKSPACE = previousWorkspace;
  vi.resetModules();
  await fs.rm(root, { recursive: true, force: true });
});

describe("emoji runtime asset integrity", () => {
  it("keeps prompt catalog scanning content-free and accepts a valid normalized content-addressed PNG", async () => {
    const record = await install("开心", pngA);
    const contentAccess = watchFileContentAccess();
    try {
      expect(assets.availableEmojiRecords(config).map((item) => item.key)).toEqual(["开心"]);
      contentAccess.expectNone();
    } finally {
      contentAccess.restore();
    }

    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toEqual([record]);
    const verifiedBytes = await assets.readVerifiedEmojiRecordFile(config, record);
    expect(verifiedBytes.equals(pngA)).toBe(true);
  });

  it("builds a 64-entry prompt catalog and selected-marker plan without reading image contents", async () => {
    const shared = await install("自定义0", pngA);
    for (let index = 1; index < 64; index += 1) {
      await store.upsert({ ...shared, key: `自定义${index}` });
    }
    const contentAccess = watchFileContentAccess();
    try {
      expect(assets.availableEmojiRecords(config)).toHaveLength(64);
      const plan = assets.planAgentEmojiMarkers("使用[/自定义63]", config);
      expect(plan.expectedKeys).toEqual(["自定义63"]);
      expect(plan.catalog.size).toBe(64);
      contentAccess.expectNone();
    } finally {
      contentAccess.restore();
    }
  }, 15_000);

  it("fails a selected marker after same-size corruption while an unselected valid marker still passes", async () => {
    const corruptedRecord = await install("开心", pngA);
    const validRecord = await install("认真", pngB);
    const corruptedPlan = assets.planAgentEmojiMarkers("前[/开心]后", config);
    const validPlan = assets.planAgentEmojiMarkers("前[/认真]后", config);
    const corruptedPath = assets.emojiMediaLocation(config, corruptedRecord.fileName).filePath;
    const corrupted = Buffer.from(pngA);
    corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 0xff;
    await fs.writeFile(corruptedPath, corrupted);

    expect(assets.availableEmojiRecords(config).map((record) => record.key).sort()).toEqual(["开心", "认真"]);
    const open = vi.spyOn(fs, "open");
    await expect(assets.assertPlannedEmojiAssetsIntegrity(config, validPlan)).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    expect(path.resolve(String(open.mock.calls[0]?.[0]))).toBe(
      path.resolve(assets.emojiMediaLocation(config, validRecord.fileName).filePath)
    );
    open.mockRestore();
    await expect(assets.assertPlannedEmojiAssetsIntegrity(config, corruptedPlan))
      .rejects.toThrow("表情图片已损坏或不可用");
    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toMatchObject([{ key: "认真" }]);

    await fs.writeFile(corruptedPath, pngA);
    await expect(assets.assertPlannedEmojiAssetsIntegrity(config, corruptedPlan)).resolves.toBeUndefined();
  });

  it("hides equal-size valid PNG files when their content-addressed locations are swapped", async () => {
    const first = await install("认真", pngA);
    const second = await install("哭", pngB);
    const plan = assets.planAgentEmojiMarkers("[/认真][/哭]", config);
    const firstPath = assets.emojiMediaLocation(config, first.fileName).filePath;
    const secondPath = assets.emojiMediaLocation(config, second.fileName).filePath;
    await Promise.all([fs.writeFile(firstPath, pngB), fs.writeFile(secondPath, pngA)]);

    expect(assets.availableEmojiRecords(config).map((record) => record.key).sort()).toEqual(["哭", "认真"]);
    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toEqual([]);
    await expect(assets.assertPlannedEmojiAssetsIntegrity(config, plan))
      .rejects.toThrow("表情图片已损坏或不可用");
  });

  it("rejects same-size non-PNG bytes even when their content-addressed file name matches", async () => {
    const nonPng = Buffer.alloc(pngA.byteLength, 0x61);
    await install("汗颜", nonPng);
    expect(assets.availableEmojiRecords(config)).toMatchObject([{ key: "汗颜" }]);
    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toEqual([]);
  });

  it("rejects a self-hashed 1024 IHDR prefix that has no decodable PNG body", async () => {
    const fakePng = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(fakePng, 0);
    fakePng.writeUInt32BE(13, 8);
    fakePng.write("IHDR", 12, "ascii");
    fakePng.writeUInt32BE(1024, 16);
    fakePng.writeUInt32BE(1024, 20);
    fakePng[24] = 8;
    fakePng[25] = 2;
    await install("生气", fakePng);
    expect(assets.availableEmojiRecords(config)).toMatchObject([{ key: "生气" }]);
    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toEqual([]);
  });

  it("rejects a correctly hashed PNG that is not normalized to 1024 square", async () => {
    const sharp = (await import("sharp")).default;
    const smallPng = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } }
    }).png().toBuffer();
    await install("困倦", smallPng);
    expect(assets.availableEmojiRecords(config)).toMatchObject([{ key: "困倦" }]);
    await expect(assets.filterVerifiedEmojiRecords(config)).resolves.toEqual([]);
  });

  it("hashes an unchanged fingerprint once and revalidates after the file identity changes", async () => {
    const record = await install("害羞", pngA);
    const plan = assets.planAgentEmojiMarkers("[/害羞]", config);
    const createHash = vi.spyOn(crypto, "createHash");
    await assets.assertPlannedEmojiAssetsIntegrity(config, plan);
    const firstCount = createHash.mock.calls.filter(([algorithm]) => algorithm === "sha256").length;
    expect(firstCount).toBe(1);

    await assets.assertPlannedEmojiAssetsIntegrity(config, plan);
    expect(createHash.mock.calls.filter(([algorithm]) => algorithm === "sha256")).toHaveLength(firstCount);

    const filePath = assets.emojiMediaLocation(config, record.fileName).filePath;
    await fs.writeFile(filePath, pngA);
    await assets.assertPlannedEmojiAssetsIntegrity(config, plan);
    expect(createHash.mock.calls.filter(([algorithm]) => algorithm === "sha256")).toHaveLength(firstCount + 1);
    createHash.mockRestore();
  });

  it("bounds integrity work to two active and two waiting tasks, rejects overflow, then releases admission", async () => {
    const gate = new assets.EmojiAssetIntegrityGate();
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const tasks = Array.from({ length: 4 }, () => gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await blocked;
      active -= 1;
    }));
    const rejected = gate.run(async () => undefined);
    await expect(rejected).rejects.toBeInstanceOf(assets.EmojiAssetIntegrityBusyError);
    await vi.waitFor(() => expect(active).toBe(2));
    expect(peak).toBe(2);
    release();
    await Promise.all(tasks);
    expect(peak).toBe(2);
    await expect(gate.run(async () => "released")).resolves.toBe("released");
  });

  it("coalesces concurrent list verification for the same path into one identity and scan operation", async () => {
    const record = await install("认真", pngA);
    const open = vi.spyOn(fs, "open");
    const createHash = vi.spyOn(crypto, "createHash");
    try {
      const listed = await Promise.all(Array.from({ length: 16 }, () => (
        assets.filterVerifiedEmojiRecords(config, [record])
      )));
      expect(listed.every((records) => records.length === 1 && records[0]?.key === "认真")).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(createHash.mock.calls.filter(([algorithm]) => algorithm === "sha256")).toHaveLength(1);
    } finally {
      open.mockRestore();
      createHash.mockRestore();
    }
  });

  it("bounds list metadata work, rejects overflow without queuing, and admits it after release", async () => {
    const sharp = (await import("sharp")).default;
    const pngs = await Promise.all(Array.from({ length: 5 }, (_, index) => sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 20 + index * 30, g: 40 + index * 20, b: 220 - index * 25 }
      }
    }).png().toBuffer()));
    const records = [];
    for (let index = 0; index < pngs.length; index += 1) {
      records.push(await install(`并发${index}`, pngs[index]!));
    }
    const realpath = fs.realpath.bind(fs);
    let activeMetadata = 0;
    let peakMetadata = 0;
    let release!: () => void;
    let released = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
      activeMetadata += 1;
      peakMetadata = Math.max(peakMetadata, activeMetadata);
      await blocked;
      try {
        return await realpath(target);
      } finally {
        activeMetadata -= 1;
      }
    });
    const first = assets.filterVerifiedEmojiRecords(config, records.slice(0, 2));
    await vi.waitFor(() => expect(activeMetadata).toBe(2));
    const second = assets.filterVerifiedEmojiRecords(config, records.slice(2, 4));
    const overflow = assets.filterVerifiedEmojiRecords(config, records.slice(4));
    try {
      await expect(overflow).resolves.toEqual([]);
      expect(activeMetadata).toBe(2);
      expect(peakMetadata).toBe(2);
      released = true;
      release();
      await expect(first).resolves.toHaveLength(2);
      await expect(second).resolves.toHaveLength(2);
      await expect(assets.filterVerifiedEmojiRecords(config, records.slice(4))).resolves.toHaveLength(1);
      expect(peakMetadata).toBe(2);
    } finally {
      if (!released) release();
      realpathSpy.mockRestore();
      await Promise.allSettled([first, second]);
    }
  });

  it("rejects a stable Agent media parent symlink before opening the selected file", async () => {
    const hash = crypto.createHash("sha256").update(pngA).digest("hex");
    const fileName = `emoji-${hash}.png`;
    const location = assets.emojiMediaLocation(config, fileName);
    const agentDirectory = path.dirname(location.filePath);
    const externalDirectory = path.join(root, `external-media-${agentOrdinal}`);
    await fs.mkdir(agentDirectory, { recursive: true });
    await fs.writeFile(path.join(agentDirectory, fileName), pngA);
    const now = new Date().toISOString();
    await store.upsert({
      key: "极度害羞",
      fileName,
      source: "generated",
      sizeBytes: pngA.byteLength,
      width: 1024,
      height: 1024,
      createdAt: now,
      updatedAt: now
    });
    await fs.rename(agentDirectory, externalDirectory);
    await fs.symlink(externalDirectory, agentDirectory, process.platform === "win32" ? "junction" : "dir");
    expect(assets.availableEmojiRecords(config)).toMatchObject([{ key: "极度害羞" }]);
    const plan = assets.planAgentEmojiMarkers("[/极度害羞]", config);
    const open = vi.spyOn(fs, "open");
    try {
      await expect(assets.assertPlannedEmojiAssetsIntegrity(config, plan))
        .rejects.toThrow("表情图片已损坏或不可用");
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("fails a selected marker before open or read when O_NOFOLLOW is unavailable", async () => {
    await install("惊慌", pngA);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const open = vi.fn(async () => { throw new Error("open must not be called"); });
    const readFile = vi.fn(async () => { throw new Error("read must not be called"); });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      default: {
        ...actualFs,
        constants: { ...actualFs.constants, O_NOFOLLOW: undefined }
      }
    }));
    vi.doMock("node:fs/promises", () => ({
      ...actualPromises,
      open,
      readFile,
      default: { ...actualPromises, open, readFile }
    }));
    vi.resetModules();
    try {
      const isolatedAssets = await import("../../src/emojis/emojiAssets.js");
      expect(() => isolatedAssets.planAgentEmojiMarkers("[/惊慌]", config))
        .toThrow("Emoji catalog no-follow reads are unavailable");
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      const isolatedStore = await import("../../adapters/sqlite/applicationDataStore.js");
      isolatedStore.closeApplicationDataStores();
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

async function install(
  key: string,
  bytes: Buffer,
  dimensions: Pick<EmojiRecord, "width" | "height"> = { width: 1024, height: 1024 }
) {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const fileName = `emoji-${hash}.png`;
  const filePath = assets.emojiMediaLocation(config, fileName).filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  const now = new Date().toISOString();
  const record: EmojiRecord = {
    key,
    fileName,
    source: "generated",
    sizeBytes: bytes.byteLength,
    ...dimensions,
    createdAt: now,
    updatedAt: now
  };
  await store.upsert(record);
  return record;
}

function watchFileContentAccess() {
  const spies = [
    vi.spyOn(fsSync, "readFileSync"),
    vi.spyOn(fsSync, "openSync"),
    vi.spyOn(fsSync, "readSync"),
    vi.spyOn(fs, "open"),
    vi.spyOn(fs, "readFile")
  ];
  return {
    expectNone() {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    }
  };
}
