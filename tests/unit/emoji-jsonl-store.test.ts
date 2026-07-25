// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmojiJsonlStore } from "../../adapters/filesystem/emojiJsonlStore.js";
import type { EmojiRecord, EmojiVersionRecord } from "../../adapters/sqlite/applicationDataStore.js";

describe("emoji JSONL store", () => {
  let root = "";
  let catalogPath = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-jsonl-"));
    catalogPath = path.join(root, "emojis", "emojis.jsonl");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("migrates legacy current records and version history into the image directory once", async () => {
    const current = record("开心", "b", "generated", "2026-07-18T00:00:03.000Z");
    const versions = [
      version(record("开心", "b", "generated", "2026-07-18T00:00:03.000Z"), true),
      version(record("开心", "a", "upload", "2026-07-18T00:00:01.000Z"), false)
    ];
    const store = new EmojiJsonlStore(catalogPath, {
      current: [current],
      versions: () => versions
    });

    expect(store.read("开心")).toMatchObject({ fileName: fileName("b"), source: "generated" });
    expect(store.readVersions("开心")).toEqual([
      expect.objectContaining({ fileName: fileName("b"), current: true }),
      expect.objectContaining({ fileName: fileName("a"), current: false })
    ]);

    const lines = (await fs.readFile(catalogPath, "utf8")).trim().split("\n");
    expect(path.dirname(catalogPath)).toBe(path.join(root, "emojis"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: 1,
      key: "开心",
      currentFileName: fileName("b"),
      versions: [
        expect.objectContaining({ fileName: fileName("b") }),
        expect.objectContaining({ fileName: fileName("a") })
      ]
    });

    const reopened = new EmojiJsonlStore(catalogPath, {
      current: [record("旧数据", "c", "upload", "2026-07-18T00:00:04.000Z")],
      versions: () => []
    });
    expect(reopened.readAll().map((item) => item.key)).toEqual(["开心"]);
  });

  it("keeps key and version CRUD durable across reopen", async () => {
    const store = new EmojiJsonlStore(catalogPath);
    await store.upsert(record("开心", "a", "upload", "2026-07-18T00:00:01.000Z"));
    await store.upsert(record("开心", "b", "generated", "2026-07-18T00:00:02.000Z"));
    await store.upsert(record("哭", "c", "upload", "2026-07-18T00:00:03.000Z"));
    await expect(store.deleteVersion("开心", fileName("b"))).resolves.toBe("current");
    await expect(store.deleteVersion("开心", fileName("a"))).resolves.toBe("deleted");
    await expect(store.rename("开心", "大笑", "2026-07-18T00:00:04.000Z")).resolves.toBe("renamed");
    await expect(store.rename("大笑", "哭", "2026-07-18T00:00:05.000Z")).resolves.toBe("conflict");
    await expect(store.delete("哭")).resolves.toBe(true);

    const reopened = new EmojiJsonlStore(catalogPath);
    expect(reopened.readAll()).toEqual([
      expect.objectContaining({ key: "大笑", fileName: fileName("b") })
    ]);
    expect(reopened.readVersions("大笑")).toEqual([
      expect.objectContaining({ fileName: fileName("b"), current: true })
    ]);
  });

  it("reloads an externally replaced valid catalog and rejects unknown fields", async () => {
    const store = new EmojiJsonlStore(catalogPath);
    await store.upsert(record("开心", "a", "upload", "2026-07-18T00:00:01.000Z"));
    expect(store.readAll().map((item) => item.key)).toEqual(["开心"]);

    const line = JSON.parse((await fs.readFile(catalogPath, "utf8")).trim());
    line.key = "认真";
    const replacement = path.join(path.dirname(catalogPath), "replacement.jsonl");
    await fs.writeFile(replacement, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await fs.rename(replacement, catalogPath);
    expect(store.readAll().map((item) => item.key)).toEqual(["认真"]);

    line.extra = true;
    await fs.writeFile(replacement, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await fs.rename(replacement, catalogPath);
    expect(() => store.readAll()).toThrow("fields are invalid");
  });
});

function record(
  key: string,
  seed: string,
  source: "upload" | "generated",
  updatedAt: string
): EmojiRecord {
  return {
    key,
    fileName: fileName(seed),
    source,
    sizeBytes: 128,
    width: 1024,
    height: 1024,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt
  };
}

function version(value: EmojiRecord, current: boolean): EmojiVersionRecord {
  return { ...value, current };
}

function fileName(seed: string) {
  return `emoji-${seed.repeat(64)}.png`;
}
