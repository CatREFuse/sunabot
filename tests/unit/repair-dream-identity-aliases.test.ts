// @vitest-environment node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  applyDreamIdentityAliasRepair,
  formatDreamIdentityAliasRepairError,
  inspectDreamIdentityAliasRepair
} from "../../tooling/migrations/repair-dream-identity-aliases.js";
import { createRecoveryPoint } from "../../tooling/workspace/sqlite-recovery.mjs";

const TARGET_RUN_ID = "c810a3fa-3422-46fc-a2b9-d5b6938fe476";
const TARGET_RECORD_IDS = [
  "long_term_9b4c7b2df5c0c18e2967855b0fb5b0c2",
  "long_term_098cdf1f3f3dc989950dd47329d8c0d9",
  "long_term_ce5008d11b33e0b1e41c075e3a7a0532"
] as const;
const SOURCE_IDS = [
  [
    "long_term_c5d272fecb51d14020da37059b197833",
    "long_term_ac2a56335036310202a9287e9e5b2baa",
    "long_term_899743c1eab14b9ad24c2e4811862dd4",
    "long_term_6ee509b20382a936cba0d9b67a485d02",
    TARGET_RECORD_IDS[0]
  ],
  [
    "long_term_8269a2a3401244053c9c9aa5ee902ff3",
    "long_term_d6c6eeb012183660f31b0b18672189ff",
    TARGET_RECORD_IDS[1]
  ],
  [
    TARGET_RECORD_IDS[2],
    "long_term_f235fb5252c9437b3808e022fbab936f"
  ]
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("Dream identity alias repair", () => {
  it("dry-runs by default without changing current data or exposing reconstructed identities", async () => {
    const fixture = await createFixture();
    const before = await currentFileSnapshot(fixture);

    const inspection = await inspectDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
    });

    expect(inspection).toMatchObject({
      migrationId: "dream-identity-alias-repair-c810-v1",
      agentId: "arona",
      runId: TARGET_RUN_ID,
      mode: "dry-run",
      mapping: {
        uniqueTokens: 63,
        uniquelyResolved: 63,
        unresolved: 0,
        ambiguous: 0
      },
      aliases: {
        inputOccurrences: 429,
        outputOccurrences: 12,
        dreamTextOccurrences: 1,
        memoryOccurrences: 5,
        global24HexOccurrences: 447,
        legacy10HexOccurrences: 1
      },
      records: TARGET_RECORD_IDS.map((recordId, reviewIndex) => ({
        recordId,
        reviewIndex,
        canonicalMatches: true,
        sourceIds: [...SOURCE_IDS[reviewIndex]!]
      }))
    });
    expect(inspection.mapping.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(inspection)).not.toContain(fixture.privateCandidate);
    expect(JSON.stringify(inspection)).not.toContain("synthetic private fact");
    expect(await currentFileSnapshot(fixture)).toEqual(before);
  });

  it("requires stopped services and a newer quiesced rollback recovery point before apply", async () => {
    const fixture = await createFixture();
    const inspection = await inspectDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
    });
    const before = await currentFileSnapshot(fixture);

    await expect(applyDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
      rollbackRecoveryPoint: fixture.rollbackRecovery.directory,
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      expectedMappingDigest: inspection.mapping.digest,
      quiesced: false,
      serviceProbe: stoppedServiceProbe
    })).rejects.toMatchObject({ code: "QUIESCED_REQUIRED" });

    await expect(applyDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
      rollbackRecoveryPoint: fixture.rollbackRecovery.directory,
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      expectedMappingDigest: inspection.mapping.digest,
      quiesced: true,
      serviceProbe: {
        ...stoppedServiceProbe,
        async runningHostProcesses() {
          return ["native-core:123"];
        }
      }
    })).rejects.toMatchObject({ code: "SERVICE_RUNNING" });

    await expect(applyDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
      rollbackRecoveryPoint: fixture.mappingRecovery.directory,
      rollbackRecoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
      expectedMappingDigest: inspection.mapping.digest,
      quiesced: true,
      serviceProbe: stoppedServiceProbe
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_NOT_NEW" });

    expect(await currentFileSnapshot(fixture)).toEqual(before);
  });

  it("rejects a 24-hex alias left in any other application table", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.prepare(`
        INSERT INTO app_metadata(key, value) VALUES (?, ?)
      `).run("unrelated-alias-residual", aliasToken("f".repeat(64), "outside-target-run"));
    } finally {
      database.close();
    }

    await expect(inspectDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
    })).rejects.toMatchObject({ code: "ALIAS_COUNTS_INVALID" });
  });

  it("rejects a rollback recovery point after same-count application content drifts", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const result = database.prepare(`
        UPDATE app_metadata SET value = ?
        WHERE key = 'dream-alias-repair-rollback-fixture'
      `).run("same-row-count-content-drift");
      expect(Number(result.changes)).toBe(1);
    } finally {
      database.close();
    }

    await expect(applyDreamIdentityAliasRepair(
      applyInput(fixture, inspection.mapping.digest)
    )).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_STALE" });
  });

  it("rejects same-count target application drift after workspace binding and before BEGIN", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    let driftInjected = false;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      faultInjector(point) {
        if (point !== "before-write-open") return;
        const database = new DatabaseSync(fixture.databasePath);
        try {
          const result = database.prepare(`
            UPDATE app_metadata SET value = ?
            WHERE key = 'dream-alias-repair-rollback-fixture'
          `).run("same-count-drift-between-binding-and-begin");
          expect(Number(result.changes)).toBe(1);
          driftInjected = true;
        } finally {
          database.close();
        }
      }
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_STALE" });

    expect(driftInjected).toBe(true);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect((database.prepare(`
        SELECT value FROM app_metadata
        WHERE key = 'dream-alias-repair-rollback-fixture'
      `).get() as { value: string }).value).toBe("same-count-drift-between-binding-and-begin");
    } finally {
      database.close();
    }
  });

  it("rejects a rollback recovery point after outbox payload drifts without changing row counts", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const queue = new DatabaseSync(fixture.queuePath);
    try {
      const result = queue.prepare(`
        UPDATE outbox
        SET payload_json = replace(payload_json, 'fixture-outbox', 'same-row-count-outbox-drift')
        WHERE dedupe_key = 'outbox:arona'
      `).run();
      expect(Number(result.changes)).toBe(1);
    } finally {
      queue.close();
    }

    await expect(applyDreamIdentityAliasRepair(
      applyInput(fixture, inspection.mapping.digest)
    )).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_STALE" });
  });

  it("rejects a rollback recovery point after another Agent database drifts", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const database = new DatabaseSync(fixture.otherDatabasePath);
    try {
      const result = database.prepare(`
        UPDATE app_metadata SET value = ?
        WHERE key = 'other-agent-binding-fixture'
      `).run("other-agent-content-drift");
      expect(Number(result.changes)).toBe(1);
    } finally {
      database.close();
    }

    await expect(applyDreamIdentityAliasRepair(
      applyInput(fixture, inspection.mapping.digest)
    )).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_STALE" });
  });

  it("rejects symbolic-link and hard-link application sidecars", async () => {
    const symlinkFixture = await createFixture();
    const symlinkTarget = path.join(symlinkFixture.root, "foreign-wal");
    await fs.writeFile(symlinkTarget, "unsafe", "utf8");
    await fs.symlink(symlinkTarget, `${symlinkFixture.databasePath}-wal`);

    await expect(inspectFixture(symlinkFixture)).rejects.toMatchObject({
      code: "APPLICATION_FILE_UNSAFE"
    });

    const hardlinkFixture = await createFixture();
    const hardlinkTarget = path.join(hardlinkFixture.root, "foreign-shm");
    await fs.writeFile(hardlinkTarget, "unsafe", "utf8");
    await fs.link(hardlinkTarget, `${hardlinkFixture.databasePath}-shm`);

    await expect(inspectFixture(hardlinkFixture)).rejects.toMatchObject({
      code: "APPLICATION_FILE_UNSAFE"
    });
  });

  it("rejects swap-open-restore when the write connection holds the replacement inode", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const displacedPath = `${fixture.databasePath}.displaced`;
    const openedReplacementPath = `${fixture.databasePath}.opened-replacement`;
    const originalIdentity = fileIdentity(await fs.lstat(fixture.databasePath));

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point === "before-write-open") {
          await fs.rename(fixture.databasePath, displacedPath);
          await fs.copyFile(displacedPath, fixture.databasePath);
        }
        if (point === "after-write-open") {
          await fs.rename(fixture.databasePath, openedReplacementPath);
          await fs.rename(displacedPath, fixture.databasePath);
        }
      }
    })).rejects.toMatchObject({ code: "APPLICATION_OPEN_IDENTITY_CHANGED" });

    expect(fileIdentity(await fs.lstat(fixture.databasePath))).toBe(originalIdentity);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects swap-open-restore when the write connection holds replacement WAL and SHM inodes", async () => {
    const fixture = await createFixture();
    await seedQuiescedSidecars(fixture.databasePath);
    const inspection = await inspectFixture(fixture);
    const attackRoot = path.join(fixture.root, "sidecar-swap");
    await fs.mkdir(attackRoot);
    const baselineIdentities = Object.fromEntries(await Promise.all(
      ["-wal", "-shm"].map(async (suffix) => [
        suffix,
        fileIdentity(await fs.lstat(`${fixture.databasePath}${suffix}`))
      ])
    ));
    let openedIdentities: Record<string, string> | undefined;
    let restoredIdentities: Record<string, string> | undefined;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point === "before-begin") {
          for (const suffix of ["-wal", "-shm"]) {
            const baselinePath = path.join(attackRoot, `${suffix.slice(1)}-baseline`);
            await fs.rename(`${fixture.databasePath}${suffix}`, baselinePath);
            await fs.copyFile(baselinePath, `${fixture.databasePath}${suffix}`);
          }
        }
        if (point === "after-begin") {
          openedIdentities = Object.fromEntries(await Promise.all(
            ["-wal", "-shm"].map(async (suffix) => [
              suffix,
              fileIdentity(await fs.lstat(`${fixture.databasePath}${suffix}`))
            ])
          ));
          for (const suffix of ["-wal", "-shm"]) {
            const baselinePath = path.join(attackRoot, `${suffix.slice(1)}-baseline`);
            const openedPath = path.join(attackRoot, `${suffix.slice(1)}-opened`);
            await fs.rename(`${fixture.databasePath}${suffix}`, openedPath);
            await fs.rename(baselinePath, `${fixture.databasePath}${suffix}`);
          }
          restoredIdentities = Object.fromEntries(await Promise.all(
            ["-wal", "-shm"].map(async (suffix) => [
              suffix,
              fileIdentity(await fs.lstat(`${fixture.databasePath}${suffix}`))
            ])
          ));
        }
      }
    })).rejects.toMatchObject({ code: "APPLICATION_OPEN_IDENTITY_CHANGED" });

    expect(openedIdentities).not.toEqual(baselineIdentities);
    expect(restoredIdentities).toEqual(baselineIdentities);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects child-directory link-count changes disguised as WAL and SHM appearance", async () => {
    const fixture = await createFixture();
    await Promise.all([
      fs.rm(`${fixture.databasePath}-wal`, { force: true }),
      fs.rm(`${fixture.databasePath}-shm`, { force: true })
    ]);
    const inspection = await inspectFixture(fixture);
    let directoriesCreated = false;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point !== "after-begin") return;
        await Promise.all([
          fs.mkdir(path.join(path.dirname(fixture.databasePath), "wal-link-count-decoy")),
          fs.mkdir(path.join(path.dirname(fixture.databasePath), "shm-link-count-decoy"))
        ]);
        directoriesCreated = true;
      }
    })).rejects.toMatchObject({ code: "APPLICATION_OPEN_IDENTITY_CHANGED" });

    expect(directoriesCreated).toBe(true);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("ignores unrelated sibling-directory churn above the bound recovery and database roots", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const created: string[] = [];

    const result = await applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point === "after-rollback-verify") {
          const sibling = path.join(fixture.root, "recovery-ancestor-sibling");
          await fs.mkdir(sibling);
          created.push(sibling);
        }
        if (point === "after-begin") {
          const sibling = path.join(fixture.root, "application-ancestor-sibling");
          await fs.mkdir(sibling);
          created.push(sibling);
        }
      }
    });

    expect(created).toHaveLength(2);
    expect(result).toMatchObject({ applied: true, global24HexOccurrences: 0 });
  });

  it("rejects a complete junk WAL and SHM set injected after rollback verification", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const sidecarPaths = recoverySidecarPaths(fixture.rollbackRecovery);
    let injectedCount = 0;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point !== "after-rollback-verify") return;
        await Promise.all(sidecarPaths.map(async (sidecarPath, index) => {
          await fs.rm(sidecarPath, { force: true });
          await fs.writeFile(sidecarPath, `junk-sidecar-${index}`, "utf8");
        }));
        injectedCount = sidecarPaths.length;
      }
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(injectedCount).toBe(fixture.rollbackRecovery.manifest.databases.length * 2);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects a same-inode same-size rollback sidecar replacement after verification", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    let replacement: {
      identityBefore: string;
      identityAfter: string;
      sizeBefore: number;
      sizeAfter: number;
    } | undefined;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point !== "after-rollback-verify") return;
        for (const sidecarPath of recoverySidecarPaths(fixture.rollbackRecovery)) {
          let bytes: Buffer;
          try {
            bytes = await fs.readFile(sidecarPath);
          } catch {
            continue;
          }
          if (!bytes.length) continue;
          const before = await fs.lstat(sidecarPath);
          const replacementBytes = Buffer.from(bytes);
          replacementBytes[replacementBytes.length - 1] ^= 0xff;
          const handle = await fs.open(sidecarPath, "r+");
          try {
            await handle.write(replacementBytes, 0, replacementBytes.length, 0);
            await handle.sync();
          } finally {
            await handle.close();
          }
          const after = await fs.lstat(sidecarPath);
          replacement = {
            identityBefore: fileIdentity(before),
            identityAfter: fileIdentity(after),
            sizeBefore: before.size,
            sizeAfter: after.size
          };
          return;
        }
        throw new Error("rollback verifier did not produce a non-empty sidecar");
      }
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(replacement).toBeDefined();
    expect(replacement?.identityAfter).toBe(replacement?.identityBefore);
    expect(replacement?.sizeAfter).toBe(replacement?.sizeBefore);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects same-inode sidecar content rewritten while later rollback databases verify", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const attack = createVerifyLoopSidecarAttack("rewrite");

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      rollbackVerifyDatabaseClosedObserver: attack.observer
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(attack.state.attackedAtClose).toBeGreaterThan(0);
    expect(attack.state.attackedAtClose).toBeLessThan(
      fixture.rollbackRecovery.manifest.databases.length
    );
    expect(attack.state.identityAfter).toBe(attack.state.identityBefore);
    expect(attack.state.sizeAfter).toBe(attack.state.sizeBefore);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects a sidecar inode replaced while later rollback databases verify", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const attack = createVerifyLoopSidecarAttack("replace");

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      rollbackVerifyDatabaseClosedObserver: attack.observer
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(attack.state.attackedAtClose).toBeGreaterThan(0);
    expect(attack.state.attackedAtClose).toBeLessThan(
      fixture.rollbackRecovery.manifest.databases.length
    );
    expect(attack.state.identityAfter).not.toBe(attack.state.identityBefore);
    expect(attack.state.sizeAfter).toBe(attack.state.sizeBefore);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects a complete junk sidecar set added for an early rollback database", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    const attack = createVerifyLoopSidecarAttack("complete-junk");

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      rollbackVerifyDatabaseClosedObserver: attack.observer
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(attack.state.attackedAtClose).toBeGreaterThan(0);
    expect(attack.state.attackedAtClose).toBeLessThan(
      fixture.rollbackRecovery.manifest.databases.length
    );
    expect(attack.state.attackedSidecars).toBe(2);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("binds verification to the exact rollback manifest snapshot", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    let manifestChanged = false;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point: string) {
        if (point !== "after-rollback-verify") return;
        const manifestPath = path.join(fixture.rollbackRecovery.directory, "manifest.json");
        const checksumPath = path.join(fixture.rollbackRecovery.directory, "manifest.sha256");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
          createdAt: string;
        };
        manifest.createdAt = "2026-07-31T02:30:30.907Z";
        const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        await fs.writeFile(manifestPath, manifestBytes);
        await fs.writeFile(
          checksumPath,
          `${sha256(manifestBytes)}  manifest.json\n`,
          "utf8"
        );
        manifestChanged = true;
      }
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(manifestChanged).toBe(true);
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(447);
  });

  it("rejects replacement of a bound rollback database before COMMIT and rolls back", async () => {
    const fixture = await createFixture();
    const before = await logicalSnapshot(fixture);
    const inspection = await inspectFixture(fixture);
    const rollbackEntry = fixture.rollbackRecovery.manifest.databases.find(
      (entry: { agentId: string; kind: string }) =>
        entry.agentId === "arona" && entry.kind === "application"
    ) as { file: string };
    const mappingEntry = fixture.mappingRecovery.manifest.databases.find(
      (entry: { agentId: string; kind: string }) =>
        entry.agentId === "arona" && entry.kind === "application"
    ) as { file: string };
    const rollbackDatabasePath = path.join(
      fixture.rollbackRecovery.directory,
      rollbackEntry.file
    );
    const displacedPath = path.join(fixture.root, "rollback-application-displaced.sqlite");
    let replacementInstalled = false;

    await expect(applyDreamIdentityAliasRepair({
      ...applyInput(fixture, inspection.mapping.digest),
      async faultInjector(point) {
        if (point !== "before-commit") return;
        await fs.rename(rollbackDatabasePath, displacedPath);
        await fs.copyFile(
          path.join(fixture.mappingRecovery.directory, mappingEntry.file),
          rollbackDatabasePath
        );
        replacementInstalled = true;
      }
    })).rejects.toMatchObject({ code: "ROLLBACK_RECOVERY_POINT_CHANGED" });

    expect(replacementInstalled).toBe(true);
    expect(await logicalSnapshot(fixture)).toEqual(before);
  });

  it("applies all gates in one transaction while preserving counts, queue, and working memory", async () => {
    const fixture = await createFixture();
    const before = await logicalSnapshot(fixture);
    const inspection = await inspectDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
    });

    const result = await applyDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
      rollbackRecoveryPoint: fixture.rollbackRecovery.directory,
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      expectedMappingDigest: inspection.mapping.digest,
      quiesced: true,
      serviceProbe: stoppedServiceProbe
    });

    expect(result).toMatchObject({
      applied: true,
      updatedMemoryRecords: 3,
      updatedDreamRuns: 1,
      mappingDigest: inspection.mapping.digest,
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      global24HexOccurrences: 0,
      integrity: "ok",
      foreignKeyViolations: 0,
      revisionDelta: { long_term: 3, user_profile: 0, working: 0 }
    });
    expect(JSON.stringify(result)).not.toContain(fixture.privateCandidate);
    expect(JSON.stringify(result)).not.toContain("synthetic private fact");

    const after = await logicalSnapshot(fixture);
    expect(after.tableCounts).toEqual(before.tableCounts);
    expect(after.queue).toEqual(before.queue);
    expect(after.workingMemory).toEqual(before.workingMemory);
    expect(after.alias24Occurrences).toBe(0);
    expect(after.legacy10Occurrences).toBe(1);
    expect(after.revisions).toEqual({
      long_term: before.revisions.long_term + 3,
      user_profile: before.revisions.user_profile,
      working: before.revisions.working
    });
    expect(after.runInputDigest).toBe(canonicalJsonDigest(after.runInput));
    expect(after.dreamText).toBe(after.output.dream.text);
    expect(after.records.map((record) => record.fact)).toEqual(
      after.output.longTermReviews.slice(0, 3).map((review) => review.canonical.fact)
    );
    for (const record of after.records) {
      expect(record.eventFingerprint).toBe(eventFingerprint(record));
    }
  });

  it("rolls back every database update when a transactional gate fails", async () => {
    const fixture = await createFixture();
    const before = await logicalSnapshot(fixture);
    const inspection = await inspectDreamIdentityAliasRepair({
      workspace: fixture.workspace,
      agentId: "arona",
      runId: TARGET_RUN_ID,
      recoveryPoint: fixture.mappingRecovery.directory,
      recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
    });

    let failure: unknown;
    try {
      await applyDreamIdentityAliasRepair({
        workspace: fixture.workspace,
        agentId: "arona",
        runId: TARGET_RUN_ID,
        recoveryPoint: fixture.mappingRecovery.directory,
        recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
        rollbackRecoveryPoint: fixture.rollbackRecovery.directory,
        rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
        expectedMappingDigest: inspection.mapping.digest,
        quiesced: true,
        serviceProbe: stoppedServiceProbe,
        faultInjector(point) {
          if (point === "after-memory-updates") {
            throw Object.assign(
              new Error(`synthetic repair fault: ${fixture.privateCandidate}`),
              { code: `INJECTED_${fixture.privateCandidate}` }
            );
          }
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "DREAM_IDENTITY_ALIAS_REPAIR_FAILED",
      message: "Dream 身份别名修复失败。"
    });
    const formatted = formatDreamIdentityAliasRepairError(failure);
    expect(formatted).toEqual({
      ok: false,
      code: "DREAM_IDENTITY_ALIAS_REPAIR_FAILED",
      error: "Dream 身份别名修复失败。"
    });
    expect(JSON.stringify(formatted)).not.toContain(fixture.privateCandidate);
    expect(JSON.stringify(formatted)).not.toContain("synthetic repair fault");
    expect(JSON.stringify(formatted)).not.toContain("INJECTED_");

    expect(await logicalSnapshot(fixture)).toEqual(before);
  });

  it("treats a COMMIT that lands before its executor throws as restore-only", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    let failure: unknown;
    try {
      await applyDreamIdentityAliasRepair({
        ...applyInput(fixture, inspection.mapping.digest),
        commitExecutor(database) {
          database.exec("COMMIT");
          throw new Error(`private ambiguous COMMIT detail: ${fixture.privateCandidate}`);
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "DREAM_IDENTITY_ALIAS_REPAIR_COMMITTED_RESTORE_REQUIRED",
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      guidance: expect.stringContaining("禁止重跑 apply")
    });
    const formatted = formatDreamIdentityAliasRepairError(failure);
    expect(formatted).toEqual({
      code: "DREAM_IDENTITY_ALIAS_REPAIR_COMMITTED_RESTORE_REQUIRED",
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
      guidance: "修复已提交但提交后校验未完成；必须使用 rollbackRecoveryPointId 对应的恢复点恢复，禁止重跑 apply。"
    });
    expect(JSON.stringify(formatted)).not.toContain(fixture.privateCandidate);
    expect(JSON.stringify(formatted)).not.toContain("private ambiguous COMMIT detail");
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(0);
  });

  it("requires restore when the committed target database drifts before checkpoint", async () => {
    const fixture = await createFixture();
    const inspection = await inspectFixture(fixture);
    let driftInjected = false;
    let failure: unknown;
    try {
      await applyDreamIdentityAliasRepair({
        ...applyInput(fixture, inspection.mapping.digest),
        faultInjector(point) {
          if (point !== "after-commit") return;
          const database = new DatabaseSync(fixture.databasePath);
          try {
            const result = database.prepare(`
              UPDATE app_metadata SET value = ?
              WHERE key = 'dream-alias-repair-rollback-fixture'
            `).run("valid-sqlite-drift-after-commit");
            expect(Number(result.changes)).toBe(1);
            driftInjected = true;
          } finally {
            database.close();
          }
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(driftInjected).toBe(true);
    expect(failure).toMatchObject({
      code: "DREAM_IDENTITY_ALIAS_REPAIR_COMMITTED_RESTORE_REQUIRED",
      rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId
    });
    expect((await logicalSnapshot(fixture)).alias24Occurrences).toBe(0);
  });
});

type DreamAliasFixture = Awaited<ReturnType<typeof createFixture>>;

function inspectFixture(fixture: DreamAliasFixture) {
  return inspectDreamIdentityAliasRepair({
    workspace: fixture.workspace,
    agentId: "arona",
    runId: TARGET_RUN_ID,
    recoveryPoint: fixture.mappingRecovery.directory,
    recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId
  });
}

function applyInput(fixture: DreamAliasFixture, expectedMappingDigest: string) {
  return {
    workspace: fixture.workspace,
    agentId: "arona",
    runId: TARGET_RUN_ID,
    recoveryPoint: fixture.mappingRecovery.directory,
    recoveryPointId: fixture.mappingRecovery.manifest.recoveryPointId,
    rollbackRecoveryPoint: fixture.rollbackRecovery.directory,
    rollbackRecoveryPointId: fixture.rollbackRecovery.manifest.recoveryPointId,
    expectedMappingDigest,
    quiesced: true,
    serviceProbe: stoppedServiceProbe
  };
}

function recoverySidecarPaths(recovery: {
  directory: string;
  manifest: { databases: Array<{ file: string }> };
}) {
  return recovery.manifest.databases.flatMap((entry) => [
    path.join(recovery.directory, `${entry.file}-wal`),
    path.join(recovery.directory, `${entry.file}-shm`)
  ]);
}

function createVerifyLoopSidecarAttack(
  mode: "rewrite" | "replace" | "complete-junk"
) {
  const state: {
    closedCount: number;
    attackedAtClose?: number;
    attackedSidecars?: number;
    identityBefore?: string;
    identityAfter?: string;
    sizeBefore?: number;
    sizeAfter?: number;
  } = { closedCount: 0 };
  return {
    state,
    observer(event: { databasePath: string; id: string }) {
      state.closedCount += 1;
      if (event.id !== "agent:arona:application") return;
      state.attackedAtClose = state.closedCount;
      const sidecarPaths = [
        `${event.databasePath}-wal`,
        `${event.databasePath}-shm`
      ];
      if (mode === "complete-junk") {
        sidecarPaths.forEach((sidecarPath, index) => {
          fsSync.rmSync(sidecarPath, { force: true });
          fsSync.writeFileSync(sidecarPath, Buffer.alloc(64, index + 1));
        });
        state.attackedSidecars = sidecarPaths.length;
        return;
      }
      const sidecarPath = sidecarPaths.find((candidate) => {
        try {
          return fsSync.lstatSync(candidate).size > 0;
        } catch {
          return false;
        }
      });
      if (!sidecarPath) throw new Error("verified database did not produce a sidecar");
      const before = fsSync.lstatSync(sidecarPath);
      const replacement = fsSync.readFileSync(sidecarPath);
      replacement[replacement.length - 1] = replacement[replacement.length - 1]! ^ 0xff;
      if (mode === "replace") {
        fsSync.rmSync(sidecarPath);
        fsSync.writeFileSync(sidecarPath, replacement);
      } else {
        const descriptor = fsSync.openSync(sidecarPath, "r+");
        try {
          fsSync.writeSync(descriptor, replacement, 0, replacement.length, 0);
          fsSync.fsyncSync(descriptor);
        } finally {
          fsSync.closeSync(descriptor);
        }
      }
      const after = fsSync.lstatSync(sidecarPath);
      state.identityBefore = fileIdentity(before);
      state.identityAfter = fileIdentity(after);
      state.sizeBefore = before.size;
      state.sizeAfter = after.size;
    }
  };
}

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dream-alias-repair-")));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const mainData = path.join(workspace, "business", "data");
  const agentRoot = path.join(workspace, "business", "agents", "arona");
  const agentData = path.join(agentRoot, "data");
  const databasePath = path.join(agentData, "sunabot.sqlite");
  const queuePath = path.join(agentData, "session-queue.sqlite");
  const workingMemoryPath = path.join(agentRoot, "WORKING_MEMORY.md");
  const otherAgentRoot = path.join(workspace, "business", "agents", "koharu");
  const otherAgentData = path.join(otherAgentRoot, "data");
  const otherDatabasePath = path.join(otherAgentData, "sunabot.sqlite");
  const otherQueuePath = path.join(otherAgentData, "session-queue.sqlite");
  await fs.mkdir(mainData, { recursive: true });
  await fs.mkdir(agentData, { recursive: true });
  await fs.mkdir(otherAgentData, { recursive: true });
  await fs.writeFile(workingMemoryPath, "# 工作记忆\n\nfixture\n", "utf8");

  const main = new ApplicationDataStore(path.join(mainData, "sunabot.sqlite"));
  main.replaceConversations([]);
  main.createAgent({
    id: "arona",
    name: "Arona",
    enabled: true,
    workspace: "workspace://business/agents/arona",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  });
  main.createAgent({
    id: "koharu",
    name: "Koharu",
    enabled: false,
    workspace: "workspace://business/agents/koharu",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  });
  main.close();
  await createQueue(path.join(mainData, "session-queue.sqlite"), "plana");

  const application = new ApplicationDataStore(databasePath);
  application.replaceConversations([]);
  application.close();
  await createQueue(queuePath, "arona");
  const otherApplication = new ApplicationDataStore(otherDatabasePath);
  otherApplication.replaceConversations([]);
  otherApplication.close();
  const otherDatabase = new DatabaseSync(otherDatabasePath);
  try {
    otherDatabase.prepare(`
      INSERT INTO app_metadata(key, value) VALUES (?, ?)
    `).run("other-agent-binding-fixture", "before-drift");
  } finally {
    otherDatabase.close();
  }
  await createQueue(otherQueuePath, "koharu");

  const seed = "a".repeat(64);
  const candidates = Array.from({ length: 63 }, (_, index) => index < 26
    ? String(8_000_000_000 + index)
    : `private-candidate-${index}`);
  const tokens = candidates.map((candidate) => aliasToken(seed, candidate));
  const inputAliases = Array.from({ length: 429 }, (_, index) => tokens[index % tokens.length]!);
  const facts = [
    `synthetic private fact ${tokens[0]}`,
    `synthetic private fact ${tokens[0]} ${tokens[1]}`,
    `synthetic private fact ${tokens[2]} ${tokens[3]}`
  ];
  const dreamText = `synthetic dream ${tokens[4]}`;
  const reviews = TARGET_RECORD_IDS.map((recordId, index) => ({
    action: "merge",
    sourceIds: [...SOURCE_IDS[index]!],
    canonical: { fact: facts[index]! },
    reason: "synthetic",
    importance: 0.9,
    futureRelevance: 0.8,
    emotionalSalience: 0.7,
    confidence: 0.99,
    recordId
  }));
  const rawOutput = {
    schemaVersion: 1,
    dream: { text: dreamText, factuality: "imagined" },
    workingReviews: [],
    longTermReviews: reviews,
    personaAdjustment: null,
    fieldKnowledge: null
  };
  const output = {
    ...rawOutput,
    rawOutput: JSON.stringify(rawOutput)
  };
  const input = {
    schemaVersion: 1,
    workingDigest: "b".repeat(64),
    longTermDigest: "c".repeat(64),
    payload: { aliases: inputAliases }
  };

  const database = new DatabaseSync(databasePath);
  try {
    const insertMemory = database.prepare(`
      INSERT INTO memory_records(source, position, record_id, data_json)
      VALUES (?, ?, ?, ?)
    `);
    candidates.forEach((candidate, index) => {
      const numeric = /^\d+$/u.test(candidate);
      insertMemory.run("user_profile", index, `profile_${index}`, JSON.stringify({
        id: `profile_${index}`,
        fact: "fixture profile",
        ...(numeric
          ? { userId: candidate, userIds: [candidate] }
          : { userName: candidate, addressNames: [candidate] })
      }));
    });
    TARGET_RECORD_IDS.forEach((recordId, index) => {
      const record = {
        schemaVersion: 2,
        id: recordId,
        fact: facts[index]!,
        source: "sunabot.dream",
        userIds: [candidates[index]!],
        addressNames: [],
        occurredAt: "2026-07-01T00:00:00.000Z",
        occurredEndAt: null,
        eventType: "other",
        subjectKey: `fixture-${index}`,
        dreamRunId: TARGET_RUN_ID,
        consolidatedBy: "sunabot.dream"
      };
      insertMemory.run("long_term", 197 + index, recordId, JSON.stringify({
        ...record,
        eventFingerprint: eventFingerprint(record)
      }));
    });
    insertDreamRun(database, {
      id: "legacy-run",
      localDate: "2026-07-30",
      seed: "d".repeat(64),
      input: { legacy: "人物-abcdef1234" },
      output: null,
      dreamText: null,
      result: { ok: true }
    });
    insertDreamRun(database, {
      id: TARGET_RUN_ID,
      localDate: "2026-07-31",
      seed,
      input,
      output,
      dreamText,
      result: { merged: 3 }
    });
  } finally {
    database.close();
  }

  const mappingRecovery = await createRecoveryPoint({
    workspace,
    quiesced: true,
    now: new Date("2026-07-31T01:30:29.907Z"),
    backupId: "sqlite-recovery-test-mapping"
  });
  const currentDatabase = new DatabaseSync(databasePath);
  try {
    currentDatabase.prepare(`
      INSERT INTO app_metadata(key, value) VALUES (?, ?)
    `).run("dream-alias-repair-rollback-fixture", "created-after-mapping-recovery");
  } finally {
    currentDatabase.close();
  }
  const rollbackRecovery = await createRecoveryPoint({
    workspace,
    quiesced: true,
    now: new Date("2026-07-31T02:30:29.907Z"),
    backupId: "sqlite-recovery-test-rollback"
  });
  return {
    root,
    workspace,
    databasePath,
    queuePath,
    workingMemoryPath,
    otherDatabasePath,
    otherQueuePath,
    mappingRecovery,
    rollbackRecovery,
    privateCandidate: candidates[30]!
  };
}

function insertDreamRun(database: DatabaseSync, input: {
  id: string;
  localDate: string;
  seed: string;
  input: unknown;
  output: unknown | null;
  dreamText: string | null;
  result: unknown;
}) {
  const inputJson = JSON.stringify(input.input);
  database.prepare(`
    INSERT INTO dream_runs(
      id, local_date, scheduled_for, time_zone, window_start, window_end,
      status, worker_id, lease_until, attempt_count, seed, input_digest,
      input_json, output_json, dream_text, working_memory_id, persona_json,
      persona_status, result_json, error_code, error_text, next_retry_at,
      created_at, updated_at, generated_at, consolidated_at,
      persona_updated_at, completed_at, failed_at
    ) VALUES (
      ?, ?, ?, 'Asia/Shanghai', ?, ?,
      'completed', NULL, NULL, 1, ?, ?,
      ?, ?, ?, NULL, NULL,
      'none', ?, NULL, NULL, NULL,
      ?, ?, ?, ?,
      NULL, ?, NULL
    )
  `).run(
    input.id,
    input.localDate,
    `${input.localDate}T04:00:00.000+08:00`,
    `${input.localDate}T00:00:00.000Z`,
    `${input.localDate}T01:00:00.000Z`,
    input.seed,
    canonicalJsonDigest(input.input),
    inputJson,
    input.output == null ? null : JSON.stringify(input.output),
    input.dreamText,
    JSON.stringify(input.result),
    `${input.localDate}T00:00:00.000Z`,
    `${input.localDate}T00:01:00.000Z`,
    `${input.localDate}T00:00:30.000Z`,
    `${input.localDate}T00:00:45.000Z`,
    `${input.localDate}T00:01:00.000Z`
  );
}

async function createQueue(databasePath: string, agentId: string) {
  const queue = new SessionStore({ databasePath });
  queue.enqueueEvent({
    sessionId: `private:${agentId}:fixture`,
    kind: "incoming",
    dedupeKey: `fixture:${agentId}`,
    payload: { text: "fixture" }
  });
  const claimed = queue.claimNextTurn({
    workerId: `fixture-worker:${agentId}`,
    sessionId: `private:${agentId}:fixture`
  });
  if (!claimed) throw new Error("fixture turn was not claimed");
  queue.finishTurn({
    turnId: claimed.turn.id,
    workerId: `fixture-worker:${agentId}`,
    outcome: "replied",
    result: { ok: true },
    outbox: [{
      kind: "reply",
      payload: { text: "fixture-outbox" },
      dedupeKey: `outbox:${agentId}`
    }]
  });
  queue.close();
}

async function seedQuiescedSidecars(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  let wal: Buffer;
  let shm: Buffer;
  try {
    database.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;");
    [wal, shm] = await Promise.all([
      fs.readFile(`${databasePath}-wal`),
      fs.readFile(`${databasePath}-shm`)
    ]);
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
  await Promise.all([
    fs.writeFile(`${databasePath}-wal`, wal!),
    fs.writeFile(`${databasePath}-shm`, shm!)
  ]);
}

async function currentFileSnapshot(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    database: await fileSetDigest(fixture.databasePath),
    queue: await fileSetDigest(fixture.queuePath),
    workingMemory: sha256(await fs.readFile(fixture.workingMemoryPath))
  };
}

async function logicalSnapshot(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const run = database.prepare(`
      SELECT input_digest, input_json, output_json, dream_text
      FROM dream_runs WHERE id = ?
    `).get(TARGET_RUN_ID) as {
      input_digest: string;
      input_json: string;
      output_json: string;
      dream_text: string;
    };
    const records = TARGET_RECORD_IDS.map((recordId) => JSON.parse(String(
      (database.prepare("SELECT data_json FROM memory_records WHERE record_id = ?")
        .get(recordId) as { data_json: string }).data_json
    )));
    const revisions = Object.fromEntries((database.prepare(`
      SELECT source, revision FROM memory_source_revisions
    `).all() as Array<{ source: string; revision: number }>).map((row) => [row.source, row.revision])) as {
      long_term: number;
      user_profile: number;
      working: number;
    };
    return {
      tableCounts: databaseTableCounts(database),
      revisions,
      runInputDigest: run.input_digest,
      runInput: JSON.parse(run.input_json),
      output: JSON.parse(run.output_json),
      dreamText: run.dream_text,
      records,
      alias24Occurrences: databaseAliasCount(database, /人物-[a-f0-9]{24}(?![a-f0-9])/gu),
      legacy10Occurrences: databaseAliasCount(database, /人物-[a-f0-9]{10}(?![a-f0-9])/gu),
      queue: await fileSetDigest(fixture.queuePath),
      workingMemory: sha256(await fs.readFile(fixture.workingMemoryPath))
    };
  } finally {
    database.close();
  }
}

function databaseTableCounts(database: DatabaseSync) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [
    name,
    Number((database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`)
      .get() as { count: number }).count)
  ]));
}

function databaseAliasCount(database: DatabaseSync, pattern: RegExp) {
  let count = 0;
  for (const row of database.prepare("SELECT data_json FROM memory_records").all() as Array<{
    data_json: string;
  }>) count += [...row.data_json.matchAll(pattern)].length;
  for (const row of database.prepare(`
    SELECT input_json, output_json, dream_text, persona_json, result_json FROM dream_runs
  `).all() as Array<Record<string, string | null>>) {
    for (const value of Object.values(row)) count += [...String(value ?? "").matchAll(pattern)].length;
  }
  return count;
}

async function fileSetDigest(filePath: string) {
  const parts: Array<{ name: string; bytes: number; sha256: string }> = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${filePath}${suffix}`;
    try {
      const bytes = await fs.readFile(candidate);
      parts.push({ name: suffix || "main", bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return parts;
}

function aliasToken(seed: string, value: string) {
  return `人物-${crypto.createHash("sha256")
    .update(seed)
    .update("\0alias\0")
    .update(value.normalize("NFC"))
    .digest("hex")
    .slice(0, 24)}`;
}

function canonicalJsonDigest(value: unknown) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new Error("invalid JSON");
}

function eventFingerprint(record: Record<string, unknown>) {
  const userIds = [...new Set((Array.isArray(record.userIds) ? record.userIds : [])
    .map((value) => String(value).trim())
    .filter(Boolean))].sort();
  const normalizeTimestamp = (value: unknown) => {
    const timestamp = Date.parse(String(value ?? "").trim());
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({
    fact: String(record.fact ?? "").trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, " "),
    userIds,
    occurredAt: normalizeTimestamp(record.occurredAt),
    occurredEndAt: normalizeTimestamp(record.occurredEndAt)
  })).digest("hex")}`;
}

function sha256(value: Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileIdentity(stat: { dev: number; ino: number }) {
  return `${stat.dev}:${stat.ino}`;
}

const stoppedServiceProbe = {
  async isPortOpen() {
    return false;
  },
  async runningHostProcesses() {
    return [];
  },
  async runningContainers() {
    return [];
  }
};
