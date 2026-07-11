// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  applyRetention,
  createRecoveryPoint,
  drillRecoveryPoint,
  restoreRecoveryPoint,
  verifyRecoveryPoint
} from "../../tooling/workspace/sqlite-recovery.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("SQLite recovery and fault-injection gate", () => {
  it("executes create and verify through the production CLI", async () => {
    const fixture = await createFixture();
    const cli = fileURLToPath(new URL("../../tooling/workspace/sqlite-recovery-cli.mjs", import.meta.url));
    const created = JSON.parse(execFileSync(process.execPath, [
      cli,
      "create",
      "--workspace",
      fixture.workspace,
      "--quiesced"
    ], { encoding: "utf8" }));
    expect(created).toMatchObject({ ok: true, manifest: { schemaVersion: 1 } });

    const verified = JSON.parse(execFileSync(process.execPath, [
      cli,
      "verify",
      "--backup",
      created.backupDirectory
    ], { encoding: "utf8" }));
    expect(verified).toMatchObject({ ok: true, manifest: { backupId: created.manifest.backupId } });
  });

  it("creates and restores one checksummed recovery point for both databases", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });

    expect(created.manifest).toMatchObject({
      schemaVersion: 1,
      rpoTargetHours: 24,
      consistency: {
        mode: "offline-quiesced",
        checkpoint: "wal_checkpoint(TRUNCATE)",
        lock: "BEGIN EXCLUSIVE",
        queueAuthoritativeForDelivery: true
      },
      crossDatabaseInvariants: {
        queueAuthoritativeForDelivery: true,
        mainProjectionMayLagAfterExternalSend: true,
        outboxStatusCounts: { sent: 1 }
      }
    });
    expect(created.manifest.databases.map((entry: { id: string }) => entry.id)).toEqual([
      "application",
      "session_queue"
    ]);
    expect((await verifyRecoveryPoint(created.directory)).ok).toBe(true);

    const targetWorkspace = path.join(fixture.root, "restored");
    const restored = await restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace
    });
    expect(restored.verification.inspections.map((entry: { id: string }) => entry.id)).toEqual([
      "application",
      "session_queue"
    ]);
    expect(restored.verification.crossDatabaseInvariants.outboxStatusCounts).toEqual({ sent: 1 });
  });

  it("requires explicit quiescence and fails closed on SQLITE_BUSY", async () => {
    const fixture = await createFixture();
    await expect(createRecoveryPoint({ workspace: fixture.workspace, quiesced: false })).rejects.toMatchObject({
      code: "QUIESCENCE_REQUIRED"
    });

    const blocker = new DatabaseSync(fixture.mainDatabasePath, { timeout: 20 });
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      await expect(createRecoveryPoint({
        workspace: fixture.workspace,
        quiesced: true,
        busyTimeoutMs: 20
      })).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect((await publishedRecoveryPoints(fixture.backupsRoot))).toEqual([]);
  });

  it("checkpoints committed WAL frames before publishing the pair", async () => {
    const fixture = await createFixture();
    const writers = [fixture.mainDatabasePath, fixture.queueDatabasePath].map((databasePath) => {
      const database = new DatabaseSync(databasePath);
      database.exec(`
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE IF NOT EXISTS recovery_fault_probe (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO recovery_fault_probe(value) VALUES ('committed in WAL');
      `);
      return database;
    });
    try {
      expect(await fileSize(`${fixture.mainDatabasePath}-wal`)).toBeGreaterThan(0);
      expect(await fileSize(`${fixture.queueDatabasePath}-wal`)).toBeGreaterThan(0);
      const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
      expect(created.manifest.databases.every((entry: {
        checkpoint: { walBytesBefore: number; busy: number };
      }) => entry.checkpoint.walBytesBefore > 0 && entry.checkpoint.busy === 0)).toBe(true);
      expect(created.manifest.databases.every((entry: {
        tables: Record<string, number>;
      }) => entry.tables.recovery_fault_probe === 1)).toBe(true);
    } finally {
      for (const writer of writers) writer.close();
    }
  });

  it("recovers stale kill artifacts and never publishes interrupted or ENOSPC backups", async () => {
    const fixture = await createFixture();
    const interruptedId = "sqlite-recovery-20260712T010000000Z-killtest";
    const interrupted = Object.assign(new Error("simulated SIGKILL"), {
      code: "SIMULATED_KILL",
      preservePartial: true
    });
    await expect(createRecoveryPoint({
      workspace: fixture.workspace,
      quiesced: true,
      backupId: interruptedId,
      faultInjector(step: string) {
        if (step === "after-application-backup") throw interrupted;
      }
    })).rejects.toMatchObject({ code: "SIMULATED_KILL" });
    expect((await fs.readdir(fixture.backupsRoot)).some((name) => name.startsWith(".partial-"))).toBe(true);

    await fs.writeFile(path.join(fixture.backupsRoot, ".sqlite-recovery.lock"), JSON.stringify({
      pid: 999_999,
      startedAt: "2026-07-12T01:00:00.000Z"
    }));
    const recovered = await createRecoveryPoint({
      workspace: fixture.workspace,
      quiesced: true,
      backupId: "sqlite-recovery-20260712T010100000Z-recovered"
    });
    expect((await fs.readdir(fixture.backupsRoot)).some((name) => name.startsWith(".partial-"))).toBe(false);
    expect((await verifyRecoveryPoint(recovered.directory)).ok).toBe(true);

    const diskFull = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    await expect(createRecoveryPoint({
      workspace: fixture.workspace,
      quiesced: true,
      backupId: "sqlite-recovery-20260712T010200000Z-diskfull",
      faultInjector(step: string) {
        if (step === "before-manifest") throw diskFull;
      }
    })).rejects.toMatchObject({ code: "ENOSPC" });
    expect((await publishedRecoveryPoints(fixture.backupsRoot))).toEqual([
      path.basename(recovered.directory)
    ]);
  });

  it("rejects partial and same-size corrupted backup files", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const partial = path.join(fixture.root, "partial-backup");
    await fs.cp(created.directory, partial, { recursive: true });
    await fs.rm(path.join(partial, "session-queue.sqlite"));
    await expect(verifyRecoveryPoint(partial)).rejects.toMatchObject({ code: "BACKUP_FILE_MISSING" });

    const corrupted = path.join(fixture.root, "corrupted-backup");
    await fs.cp(created.directory, corrupted, { recursive: true });
    const corruptedDatabase = path.join(corrupted, "application.sqlite");
    const handle = await fs.open(corruptedDatabase, "r+");
    try {
      const original = Buffer.alloc(1);
      await handle.read(original, 0, 1, 100);
      original[0] ^= 0xff;
      await handle.write(original, 0, 1, 100);
    } finally {
      await handle.close();
    }
    await expect(verifyRecoveryPoint(corrupted)).rejects.toMatchObject({
      code: "BACKUP_CHECKSUM_MISMATCH"
    });
  });

  it("keeps sent outbox terminal when the post-send main projection write fails", async () => {
    const fixture = await createFixture();
    const main = new DatabaseSync(fixture.mainDatabasePath);
    main.exec("PRAGMA query_only=ON");
    expect(() => main.prepare(`
      INSERT INTO conversations(id, last_at, data_json) VALUES (?, ?, ?)
    `).run("private:projection-failed", new Date().toISOString(), "{}")).toThrow();
    main.close();

    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const targetWorkspace = path.join(fixture.root, "delivery-restore");
    await restoreRecoveryPoint({ backupDirectory: created.directory, targetWorkspace });

    const restoredQueue = new SessionStore({
      databasePath: path.join(targetWorkspace, "business", "data", "session-queue.sqlite")
    });
    try {
      expect(restoredQueue.getOutbox(fixture.outboxId)).toMatchObject({
        id: fixture.outboxId,
        status: "sent",
        result: { messageId: 9001 }
      });
      expect(restoredQueue.claimNextOutbox({ workerId: "must-not-resend" })).toBeNull();
    } finally {
      restoredQueue.close();
    }
  });

  it("enforces 7/30-day retention and runs an isolated quarterly restore drill", async () => {
    const fixture = await createFixture();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const points = [
      ["2026-07-11T12:00:00.000Z", "hot"],
      ["2026-07-02T18:00:00.000Z", "archive-new"],
      ["2026-07-02T08:00:00.000Z", "archive-old"],
      ["2026-06-01T12:00:00.000Z", "expired"]
    ] as const;
    for (const [createdAt, suffix] of points) {
      await createRecoveryPoint({
        workspace: fixture.workspace,
        quiesced: true,
        now: new Date(createdAt),
        backupId: `sqlite-recovery-${createdAt.replace(/[-:.]/g, "")}-${suffix}`
      });
    }
    const retention = await applyRetention({ backupsRoot: fixture.backupsRoot, now, apply: false });
    expect(retention.plan.map((entry: { tier: string; action: string }) => [entry.tier, entry.action])).toEqual([
      ["hot", "keep"],
      ["daily-archive", "keep"],
      ["daily-archive-duplicate", "prune"],
      ["expired", "prune"]
    ]);

    const fresh = await createRecoveryPoint({
      workspace: fixture.workspace,
      quiesced: true,
      backupId: "sqlite-recovery-20260712T120100000Z-drill"
    });
    const report = await drillRecoveryPoint({ backupDirectory: fresh.directory });
    expect(report).toMatchObject({
      backupId: fresh.manifest.backupId,
      rpoTargetHours: 24,
      integrity: "ok"
    });
    expect(report.rpoHours).toBeLessThanOrEqual(24);
    expect(report.rtoMilliseconds).toBeGreaterThanOrEqual(0);
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-recovery-gate-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(workspace, "business", "data");
  const mainDatabasePath = path.join(dataDirectory, "sunabot.sqlite");
  const queueDatabasePath = path.join(dataDirectory, "session-queue.sqlite");
  const backupsRoot = path.join(workspace, "backups", "sqlite-recovery");
  await fs.mkdir(dataDirectory, { recursive: true });

  const main = new ApplicationDataStore(mainDatabasePath);
  main.replaceConversations([]);
  main.close();

  const queue = new SessionStore({ databasePath: queueDatabasePath });
  queue.enqueueEvent({
    sessionId: "private:171419991",
    kind: "incoming",
    dedupeKey: "onebot:recovery-fixture",
    payload: { text: "test recovery" }
  });
  const turn = queue.claimNextTurn({ workerId: "reply-worker" })!;
  const finished = queue.finishTurn({
    turnId: turn.turn.id,
    workerId: "reply-worker",
    outcome: "replied",
    outbox: [{
      kind: "onebot.private",
      dedupeKey: "reply:recovery-fixture",
      payload: { userId: 171419991, text: "delivered once" }
    }]
  });
  const outbound = queue.claimNextOutbox({ workerId: "onebot-sender" })!;
  queue.finishOutbox({
    outboxId: outbound.id,
    workerId: "onebot-sender",
    outcome: "sent",
    result: { messageId: 9001 }
  });
  queue.close();

  return {
    root,
    workspace,
    dataDirectory,
    mainDatabasePath,
    queueDatabasePath,
    backupsRoot,
    outboxId: finished.outbox[0]!.id
  };
}

async function publishedRecoveryPoints(backupsRoot: string) {
  try {
    return (await fs.readdir(backupsRoot)).filter((name) => name.startsWith("sqlite-recovery-"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileSize(filePath: string) {
  return (await fs.stat(filePath)).size;
}
