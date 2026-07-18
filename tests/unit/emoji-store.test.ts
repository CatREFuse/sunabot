// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";

describe("emoji SQLite store", () => {
  let root = "";
  let databasePath = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emojis-"));
    databasePath = path.join(root, "sunabot.sqlite");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates schema 11 and performs isolated key to image CRUD", () => {
    const store = new ApplicationDataStore(databasePath);
    store.upsertEmoji(record("开心", "a", "upload"));
    store.upsertEmoji(record("哭", "b", "generated"));
    expect(store.readEmojis().map((emoji) => emoji.key).sort()).toEqual(["哭", "开心"]);
    expect(store.readEmoji("开心")).toMatchObject({ source: "upload", width: 1024, height: 1024 });

    store.upsertEmoji({ ...record("开心", "c", "generated"), createdAt: "2026-07-19T00:00:00.000Z" });
    expect(store.readEmoji("开心")).toMatchObject({
      fileName: fileName("c"),
      source: "generated",
      createdAt: "2026-07-18T00:00:00.000Z"
    });
    expect(store.deleteEmoji("哭")).toBe(true);
    expect(store.deleteEmoji("哭")).toBe(false);
    expect(() => store.upsertEmoji(record("表".repeat(22), "d", "upload"))).toThrow();
    expect(() => store.upsertEmoji({ ...record("认真", "e", "upload"), sizeBytes: 0 })).toThrow();
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
      .toMatchObject({ value: "11" });
    expect(String(database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'emojis'").get()?.sql ?? "").toLowerCase())
      .toContain("strict");
    database.close();
  });

  it("forward migrates a schema 10 database that has no emoji table", () => {
    const current = new ApplicationDataStore(databasePath);
    current.close();
    const old = new DatabaseSync(databasePath);
    old.exec("DROP TABLE emojis");
    old.prepare("UPDATE app_metadata SET value = '10' WHERE key = 'storage-schema-version'").run();
    old.close();

    const migrated = new ApplicationDataStore(databasePath);
    expect(migrated.readEmojis()).toEqual([]);
    migrated.close();
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
      .toMatchObject({ value: "11" });
    database.close();
  });

  it("rejects invalid Unicode before writes and hides a pre-existing poisoned key on reads", () => {
    const store = new ApplicationDataStore(databasePath);
    expect(() => store.upsertEmoji(record("\ud800", "f", "upload"))).toThrow("Emoji key is invalid");
    expect(() => store.upsertEmoji(record("开\u0085心", "g", "upload"))).toThrow("Emoji key is invalid");
    store.close();

    const poisoned = new DatabaseSync(databasePath);
    const insertPoisoned = poisoned.prepare(`
      INSERT INTO emojis (
        emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPoisoned.run(
      "\ud800",
      fileName("f"),
      "upload",
      128,
      1024,
      1024,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );
    insertPoisoned.run(
      "开\u0085心",
      fileName("g"),
      "upload",
      128,
      1024,
      1024,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );
    expect(poisoned.prepare("SELECT COUNT(*) AS count FROM emojis").get()).toMatchObject({ count: 2 });
    poisoned.close();

    const reopened = new ApplicationDataStore(databasePath);
    expect(reopened.readEmojis()).toEqual([]);
    expect(reopened.readEmoji("\ud800")).toBeUndefined();
    expect(reopened.readEmoji("开\u0085心")).toBeUndefined();
    expect(reopened.readEmoji("\ufffd")).toBeUndefined();
    reopened.close();
  });
});

function record(key: string, seed: string, source: "upload" | "generated") {
  return {
    key,
    fileName: fileName(seed),
    source,
    sizeBytes: 128,
    width: 1024,
    height: 1024,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: `2026-07-18T00:00:0${seed === "a" ? "1" : seed === "b" ? "2" : "3"}.000Z`
  };
}

function fileName(seed: string) {
  return `emoji-${seed.repeat(64)}.png`;
}
