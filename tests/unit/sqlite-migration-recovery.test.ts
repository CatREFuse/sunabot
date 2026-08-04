// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { importLegacyApplicationData } from "../../tooling/migrations/sqlite-legacy-import.mjs";
import { ensureSafeAbsoluteDirectory } from "../../tooling/shared/safe-absolute-path.mjs";
import {
  createSqliteMigrationRecoveryPoint,
  drillSqliteMigrationRecoveryPoint,
  finalizeSqliteMigrationRecoveryPoint,
  rollbackSqliteMigrationRecoveryPointRestore,
  restoreSqliteMigrationRecoveryPoint,
  verifySqliteMigrationRecoveryPoint
} from "../../tooling/migrations/sqlite-migration-recovery.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("legacy SQLite migration recovery point", () => {
  it("accepts the controlled macOS /tmp system alias", async () => {
    if (process.platform !== "darwin") return;
    const directory = await fs.mkdtemp("/tmp/sunabot-safe-tmp-");
    temporaryDirectories.push(directory);

    await expect(ensureSafeAbsoluteDirectory(directory)).resolves.toBe(
      path.join("/private/tmp", path.basename(directory))
    );
  });

  it("accepts the controlled macOS /var system alias", async () => {
    if (process.platform !== "darwin") return;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-safe-var-"));
    temporaryDirectories.push(directory);
    expect(directory.startsWith("/var/")).toBe(true);

    await expect(ensureSafeAbsoluteDirectory(directory)).resolves.toBe(
      path.join("/private/var", path.relative("/var", directory))
    );
  });

  it("rejects a user-controlled symlink whose name resembles a system alias", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-safe-lookalike-")));
    temporaryDirectories.push(root);
    const external = path.join(root, "external");
    const lookalike = path.join(root, "var");
    await fs.mkdir(external);
    await fs.symlink(external, lookalike);

    await expect(ensureSafeAbsoluteDirectory(path.join(lookalike, "child"), { create: true }))
      .rejects.toMatchObject({ code: "ABSOLUTE_PATH_UNSAFE" });
    await expect(fs.access(path.join(external, "child"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds every legacy source, main, queue, and chunks database inside the workspace recovery point", async () => {
    const fixture = await createFixture();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-2026-07-14T01-00-00-000Z",
      sources: [{
        id: "legacy:conversations",
        path: fixture.legacySource,
        recordCount: 2,
        idempotencyKeys: ["private:1", "private:2"]
      }],
      databases: [
        { id: "application", kind: "application", path: fixture.application },
        { id: "session_queue", kind: "session_queue", path: fixture.queue },
        { id: "attachment:chunks", kind: "attachment_chunks", path: fixture.chunks }
      ]
    });

    expect(path.relative(fixture.workspace, created.directory)).toBe("backups/sqlite-migration-2026-07-14T01-00-00-000Z");
    expect(created.manifest.sources[0]).toMatchObject({
      source: "business/data/legacy/conversations.json",
      recordCount: 2,
      idempotencyKeyCount: 2,
      idempotencyKeysSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(created.manifest.databases.map((entry: { kind: string }) => entry.kind)).toEqual([
      "application",
      "session_queue",
      "attachment_chunks"
    ]);
    expect((await verifySqliteMigrationRecoveryPoint(created.directory)).ok).toBe(true);

    const finalized = await finalizeSqliteMigrationRecoveryPoint({
      directory: created.directory,
      workspace: fixture.workspace,
      sourceCounts: { conversations: 2 },
      databaseCounts: { conversations: 2 },
      targets: [
        { id: "application", kind: "application", path: fixture.application },
        { id: "session_queue", kind: "session_queue", path: fixture.queue },
        { id: "attachment:chunks", kind: "attachment_chunks", path: fixture.chunks }
      ]
    });
    expect(finalized.manifest.postMigration.targets).toHaveLength(3);

    const restoredWorkspace = path.join(fixture.root, "restored");
    await restoreSqliteMigrationRecoveryPoint({ directory: created.directory, targetWorkspace: restoredWorkspace });
    await expect(fs.readFile(path.join(restoredWorkspace, "business/data/legacy/conversations.json"), "utf8"))
      .resolves.toContain("private:1");
    expect((await drillSqliteMigrationRecoveryPoint({ directory: created.directory })).restored).toBe(true);
  });

  it("removes WAL validation sidecars before publishing a restored database", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.application);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);");
    database.close();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-wal-validation-sidecars-test",
      sources: [],
      databases: [{ id: "application", kind: "application", path: fixture.application }]
    });
    const targetWorkspace = path.join(fixture.root, "wal-validation-restore");

    await expect(restoreSqliteMigrationRecoveryPoint({
      directory: created.directory,
      targetWorkspace
    })).resolves.toMatchObject({ ok: true, backupId: created.manifest.backupId });
    await expect(fs.access(path.join(targetWorkspace, "business/data/sunabot.sqlite-wal")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(targetWorkspace, "business/data/sunabot.sqlite-shm")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(targetWorkspace, `.sqlite-migration-restore-${created.manifest.backupId}.staging`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source escape and symbolic links before publishing", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, "outside.json");
    await fs.writeFile(outside, "[]\n");
    await expect(createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-path-escape-test",
      sources: [{ id: "outside", path: outside, recordCount: 0, idempotencyKeys: [] }],
      databases: []
    })).rejects.toMatchObject({ code: "SQLITE_MIGRATION_PATH_ESCAPE" });

    const symlink = path.join(fixture.workspace, "business/data/legacy/link.json");
    await fs.symlink(outside, symlink);
    await expect(createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-symlink-test",
      sources: [{ id: "link", path: symlink, recordCount: 0, idempotencyKeys: [] }],
      databases: []
    })).rejects.toMatchObject({ code: "SQLITE_MIGRATION_PATH_INVALID" });
  });

  it("does not publish an interrupted or ENOSPC recovery point", async () => {
    const fixture = await createFixture();
    const diskFull = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await expect(createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-disk-full-test",
      sources: [{ id: "legacy", path: fixture.legacySource, recordCount: 2, idempotencyKeys: ["1", "2"] }],
      databases: [{ id: "application", path: fixture.application }],
      faultInjector(step: string) {
        if (step === "before-manifest") throw diskFull;
      }
    })).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(fs.access(path.join(fixture.workspace, "backups/sqlite-migration-disk-full-test")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "after-restore-intent",
    "after-restore-copy-legacy:conversations"
  ])("resumes the migration recovery restore after %s", async (failureStep) => {
    const fixture = await createFixture();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: `sqlite-migration-resume-${failureStep.replaceAll(":", "-")}`,
      sources: [{
        id: "legacy:conversations",
        path: fixture.legacySource,
        recordCount: 2,
        idempotencyKeys: ["private:1", "private:2"]
      }],
      databases: [{ id: "application", kind: "application", path: fixture.application }]
    });
    const targetWorkspace = path.join(fixture.root, `restore-${failureStep.replaceAll(":", "-")}`);
    await expect(restoreSqliteMigrationRecoveryPoint({
      directory: created.directory,
      targetWorkspace,
      faultInjector(step: string) {
        if (step === failureStep) throw new Error(`stop:${step}`);
      }
    })).rejects.toThrow(`stop:${failureStep}`);

    await expect(fs.access(path.join(targetWorkspace, `.sqlite-migration-restore-${created.manifest.backupId}.json`)))
      .resolves.toBeUndefined();
    await expect(restoreSqliteMigrationRecoveryPoint({
      directory: created.directory,
      targetWorkspace
    })).resolves.toMatchObject({ ok: true, backupId: created.manifest.backupId });
  });

  it("rolls back a migration recovery restore stopped after its first copy", async () => {
    const fixture = await createFixture();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-copy-rollback-test",
      sources: [{ id: "legacy:conversations", path: fixture.legacySource, recordCount: 2, idempotencyKeys: ["1", "2"] }],
      databases: [{ id: "application", kind: "application", path: fixture.application }]
    });
    const targetWorkspace = path.join(fixture.root, "migration-copy-rollback");
    await expect(restoreSqliteMigrationRecoveryPoint({
      directory: created.directory,
      targetWorkspace,
      faultInjector(step: string) {
        if (step === "after-restore-copy-legacy:conversations") throw new Error("stop after copy");
      }
    })).rejects.toThrow("stop after copy");
    await expect(rollbackSqliteMigrationRecoveryPointRestore({
      directory: created.directory,
      targetWorkspace
    })).resolves.toMatchObject({ ok: true, rolledBack: true });
    expect(await fs.readdir(targetWorkspace)).toEqual([]);
  });

  it("rejects a pre-populated target with different IDs even when the count is equal", async () => {
    const fixture = await createImportFixture([{ id: "legacy-new", lastAt: "2026-07-14T00:00:00.000Z" }]);
    const store = new ApplicationDataStore(fixture.databasePath);
    store.replaceConversations([conversation("existing-other")]);
    try {
      await expect(importLegacyApplicationData({
        store,
        databasePath: fixture.databasePath,
        legacy: fixture.legacy
      })).rejects.toMatchObject({ code: "SQLITE_MIGRATION_IMPORT_KEY_MISMATCH" });
      await expect(fs.access(fixture.legacy.conversations)).resolves.toBeUndefined();
      expect(store.readConversations().map((record) => record.id)).toEqual(["existing-other"]);
    } finally {
      store.close();
    }
  });

  it("runs the real legacy import twice without duplicating or deleting evidence prematurely", async () => {
    const fixture = await createImportFixture([{ id: "legacy-repeat", lastAt: "2026-07-14T00:00:00.000Z" }]);
    const store = new ApplicationDataStore(fixture.databasePath);
    try {
      const first = await importLegacyApplicationData({
        store,
        databasePath: fixture.databasePath,
        legacy: fixture.legacy
      });
      const second = await importLegacyApplicationData({
        store,
        databasePath: fixture.databasePath,
        legacy: fixture.legacy
      });
      expect(first.imports.conversations).toMatchObject({ beforeCount: 0, sourceCount: 1, afterCount: 1, deltaCount: 1 });
      expect(second.imports.conversations).toMatchObject({ beforeCount: 1, sourceCount: 1, afterCount: 1, deltaCount: 0 });
      expect(store.readConversations().map((record) => record.id)).toEqual(["legacy-repeat"]);
      await expect(fs.access(fixture.legacy.conversations)).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("preserves external content when stale-partial cleanup finds a symlink", async () => {
    const fixture = await createFixture();
    const backupsRoot = path.join(fixture.workspace, "backups");
    const external = path.join(fixture.root, "external-migration-partial");
    await fs.mkdir(backupsRoot, { recursive: true });
    await fs.mkdir(external);
    const sentinel = path.join(external, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n");
    await fs.symlink(external, path.join(backupsRoot, ".partial-sqlite-migration-hostile"));

    await expect(createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-hostile-partial-test",
      sources: [],
      databases: []
    })).rejects.toMatchObject({ code: "SQLITE_MIGRATION_PATH_INVALID" });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it("rejects verification through a symlinked recovery parent", async () => {
    const fixture = await createFixture();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-linked-verify-test",
      sources: [{ id: "legacy", path: fixture.legacySource, recordCount: 2, idempotencyKeys: ["1", "2"] }],
      databases: [{ id: "application", path: fixture.application }]
    });
    const linkedParent = path.join(fixture.root, "linked-migration-recovery");
    await fs.symlink(path.dirname(created.directory), linkedParent);

    await expect(verifySqliteMigrationRecoveryPoint(path.join(linkedParent, path.basename(created.directory))))
      .rejects.toMatchObject({ code: "SQLITE_MIGRATION_PATH_INVALID" });
    await expect(fs.access(created.directory)).resolves.toBeUndefined();
  });

  it("does not follow a symlinked target parent during a migration drill", async () => {
    const fixture = await createFixture();
    const created = await createSqliteMigrationRecoveryPoint({
      workspace: fixture.workspace,
      backupId: "sqlite-migration-linked-drill-test",
      sources: [{ id: "legacy", path: fixture.legacySource, recordCount: 2, idempotencyKeys: ["1", "2"] }],
      databases: [{ id: "application", path: fixture.application }]
    });
    const externalTarget = path.join(fixture.root, "external-migration-drill");
    await fs.mkdir(externalTarget);
    const linkedParent = path.join(fixture.root, "linked-migration-drill");
    await fs.symlink(fixture.root, linkedParent);

    await expect(drillSqliteMigrationRecoveryPoint({
      directory: created.directory,
      targetWorkspace: path.join(linkedParent, path.basename(externalTarget))
    })).rejects.toMatchObject({ code: "SQLITE_MIGRATION_PATH_INVALID" });
    expect(await fs.readdir(externalTarget)).toEqual([]);
  });
});

async function createImportFixture(conversations: Array<{ id: string; lastAt: string }>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-sqlite-legacy-import-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "workspace/business/data/sunabot.sqlite");
  const conversationsPath = path.join(root, "workspace/business/data/legacy/conversations.json");
  await fs.mkdir(path.dirname(conversationsPath), { recursive: true });
  await fs.writeFile(conversationsPath, JSON.stringify(conversations.map((record) => ({
    ...conversation(record.id),
    lastAt: record.lastAt
  }))));
  return {
    databasePath,
    legacy: {
      conversations: conversationsPath,
      requestLogs: path.join(root, "missing-request-logs.jsonl"),
      working: path.join(root, "missing-working.jsonl"),
      longTerm: path.join(root, "missing-long-term.jsonl"),
      userProfile: path.join(root, "missing-profile.jsonl"),
      imageHistory: path.join(root, "missing-images.json")
    }
  };
}

function conversation(id: string) {
  return {
    id,
    scope: "private" as const,
    title: id,
    userId: 1,
    messageCount: 0,
    lastAt: "2026-07-14T00:00:00.000Z",
    lastText: "",
    messages: []
  };
}

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-sqlite-migration-recovery-")));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "external-workspace");
  const legacySource = path.join(workspace, "business/data/legacy/conversations.json");
  const application = path.join(workspace, "business/data/sunabot.sqlite");
  const queue = path.join(workspace, "business/data/session-queue.sqlite");
  const chunks = path.join(workspace, "cache/attachments/file/chunks.sqlite");
  await fs.mkdir(path.dirname(legacySource), { recursive: true });
  await fs.mkdir(path.dirname(chunks), { recursive: true });
  await fs.writeFile(legacySource, JSON.stringify([
    { id: "private:1", lastAt: "2026-07-14T00:00:00.000Z" },
    { id: "private:2", lastAt: "2026-07-14T00:00:01.000Z" }
  ]));
  createDatabase(application, "conversations", 2);
  createDatabase(queue, "outbox", 1);
  createDatabase(chunks, "attachment_chunks", 3);
  return { root, workspace, legacySource, application, queue, chunks };
}

function createDatabase(filePath: string, table: string, rows: number) {
  const database = new DatabaseSync(filePath);
  database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT);`);
  const insert = database.prepare(`INSERT INTO ${table}(value) VALUES (?)`);
  for (let index = 0; index < rows; index += 1) insert.run(`row-${index}`);
  database.close();
}
