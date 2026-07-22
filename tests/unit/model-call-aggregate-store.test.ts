// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";

describe("model call SQLite aggregates", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-model-calls-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("forward-migrates response logs and reads exact conversation aggregates", () => {
    const databasePath = path.join(root, "sunabot.sqlite");
    seedVersionTwoDatabase(databasePath, [
      response("reply-ok", "group:7", "reply", undefined, { input_tokens: 8, output_tokens: 2, total_tokens: 10 }),
      response("reply-failed", "group:7", "reply"),
      response("memory", "group:7", "memory", "working", { input_tokens: 6, output_tokens: 4, total_tokens: 10 }),
      response("other-group", "group:70", "reply", undefined, { input_tokens: 80, output_tokens: 20, total_tokens: 100 })
    ]);

    const store = new ApplicationDataStore(databasePath);
    expect(store.readModelCallAggregateRows("group:7")).toEqual([
      expect.objectContaining({
        behavior: "memory",
        memoryKind: "working_long_term",
        requests: 1,
        total: 10
      }),
      expect.objectContaining({
        behavior: "reply",
        memoryKind: "",
        requests: 2,
        total: 10
      })
    ]);
    expect(store.readModelCallAggregateRows("group:70")).toEqual([
      expect.objectContaining({ behavior: "reply", requests: 1, total: 100 })
    ]);
    expect(store.readModelCallAggregateRows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ behavior: "memory", requests: 1, total: 10 }),
      expect.objectContaining({ behavior: "reply", requests: 3, total: 110 })
    ]));
    expect(store.readModelCallModelAggregateRows("group:7")).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "gpt-test", behavior: "reply", requests: 2, total: 10 }),
      expect.objectContaining({ model: "gpt-test", behavior: "memory", requests: 1, total: 10 })
    ]));
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
      .toMatchObject({ value: "17" });
    const indexes = database.prepare("PRAGMA index_list('model_call_aggregates')").all() as Array<{ name?: unknown }>;
    expect(indexes.map((row) => String(row.name))).toContain("model_call_aggregates_behavior");
    const modelIndexes = database.prepare("PRAGMA index_list('model_call_model_aggregates')").all() as Array<{ name?: unknown }>;
    expect(modelIndexes.map((row) => String(row.name))).toContain("model_call_model_aggregates_lookup");
    database.close();
  });

  it("repairs model aggregates when a version-six database is stale", () => {
    const databasePath = path.join(root, "sunabot.sqlite");
    seedDatabase(databasePath, 6, [
      response("late-reply", "group:8", "reply", undefined, { input_tokens: 80, output_tokens: 20, total_tokens: 100 })
    ]);

    const store = new ApplicationDataStore(databasePath);
    expect(store.readModelCallModelAggregateRows("group:8")).toEqual([
      expect.objectContaining({ model: "gpt-test", behavior: "reply", requests: 1, total: 100 })
    ]);
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
      .toMatchObject({ value: "17" });
    database.close();
  });
});

function seedVersionTwoDatabase(databasePath: string, records: Array<Record<string, unknown>>) {
  seedDatabase(databasePath, 2, records);
}

function seedDatabase(databasePath: string, version: number, records: Array<Record<string, unknown>>) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_metadata (key, value) VALUES ('storage-schema-version', '${version}');
    CREATE TABLE request_logs (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
  `);
  const insert = database.prepare(`
    INSERT INTO request_logs (id, at, category, action, search_text, data_json)
    VALUES (?, ?, 'model.response', 'responses.complete', '', ?)
  `);
  records.forEach((record, index) => insert.run(String(record.id), `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`, JSON.stringify(record)));
  database.close();
}

function response(
  id: string,
  conversationId: string,
  stage: string,
  memoryKind?: string,
  usage?: Record<string, number>
) {
  return {
    id,
    at: "2026-07-13T00:00:00.000Z",
    category: "model.response",
    action: "responses.complete",
    model: "gpt-test",
    response: usage ? { usage } : { ok: false, error: "failed" },
    metadata: { conversationId, stage, ...(memoryKind ? { memoryKind } : {}) }
  };
}
