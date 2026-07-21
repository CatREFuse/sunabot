// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  appendMemoryFacts,
  createMemoryEntry,
  readMemorySourceEntries,
  readWorkingMemorySnapshot,
  replaceWorkingMemoryFacts
} from "../../services/memory/public.js";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("admin memory mutations", () => {
  let rootDir = "";
  let config: AppConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-admin-"));
    config = createAdminTestConfig(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("keeps every record when creates run concurrently", async () => {
    const expectedTexts = Array.from({ length: 24 }, (_, index) => `concurrent memory ${index}`);

    const created = await Promise.all(expectedTexts.map((text) => createMemoryEntry(config, {
      source: "working",
      text
    })));
    const stored = await readMemorySourceEntries(config, "working");

    expect(new Set(created.map((entry) => entry.id)).size).toBe(expectedTexts.length);
    expect(stored).toHaveLength(expectedTexts.length);
    expect(stored.map((entry) => entry.text).sort()).toEqual(expectedTexts.sort());
    expect(applicationDataStore(config).counts().workingMemory).toBe(expectedTexts.length);
  });

  it.each([
    [{ source: "unknown", text: "value" }, "MEMORY_SOURCE_INVALID", "source"],
    [{ source: "diary", text: "value" }, "MEMORY_SOURCE_INVALID", "source"],
    [{ source: "working", text: "  " }, "MEMORY_INVALID", "text"]
  ] as const)("returns a ServiceError for invalid create input %#", async (input, code, field) => {
    const error = await createMemoryEntry(config, input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ statusCode: 400, code, field });
  });

  it("atomically replaces a working-memory snapshot and preserves reusable metadata", async () => {
    const [first, duplicate] = await appendMemoryFacts(config, "working", [
      { fact: "QQ 10001 喜欢海边。", time: "2026-07-01T00:00:00.000Z", userIds: ["10001"] },
      { fact: "10001 偏好去海边。", time: "2026-07-02T00:00:00.000Z", userIds: ["10001"] }
    ], { source: "test.original" });
    const snapshot = await readWorkingMemorySnapshot(config);

    const result = await replaceWorkingMemoryFacts(config, [
      {
        id: first!.id,
        fact: "海边用户（QQ 10001）喜欢海边旅行。",
        time: "2026-07-01T00:00:00.000Z/2026-07-02T00:00:00.000Z",
        userIds: ["10001"],
        addressNames: ["海边用户"]
      },
      { id: "invented-id", fact: "QQ 20002 喜欢登山。", userIds: ["20002"] }
    ], {
      expectedSnapshotToken: snapshot.token,
      metadata: { source: "test.merge" }
    });

    expect(result.status).toBe("applied");
    const stored = await readMemorySourceEntries(config, "working");
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      id: first!.id,
      text: "海边用户（QQ 10001）喜欢海边旅行。",
      createdAt: first!.createdAt,
      updatedAt: expect.any(String),
      userIds: ["10001"],
      addressNames: ["海边用户"]
    });
    expect(stored.map((entry) => entry.id)).not.toContain(duplicate!.id);
    expect(stored[1]!.id).not.toBe("invented-id");
    expect(stored[1]!.text).toBe("QQ 20002 喜欢登山。");
  });

  it("does not reuse the same old id for two replacement facts", async () => {
    const [original] = await appendMemoryFacts(config, "working", [{ fact: "旧事实" }]);
    const snapshot = await readWorkingMemorySnapshot(config);

    const result = await replaceWorkingMemoryFacts(config, [
      { id: original!.id, fact: "保留事实" },
      { id: original!.id, fact: "新增事实" }
    ], { expectedSnapshotToken: snapshot.token });

    expect(result.status).toBe("applied");
    const stored = await readMemorySourceEntries(config, "working");
    expect(stored.map((entry) => entry.id)).toEqual([original!.id, expect.not.stringMatching(new RegExp(`^${original!.id}$`))]);
  });

  it("rejects stale snapshots without overwriting newer memory", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const stale = await readWorkingMemorySnapshot(config);
    await appendMemoryFacts(config, "working", [{ fact: "并发新增事实" }]);

    const result = await replaceWorkingMemoryFacts(config, [{ fact: "旧模型结果" }], {
      expectedSnapshotToken: stale.token
    });

    expect(result).toEqual({ status: "snapshot_conflict" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "原事实",
      "并发新增事实"
    ]);
  });

  it("requires explicit authorization before clearing nonempty working memory", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "唯一旧事实" }]);
    const snapshot = await readWorkingMemorySnapshot(config);

    expect(await replaceWorkingMemoryFacts(config, [], {
      expectedSnapshotToken: snapshot.token
    })).toEqual({ status: "empty_not_authorized" });
    expect(await readMemorySourceEntries(config, "working")).toHaveLength(1);

    expect(await replaceWorkingMemoryFacts(config, [], {
      expectedSnapshotToken: snapshot.token,
      allPreviousMemoriesInvalidated: true
    })).toMatchObject({ status: "applied", entries: [] });
    expect(await readMemorySourceEntries(config, "working")).toEqual([]);
  });
});
