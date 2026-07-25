// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("emoji SQLite to JSONL migration", () => {
  let root = "";
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    previousWorkspace = process.env.SUNABOT_WORKSPACE;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-jsonl-migration-")));
    process.env.SUNABOT_WORKSPACE = root;
    vi.resetModules();
  });

  afterEach(async () => {
    const applicationData = await import("../../adapters/sqlite/applicationDataStore.js");
    applicationData.closeApplicationDataStores();
    if (previousWorkspace === undefined) delete process.env.SUNABOT_WORKSPACE;
    else process.env.SUNABOT_WORKSPACE = previousWorkspace;
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists all legacy versions before clearing legacy SQLite rows", async () => {
    const [applicationData, jsonl] = await Promise.all([
      import("../../adapters/sqlite/applicationDataStore.js"),
      import("../../src/emojis/emojiStore.js")
    ]);
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "migration-agent";
    config.persona.agentWorkspace = path.join(root, "business", "agents", "migration-agent");
    const legacy = applicationData.applicationDataStore(config);
    legacy.upsertEmoji(record("开心", "a", "upload", "2026-07-18T00:00:01.000Z"));
    legacy.upsertEmoji(record("开心", "b", "generated", "2026-07-18T00:00:02.000Z"));

    const store = jsonl.emojiStore(config);
    expect(store.readVersions("开心")).toEqual([
      expect.objectContaining({ fileName: fileName("b"), current: true }),
      expect.objectContaining({ fileName: fileName("a"), current: false })
    ]);
    expect(legacy.readEmojis()).toEqual([]);
    expect(legacy.readEmojiVersions("开心")).toEqual([]);

    const catalogPath = jsonl.emojiCatalogLocation(config);
    expect(path.basename(catalogPath)).toBe("emojis.jsonl");
    expect(path.dirname(catalogPath)).toBe(jsonl.emojiMediaDirectory(config));
    expect((await fs.readFile(catalogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

function record(
  key: string,
  seed: string,
  source: "upload" | "generated",
  updatedAt: string
) {
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

function fileName(seed: string) {
  return `emoji-${seed.repeat(64)}.png`;
}
