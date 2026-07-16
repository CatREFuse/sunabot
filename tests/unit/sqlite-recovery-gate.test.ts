// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  applyRetention,
  createRecoveryPoint,
  drillRecoveryPoint,
  rollbackRecoveryPointRestore,
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
    expect(created).toMatchObject({ ok: true, manifest: { schemaVersion: 2 } });

    const verified = JSON.parse(execFileSync(process.execPath, [
      cli,
      "verify",
      "--backup",
      created.backupDirectory
    ], { encoding: "utf8" }));
    expect(verified).toMatchObject({ ok: true, manifest: { backupId: created.manifest.backupId } });
  });

  it("creates and restores one checksummed recovery point for the default Agent pair", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });

    expect(created.manifest).toMatchObject({
      schemaVersion: 2,
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
        agents: {
          plana: {
            outboxStatusCounts: { sent: 1 }
          }
        }
      }
    });
    expect(created.manifest.databases.map((entry: { id: string }) => entry.id)).toEqual([
      "agent:plana:application",
      "agent:plana:session_queue"
    ]);
    expect((await verifyRecoveryPoint(created.directory)).ok).toBe(true);

    const targetWorkspace = path.join(fixture.root, "restored");
    const restored = await restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace
    });
    expect(restored.verification.inspections.map((entry: { id: string }) => entry.id)).toEqual([
      "agent:plana:application",
      "agent:plana:session_queue"
    ]);
    expect(restored.verification.crossDatabaseInvariants.agents.plana.outboxStatusCounts).toEqual({ sent: 1 });
  });

  it("treats a pre-multi-Agent database without an agents table as Plana-only", async () => {
    const fixture = await createFixture();
    const legacyMain = new DatabaseSync(fixture.mainDatabasePath);
    legacyMain.exec("PRAGMA foreign_keys=OFF; DROP TABLE agent_accounts; DROP TABLE agents;");
    legacyMain.close();

    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    expect(created.manifest.databases.map((entry: { id: string }) => entry.id)).toEqual([
      "agent:plana:application",
      "agent:plana:session_queue"
    ]);
  });

  it("rejects missing registry tables in a current Agent workspace", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.join(fixture.workspace, "business", "agents", "plana"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspace, "business", "agents", "plana", "agent.json"), "{}\n");
    const damagedMain = new DatabaseSync(fixture.mainDatabasePath);
    damagedMain.exec("PRAGMA foreign_keys=OFF; DROP TABLE agent_accounts; DROP TABLE agents;");
    damagedMain.close();

    await expect(createRecoveryPoint({ workspace: fixture.workspace, quiesced: true })).rejects.toMatchObject({
      code: "AGENT_REGISTRY_INVALID"
    });
  });

  it("requires every current application schema table before publishing", async () => {
    const fixture = await createFixture();
    const damagedMain = new DatabaseSync(fixture.mainDatabasePath);
    damagedMain.exec("DROP TABLE conversation_thread_states;");
    damagedMain.close();

    await expect(createRecoveryPoint({ workspace: fixture.workspace, quiesced: true })).rejects.toMatchObject({
      code: "SQLITE_SCHEMA_INCOMPLETE"
    });
  });

  it("creates, verifies, and restores a v2 current-schema recovery point from storage schema 9", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: false, databases: "both" }]
    });
    downgradeApplicationToStorageSchema9(fixture.mainDatabasePath);

    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const planaApplication = created.manifest.databases.find((entry: {
      agentId: string;
      kind: string;
    }) => entry.agentId === "plana" && entry.kind === "application");
    const aronaApplication = created.manifest.databases.find((entry: {
      agentId: string;
      kind: string;
    }) => entry.agentId === "arona" && entry.kind === "application");

    expect(planaApplication).toMatchObject({ schemaProfile: "current" });
    expect(planaApplication.tables).not.toHaveProperty("conversation_thread_states");
    expect(aronaApplication.tables).toHaveProperty("conversation_thread_states", 0);
    await expect(verifyRecoveryPoint(created.directory)).resolves.toMatchObject({ ok: true });

    const targetWorkspace = path.join(fixture.root, "storage-schema-9-restored");
    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace
    })).resolves.toMatchObject({ ok: true });
    const restoredMain = new DatabaseSync(path.join(
      targetWorkspace,
      "business",
      "data",
      "sunabot.sqlite"
    ), { readOnly: true });
    try {
      expect(restoredMain.prepare(`
        SELECT value FROM app_metadata WHERE key = 'storage-schema-version'
      `).get()).toEqual({ value: "9" });
      expect(restoredMain.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name = 'conversation_thread_states'
      `).get()).toEqual({ count: 0 });
    } finally {
      restoredMain.close();
    }
  });

  it("rejects a pre-Thread v2 manifest when its database no longer reports storage schema 9", async () => {
    const fixture = await createFixture();
    downgradeApplicationToStorageSchema9(fixture.mainDatabasePath);
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const application = created.manifest.databases.find((entry: { kind: string }) => entry.kind === "application");
    if (!application) throw new Error("application backup entry is missing");
    const tampered = path.join(fixture.root, "schema-version-tampered");
    await fs.cp(created.directory, tampered, { recursive: true });
    const databasePath = path.join(tampered, application.file);
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        UPDATE app_metadata SET value = '10' WHERE key = 'storage-schema-version'
      `).run();
    } finally {
      database.close();
    }
    const databaseBytes = await fs.readFile(databasePath);
    const databaseSha256 = createHash("sha256").update(databaseBytes).digest("hex");
    await rewriteManifest(tampered, (manifest) => {
      const entry = manifest.databases.find((item: { id: string }) => item.id === application.id);
      entry.sha256 = databaseSha256;
      entry.bytes = databaseBytes.length;
    });

    await expect(verifyRecoveryPoint(tampered)).rejects.toMatchObject({
      code: "SQLITE_SCHEMA_INCOMPLETE"
    });
  });

  it("backs up, verifies, and restores the default pair plus a disabled Agent pair", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: false, databases: "both" }]
    });
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });

    expect(created.manifest.databases.map((entry: { id: string }) => entry.id)).toEqual([
      "agent:plana:application",
      "agent:plana:session_queue",
      "agent:arona:application",
      "agent:arona:session_queue"
    ]);
    expect(Object.keys(created.manifest.crossDatabaseInvariants.agents)).toEqual(["plana", "arona"]);
    expect((await verifyRecoveryPoint(created.directory)).inspections).toHaveLength(4);

    const targetWorkspace = path.join(fixture.root, "multi-agent-restored");
    const restored = await restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace
    });
    expect(restored.verification.inspections).toHaveLength(4);
    await expect(fs.stat(path.join(
      targetWorkspace,
      "business",
      "agents",
      "arona",
      "data",
      "sunabot.sqlite"
    ))).resolves.toMatchObject({ size: expect.any(Number) });
    const restoredQueue = new SessionStore({
      databasePath: path.join(
        targetWorkspace,
        "business",
        "agents",
        "arona",
        "data",
        "session-queue.sqlite"
      )
    });
    try {
      expect(restoredQueue.getOutbox(fixture.agentOutboxIds.arona!)).toMatchObject({ status: "sent" });
    } finally {
      restoredQueue.close();
    }
  });

  it("requires explicit quiescence and fails closed on SQLITE_BUSY", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: true, databases: "both" }]
    });
    await expect(createRecoveryPoint({ workspace: fixture.workspace, quiesced: false })).rejects.toMatchObject({
      code: "QUIESCENCE_REQUIRED"
    });

    const blocker = new DatabaseSync(path.join(
      fixture.workspace,
      "business",
      "agents",
      "arona",
      "data",
      "sunabot.sqlite"
    ), { timeout: 20 });
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

  it("checkpoints committed WAL frames for every Agent database before publishing", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: false, databases: "both" }]
    });
    const writers = [
      fixture.mainDatabasePath,
      fixture.queueDatabasePath,
      path.join(fixture.workspace, "business", "agents", "arona", "data", "sunabot.sqlite"),
      path.join(fixture.workspace, "business", "agents", "arona", "data", "session-queue.sqlite")
    ].map((databasePath) => {
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
        if (step === "after-plana-application-backup") throw interrupted;
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

  it("rejects missing backup files and same-size corruption in a secondary Agent database", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: true, databases: "both" }]
    });
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const secondaryQueue = created.manifest.databases.find((entry: { agentId: string; kind: string }) =>
      entry.agentId === "arona" && entry.kind === "session_queue"
    );
    const secondaryApplication = created.manifest.databases.find((entry: { agentId: string; kind: string }) =>
      entry.agentId === "arona" && entry.kind === "application"
    );
    if (!secondaryQueue || !secondaryApplication) throw new Error("secondary Agent backup entries are missing");
    const partial = path.join(fixture.root, "partial-backup");
    await fs.cp(created.directory, partial, { recursive: true });
    await fs.rm(path.join(partial, secondaryQueue.file));
    await expect(verifyRecoveryPoint(partial)).rejects.toMatchObject({ code: "BACKUP_FILE_MISSING" });

    const corrupted = path.join(fixture.root, "corrupted-backup");
    await fs.cp(created.directory, corrupted, { recursive: true });
    const corruptedDatabase = path.join(corrupted, secondaryApplication.file);
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

  it("rejects unsafe manifest ids, sources, and backup file paths", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const mutations = [
      (manifest: any) => { manifest.databases[0].id = "agent:plana:../application"; },
      (manifest: any) => { manifest.databases[0].source = "../outside.sqlite"; },
      (manifest: any) => { manifest.databases[0].file = "../outside.sqlite"; }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const unsafe = path.join(fixture.root, `unsafe-manifest-${index}`);
      await fs.cp(created.directory, unsafe, { recursive: true });
      await rewriteManifest(unsafe, mutate);
      await expect(verifyRecoveryPoint(unsafe)).rejects.toMatchObject({ code: "BACKUP_MANIFEST_INVALID" });
    }
  });

  it("requires the v2 manifest Agent set to match the backed-up Plana registry", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: false, databases: "both" }]
    });
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });

    const missing = path.join(fixture.root, "missing-agent-manifest");
    await fs.cp(created.directory, missing, { recursive: true });
    for (const entry of created.manifest.databases.filter((item: { agentId: string }) => item.agentId === "arona")) {
      await fs.rm(path.join(missing, entry.file));
    }
    await rewriteManifest(missing, (manifest) => {
      manifest.databases = manifest.databases.filter((entry: { agentId: string }) => entry.agentId !== "arona");
      delete manifest.crossDatabaseInvariants.agents.arona;
    });
    await expect(verifyRecoveryPoint(missing)).rejects.toMatchObject({ code: "BACKUP_AGENT_SET_MISMATCH" });

    const defaultFixture = await createFixture();
    const defaultCreated = await createRecoveryPoint({ workspace: defaultFixture.workspace, quiesced: true });
    const extra = path.join(defaultFixture.root, "extra-agent-manifest");
    await fs.cp(defaultCreated.directory, extra, { recursive: true });
    const planaApplication = defaultCreated.manifest.databases.find((entry: { kind: string }) =>
      entry.kind === "application"
    );
    const planaQueue = defaultCreated.manifest.databases.find((entry: { kind: string }) =>
      entry.kind === "session_queue"
    );
    if (!planaApplication || !planaQueue) throw new Error("Plana backup entries are missing");
    await fs.copyFile(
      path.join(extra, planaApplication.file),
      path.join(extra, "agent-ghost-application.sqlite")
    );
    await fs.copyFile(
      path.join(extra, planaQueue.file),
      path.join(extra, "agent-ghost-session-queue.sqlite")
    );
    await rewriteManifest(extra, (manifest) => {
      const ghostApplication = cloneAgentDatabaseEntry(manifest.databases[0], "ghost", "application");
      const ghostQueue = cloneAgentDatabaseEntry(manifest.databases[1], "ghost", "session_queue");
      manifest.databases.push(ghostApplication, ghostQueue);
      manifest.crossDatabaseInvariants.agents.ghost = {
        ...manifest.crossDatabaseInvariants.agents.plana,
        applicationDatabaseId: ghostApplication.id,
        sessionQueueDatabaseId: ghostQueue.id
      };
    });
    await expect(verifyRecoveryPoint(extra)).rejects.toMatchObject({ code: "BACKUP_AGENT_SET_MISMATCH" });
  });

  it("fails closed on registered missing pairs, partial pairs, and orphan database pairs", async () => {
    const missing = await createFixture({
      agents: [{ id: "missing", enabled: false, databases: "none" }]
    });
    await expect(createRecoveryPoint({ workspace: missing.workspace, quiesced: true })).rejects.toMatchObject({
      code: "AGENT_DATABASE_PAIR_MISSING"
    });

    const partial = await createFixture({
      agents: [{ id: "partial", enabled: true, databases: "application" }]
    });
    await expect(createRecoveryPoint({ workspace: partial.workspace, quiesced: true })).rejects.toMatchObject({
      code: "AGENT_DATABASE_PAIR_INCOMPLETE"
    });

    const orphan = await createFixture();
    await createAgentDatabases(orphan.workspace, "orphan", "both");
    await expect(createRecoveryPoint({ workspace: orphan.workspace, quiesced: true })).rejects.toMatchObject({
      code: "AGENT_DATABASE_ORPHAN"
    });
  });

  it("continues to verify and restore legacy v1 recovery points", async () => {
    const fixture = await createFixture();
    const legacyDirectory = await createLegacyRecoveryPoint(fixture);
    const verified = await verifyRecoveryPoint(legacyDirectory);
    expect(verified.manifest.schemaVersion).toBe(1);
    expect(verified.inspections.map((entry: { id: string }) => entry.id)).toEqual([
      "application",
      "session_queue"
    ]);

    const targetWorkspace = path.join(fixture.root, "legacy-restored");
    const restored = await restoreRecoveryPoint({ backupDirectory: legacyDirectory, targetWorkspace });
    expect(restored.verification.inspections.map((entry: { id: string }) => entry.id)).toEqual([
      "application",
      "session_queue"
    ]);
    await expect(fs.stat(path.join(targetWorkspace, "business", "data", "sunabot.sqlite")))
      .resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("refuses a non-empty restore workspace containing orphan Agent databases", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: true, databases: "both" }]
    });
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const targetWorkspace = path.join(fixture.root, "unsafe-restore");
    await createAgentDatabases(targetWorkspace, "orphan", "both");

    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace
    })).rejects.toMatchObject({ code: "RESTORE_TARGET_NOT_EMPTY" });
  });

  it("resumes idempotently after every durable rename boundary and removes the journal only after full verification", async () => {
    const fixture = await createFixture({
      agents: [{ id: "arona", enabled: true, databases: "both" }]
    });
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const failureSteps = [
      "after-restore-rename-plana-application",
      "after-restore-rename-plana-session_queue",
      "after-restore-rename-arona-application",
      "after-restore-rename-arona-session_queue"
    ];
    for (const [index, failureStep] of failureSteps.entries()) {
      const targetWorkspace = path.join(fixture.root, `interrupted-restore-${index}`);
      const interrupted = Object.assign(new Error("simulated kill after rename"), { preservePartial: true });
      await expect(restoreRecoveryPoint({
        backupDirectory: created.directory,
        targetWorkspace,
        faultInjector(step: string) {
          if (step === failureStep) throw interrupted;
        }
      })).rejects.toThrow("simulated kill after rename");

      const intentPath = path.join(targetWorkspace, `.restore-${created.manifest.backupId}.json`);
      await expect(fs.access(intentPath)).resolves.toBeUndefined();
      const resumed = await restoreRecoveryPoint({ backupDirectory: created.directory, targetWorkspace });
      expect(resumed.verification.inspections).toHaveLength(4);
      await expect(fs.access(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(targetWorkspace)).some((name) => name.startsWith(".restore-"))).toBe(false);
    }
  });

  it.each([
    "after-restore-intent",
    "after-restore-copy-plana-application"
  ])("resumes from the durable restore journal after %s", async (failureStep) => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const targetWorkspace = path.join(fixture.root, `copy-resume-${failureStep}`);
    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace,
      faultInjector(step: string) {
        if (step === failureStep) throw new Error(`stop:${step}`);
      }
    })).rejects.toThrow(`stop:${failureStep}`);

    const intentPath = path.join(targetWorkspace, `.restore-${created.manifest.backupId}.json`);
    await expect(fs.access(intentPath)).resolves.toBeUndefined();
    const resumed = await restoreRecoveryPoint({ backupDirectory: created.directory, targetWorkspace });
    expect(resumed.verification.inspections).toHaveLength(2);
    await expect(fs.access(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a restore stopped after its first staged copy", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const targetWorkspace = path.join(fixture.root, "copy-rollback");
    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace,
      faultInjector(step: string) {
        if (step === "after-restore-copy-plana-application") throw new Error("stop after copy");
      }
    })).rejects.toThrow("stop after copy");

    await expect(rollbackRecoveryPointRestore({
      backupDirectory: created.directory,
      targetWorkspace
    })).resolves.toMatchObject({ ok: true, rolledBack: true });
    expect(await fs.readdir(targetWorkspace)).toEqual([]);
  });

  it("rolls back an interrupted restore without deleting an unknown replacement", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const targetWorkspace = path.join(fixture.root, "rollback-restore");
    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace,
      faultInjector(step: string) {
        if (step === "after-restore-rename-plana-application") throw new Error("stop after first rename");
      }
    })).rejects.toThrow("stop after first rename");

    const destination = path.join(targetWorkspace, "business/data/sunabot.sqlite");
    const original = await fs.readFile(destination);
    await fs.writeFile(destination, Buffer.from("unknown replacement", "utf8"));
    await expect(rollbackRecoveryPointRestore({
      backupDirectory: created.directory,
      targetWorkspace
    })).rejects.toMatchObject({ code: "RESTORE_DESTINATION_CONFLICT" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("unknown replacement");

    await fs.writeFile(destination, original);
    const rolledBack = await rollbackRecoveryPointRestore({ backupDirectory: created.directory, targetWorkspace });
    expect(rolledBack).toMatchObject({ ok: true, rolledBack: true });
    expect(await fs.readdir(targetWorkspace)).toEqual([]);
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

  it("does not follow a symlinked recovery root during retention pruning", async () => {
    const fixture = await createFixture();
    const realBackupsRoot = path.join(fixture.root, "external-retention", "sqlite-recovery");
    const created = await createRecoveryPoint({
      workspace: fixture.workspace,
      backupsRoot: realBackupsRoot,
      quiesced: true,
      now: new Date("2026-05-01T00:00:00.000Z")
    });
    const linkedRoot = path.join(fixture.root, "linked-retention-root");
    await fs.symlink(realBackupsRoot, linkedRoot);

    await expect(applyRetention({
      backupsRoot: linkedRoot,
      now: new Date("2026-07-14T00:00:00.000Z"),
      apply: true
    })).rejects.toMatchObject({ code: "RECOVERY_PATH_UNSAFE" });
    await expect(fs.access(created.directory)).resolves.toBeUndefined();
  });

  it("does not follow a symlinked target parent during restore rollback", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const externalTarget = path.join(fixture.root, "external-rollback-target");
    await expect(restoreRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace: externalTarget,
      faultInjector(step: string) {
        if (step === "after-restore-rename-plana-application") throw new Error("stop rollback fixture");
      }
    })).rejects.toThrow("stop rollback fixture");
    const restoredDatabase = path.join(externalTarget, "business/data/sunabot.sqlite");
    const restoredBytes = await fs.readFile(restoredDatabase);
    const linkedParent = path.join(fixture.root, "linked-rollback-parent");
    await fs.symlink(fixture.root, linkedParent);

    await expect(rollbackRecoveryPointRestore({
      backupDirectory: created.directory,
      targetWorkspace: path.join(linkedParent, path.basename(externalTarget))
    })).rejects.toMatchObject({ code: "RECOVERY_PATH_UNSAFE" });
    expect(await fs.readFile(restoredDatabase)).toEqual(restoredBytes);
  });

  it("does not follow a symlinked target parent during a restore drill", async () => {
    const fixture = await createFixture();
    const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const externalTarget = path.join(fixture.root, "external-drill-target");
    await fs.mkdir(externalTarget);
    const sentinel = path.join(fixture.root, "drill-sentinel.txt");
    await fs.writeFile(sentinel, "keep\n");
    const linkedParent = path.join(fixture.root, "linked-drill-parent");
    await fs.symlink(fixture.root, linkedParent);

    await expect(drillRecoveryPoint({
      backupDirectory: created.directory,
      targetWorkspace: path.join(linkedParent, path.basename(externalTarget))
    })).rejects.toMatchObject({ code: "RECOVERY_PATH_UNSAFE" });
    expect(await fs.readdir(externalTarget)).toEqual([]);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it("preserves external content when interrupted-backup cleanup finds a symlink", async () => {
    const fixture = await createFixture();
    const external = path.join(fixture.root, "external-partial-content");
    await fs.mkdir(external);
    const sentinel = path.join(external, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n");
    await fs.mkdir(fixture.backupsRoot, { recursive: true });
    await fs.symlink(external, path.join(fixture.backupsRoot, ".partial-sqlite-recovery-hostile"));

    await expect(createRecoveryPoint({
      workspace: fixture.workspace,
      quiesced: true
    })).rejects.toMatchObject({ code: "RECOVERY_PATH_UNSAFE" });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });
});

interface FixtureAgentOptions {
  id: string;
  enabled: boolean;
  databases: "both" | "none" | "application" | "queue";
}

async function createFixture(options: { agents?: FixtureAgentOptions[] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-recovery-gate-")));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(workspace, "business", "data");
  const mainDatabasePath = path.join(dataDirectory, "sunabot.sqlite");
  const queueDatabasePath = path.join(dataDirectory, "session-queue.sqlite");
  const backupsRoot = path.join(workspace, "backups", "sqlite-recovery");
  await fs.mkdir(dataDirectory, { recursive: true });

  const main = new ApplicationDataStore(mainDatabasePath);
  main.replaceConversations([]);
  for (const agent of options.agents ?? []) {
    main.createAgent({
      id: agent.id,
      name: agent.id,
      enabled: agent.enabled,
      workspace: `workspace://business/agents/${agent.id}`,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    });
  }
  main.close();

  const outboxId = await createQueueFixture(queueDatabasePath, "plana");
  const agentOutboxIds: Record<string, string> = {};
  for (const agent of options.agents ?? []) {
    const agentOutboxId = await createAgentDatabases(workspace, agent.id, agent.databases);
    if (agentOutboxId) agentOutboxIds[agent.id] = agentOutboxId;
  }

  return {
    root,
    workspace,
    dataDirectory,
    mainDatabasePath,
    queueDatabasePath,
    backupsRoot,
    outboxId,
    agentOutboxIds
  };
}

async function createAgentDatabases(
  workspace: string,
  agentId: string,
  databases: FixtureAgentOptions["databases"]
) {
  if (databases === "none") return undefined;
  const dataDirectory = path.join(workspace, "business", "agents", agentId, "data");
  await fs.mkdir(dataDirectory, { recursive: true });
  if (databases === "both" || databases === "application") {
    const application = new ApplicationDataStore(path.join(dataDirectory, "sunabot.sqlite"));
    application.replaceConversations([]);
    application.close();
  }
  if (databases === "both" || databases === "queue") {
    return createQueueFixture(path.join(dataDirectory, "session-queue.sqlite"), agentId);
  }
  return undefined;
}

function downgradeApplicationToStorageSchema9(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("DROP TABLE conversation_thread_states;");
    database.prepare(`
      UPDATE app_metadata SET value = '9' WHERE key = 'storage-schema-version'
    `).run();
  } finally {
    database.close();
  }
}

async function createQueueFixture(queueDatabasePath: string, agentId: string) {
  const queue = new SessionStore({ databasePath: queueDatabasePath });
  queue.enqueueEvent({
    sessionId: `private:${agentId}:171419991`,
    kind: "incoming",
    dedupeKey: `onebot:recovery-fixture:${agentId}`,
    payload: { text: "test recovery" }
  });
  const turn = queue.claimNextTurn({ workerId: "reply-worker" })!;
  const finished = queue.finishTurn({
    turnId: turn.turn.id,
    workerId: "reply-worker",
    outcome: "replied",
    outbox: [{
      kind: "onebot.private",
      dedupeKey: `reply:recovery-fixture:${agentId}`,
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
  return finished.outbox[0]!.id;
}

async function createLegacyRecoveryPoint(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const created = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
  const legacyDirectory = path.join(fixture.root, "legacy-v1-recovery");
  await fs.mkdir(legacyDirectory);
  const application = created.manifest.databases.find((entry: { agentId: string; kind: string }) =>
    entry.agentId === "plana" && entry.kind === "application"
  );
  const queue = created.manifest.databases.find((entry: { agentId: string; kind: string }) =>
    entry.agentId === "plana" && entry.kind === "session_queue"
  );
  if (!application || !queue) throw new Error("v2 fixture is missing the Plana database pair");
  await fs.copyFile(path.join(created.directory, application.file), path.join(legacyDirectory, "application.sqlite"));
  await fs.copyFile(path.join(created.directory, queue.file), path.join(legacyDirectory, "session-queue.sqlite"));

  const legacyApplication = legacyDatabaseEntry(application, {
    id: "application",
    source: "business/data/sunabot.sqlite",
    file: "application.sqlite"
  });
  const legacyQueue = legacyDatabaseEntry(queue, {
    id: "session_queue",
    source: "business/data/session-queue.sqlite",
    file: "session-queue.sqlite"
  });
  const planaInvariants = created.manifest.crossDatabaseInvariants.agents.plana;
  const manifest = {
    ...created.manifest,
    schemaVersion: 1,
    databases: [legacyApplication, legacyQueue],
    crossDatabaseInvariants: {
      queueAuthoritativeForDelivery: true,
      mainProjectionMayLagAfterExternalSend: true,
      outboxStatusCounts: planaInvariants.outboxStatusCounts,
      terminalOutboxDigest: planaInvariants.terminalOutboxDigest
    }
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(legacyDirectory, "manifest.json"), bytes);
  await fs.writeFile(
    path.join(legacyDirectory, "manifest.sha256"),
    `${createHash("sha256").update(bytes).digest("hex")}  manifest.json\n`
  );
  return legacyDirectory;
}

function legacyDatabaseEntry(
  entry: Record<string, unknown>,
  legacy: { id: string; source: string; file: string }
) {
  const { agentId: _agentId, kind: _kind, schemaProfile: _schemaProfile, ...rest } = entry;
  return {
    ...rest,
    ...legacy,
    checkpoint: {
      ...(rest.checkpoint as Record<string, unknown>),
      id: legacy.id
    }
  };
}

async function rewriteManifest(directory: string, mutate: (manifest: any) => void) {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  mutate(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(manifestPath, bytes);
  await fs.writeFile(
    path.join(directory, "manifest.sha256"),
    `${createHash("sha256").update(bytes).digest("hex")}  manifest.json\n`
  );
}

function cloneAgentDatabaseEntry(entry: any, agentId: string, kind: "application" | "session_queue") {
  const fileSuffix = kind === "application" ? "application" : "session-queue";
  const sourceFile = kind === "application" ? "sunabot.sqlite" : "session-queue.sqlite";
  const id = `agent:${agentId}:${kind}`;
  return {
    ...structuredClone(entry),
    id,
    agentId,
    kind,
    source: `business/agents/${agentId}/data/${sourceFile}`,
    file: `agent-${agentId}-${fileSuffix}.sqlite`,
    checkpoint: {
      ...entry.checkpoint,
      id
    }
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
