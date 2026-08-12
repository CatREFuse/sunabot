// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEmojiCatalogMigration,
  applyReleaseUpgrade,
  planEmojiCatalogMigration,
  planReleaseUpgrade,
  verifyEmojiCatalogMigration,
  verifyTargetRelease
} from "../../tooling/migrations/upgrade-0.1.0-or-0.1.1-to-0.1.2.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("0.1.0 or 0.1.1 to 0.1.2 release upgrade", () => {
  it("keeps the historical upgrade verifier pinned to a complete 0.1.2 checkout", async () => {
    const projectRoot = await createReleaseFixture({ packageVersion: "0.1.2" });
    await expect(verifyTargetRelease(projectRoot)).resolves.toEqual({
      package: "0.1.2",
      packageLock: "0.1.2",
      packageLockRoot: "0.1.2",
      runtimeContract: "0.1.2",
      releaseCatalog: "0.1.2",
      dockerfile: "0.1.2",
      compose: "0.1.2"
    });
  });

  it("rejects a partially updated target release before inspecting workspace data", async () => {
    const fixture = await createReleaseFixture({ packageVersion: "0.1.0" });
    let inspected = false;
    await expect(planReleaseUpgrade({
      projectRoot: fixture,
      workspace: path.join(fixture, "workspace"),
      planSelfieReferencesMigration: async () => {
        inspected = true;
        throw new Error("should not run");
      }
    })).rejects.toMatchObject({ code: "TARGET_RELEASE_MISMATCH" });
    expect(inspected).toBe(false);
  });

  it("rejects a newer release before reading retired Docker migration files", async () => {
    const fixture = await createReleaseFixture({ packageVersion: "0.3.0" });
    await fs.rm(path.join(fixture, "deploy", "docker"), { recursive: true });

    await expect(verifyTargetRelease(fixture)).rejects.toMatchObject({
      code: "TARGET_RELEASE_MISMATCH"
    });
  });

  it("runs the offline recovery and resource migration before starting the target runtime", async () => {
    const events: string[] = [];
    const workspace = path.join(root, "workspace");
    const projectRoot = await createReleaseFixture({ packageVersion: "0.1.2" });
    const planSelfie = async () => ({
      ok: true,
      command: "plan",
      migrationId: "selfie-references-jsonl-v1",
      workspace,
      changesRequired: true,
      agents: []
    });
    const planEmoji = async () => ({
      ok: true,
      migrationId: "emoji-catalog-jsonl-v1",
      changesRequired: true,
      agents: [{ agentId: "plana", state: "legacy", keys: 1, versions: 1 }]
    });
    const planResources = async () => ({
      ok: true,
      command: "plan",
      migrationId: "agent-workbenches-v2",
      workspace,
      changesRequired: true,
      agents: [{ agentId: "plana", changesRequired: true }]
    });
    const result = await applyReleaseUpgrade({
      projectRoot,
      workspace,
      assertNonRoot: () => undefined,
      planSelfieReferencesMigration: planSelfie,
      planEmojiCatalogMigration: planEmoji,
      planAgentResourcesMigration: planResources,
      runCommand: async (_command: string, args: string[]) => {
        events.push(args[0]);
      },
      createRecoveryPoint: async () => {
        events.push("backup");
        return { directory: path.join(workspace, "backups", "sqlite-recovery", "fixture") };
      },
      applyEmojiCatalogMigration: async () => {
        events.push("migrate-emoji");
        return { ok: true, migrated: true };
      },
      verifyEmojiCatalogMigration: async () => {
        events.push("verify-emoji");
        return { ok: true };
      },
      applySelfieReferencesMigration: async () => {
        events.push("migrate-selfie");
        return { ok: true, migrated: true, backup: "backups/selfie-fixture" };
      },
      verifySelfieReferencesMigration: async () => {
        events.push("verify-selfie");
        return { ok: true };
      },
      applyAgentResourcesMigration: async () => {
        events.push("migrate-resources");
        return { ok: true, backup: "backups/resources-fixture" };
      },
      verifyAgentResourcesMigration: async () => {
        events.push("verify-resources");
        return { ok: true };
      }
    });
    expect(events).toEqual([
      "down",
      "backup",
      "migrate-emoji",
      "migrate-selfie",
      "verify-selfie",
      "verify-emoji",
      "migrate-resources",
      "verify-resources",
      "up",
      "status",
      "doctor"
    ]);
    expect(result).toMatchObject({
      ok: true,
      fromVersion: "0.1.0/0.1.1",
      targetVersion: "0.1.2",
      runtime: { started: true, status: "passed", doctor: "passed" }
    });
  });

  it("does not start the target runtime when the offline migration fails", async () => {
    const events: string[] = [];
    const workspace = path.join(root, "workspace");
    const projectRoot = await createReleaseFixture({ packageVersion: "0.1.2" });
    await expect(applyReleaseUpgrade({
      projectRoot,
      workspace,
      assertNonRoot: () => undefined,
      planSelfieReferencesMigration: async () => ({
        workspace,
        changesRequired: true,
        agents: []
      }),
      planEmojiCatalogMigration: async () => ({
        changesRequired: true,
        agents: [{ agentId: "plana", state: "legacy" }]
      }),
      planAgentResourcesMigration: async () => ({
        workspace,
        changesRequired: true,
        agents: [{ agentId: "plana", changesRequired: true }]
      }),
      runCommand: async (_command: string, args: string[]) => {
        events.push(args[0]);
      },
      createRecoveryPoint: async () => {
        events.push("backup");
        return { directory: "fixture" };
      },
      applyEmojiCatalogMigration: async () => {
        events.push("migrate-emoji");
        return { ok: true };
      },
      applySelfieReferencesMigration: async () => {
        events.push("migrate-selfie");
        throw new Error("fixture failure");
      }
    })).rejects.toMatchObject({
      message: expect.stringContaining("服务保持停止"),
      serviceMayBeStopped: true
    });
    expect(events).toEqual(["down", "backup", "migrate-emoji", "migrate-selfie"]);
  });

  it("publishes every legacy emoji version before clearing SQLite rows", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-release-upgrade-"));
    temporaryDirectories.push(workspace);
    const databasePath = path.join(workspace, "business", "data", "sunabot.sqlite");
    const catalogDirectory = path.join(workspace, "business", "media", "images");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(catalogDirectory, { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE emojis (
        emoji_key TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        source TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE emoji_versions (
        emoji_key TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (emoji_key, file_name)
      );
    `);
    const currentFile = emojiFile("b");
    const oldFile = emojiFile("a");
    database.prepare(`
      INSERT INTO emojis VALUES (?, ?, 'generated', 256, 1024, 1024, ?, ?)
    `).run("开心", currentFile, "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:02.000Z");
    database.prepare(`
      INSERT INTO emoji_versions VALUES (?, ?, 'upload', 128, 1024, 1024, ?)
    `).run("开心", oldFile, "2026-07-18T00:00:01.000Z");
    database.prepare(`
      INSERT INTO emoji_versions VALUES (?, ?, 'generated', 256, 1024, 1024, ?)
    `).run("开心", currentFile, "2026-07-18T00:00:02.000Z");
    database.close();

    await expect(planEmojiCatalogMigration({
      workspace,
      agentIds: ["plana"]
    })).resolves.toMatchObject({
      changesRequired: true,
      agents: [{ agentId: "plana", state: "legacy", keys: 1, versions: 2 }]
    });
    await expect(applyEmojiCatalogMigration({
      workspace,
      agentIds: ["plana"],
      quiesced: true
    })).resolves.toMatchObject({
      migrated: true,
      agents: [{ agentId: "plana", state: "jsonl", keys: 1, versions: 2 }]
    });
    await expect(verifyEmojiCatalogMigration({
      workspace,
      agentIds: ["plana"]
    })).resolves.toMatchObject({
      agents: [{ agentId: "plana", state: "jsonl", keys: 1, versions: 2 }]
    });
    const catalog = await fs.readFile(path.join(catalogDirectory, "emojis.jsonl"), "utf8");
    expect(JSON.parse(catalog.trim()).versions.map((version: { fileName: string }) => version.fileName))
      .toEqual([currentFile, oldFile]);
    const verifiedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    expect(verifiedDatabase.prepare("SELECT count(*) AS count FROM emojis").get()).toMatchObject({ count: 0 });
    expect(verifiedDatabase.prepare("SELECT count(*) AS count FROM emoji_versions").get())
      .toMatchObject({ count: 0 });
    verifiedDatabase.close();
  });
});

async function createReleaseFixture(options: { packageVersion: string }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-upgrade-"));
  temporaryDirectories.push(directory);
  await Promise.all([
    write(directory, "package.json", { version: options.packageVersion }),
    write(directory, "package-lock.json", {
      version: "0.1.2",
      packages: { "": { version: "0.1.2" } }
    }),
    write(directory, "deploy/runtime-contract.json", { releaseVersion: "0.1.2" }),
    writeText(directory, "packages/platform/releaseCatalog.ts", 'CURRENT_RELEASE_VERSION = "0.1.2"\n'),
    writeText(directory, "deploy/docker/Dockerfile", "ARG SUNABOT_RELEASE_VERSION=0.1.2\n"),
    writeText(
      directory,
      "deploy/docker/compose.yml",
      "SUNABOT_RELEASE_VERSION: ${SUNABOT_RELEASE_VERSION:-0.1.2}\n"
    )
  ]);
  return directory;
}

async function write(rootDirectory: string, relativePath: string, value: unknown) {
  await writeText(rootDirectory, relativePath, `${JSON.stringify(value)}\n`);
}

async function writeText(rootDirectory: string, relativePath: string, value: string) {
  const target = path.join(rootDirectory, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

function emojiFile(seed: string) {
  return `emoji-${seed.repeat(64)}.png`;
}
