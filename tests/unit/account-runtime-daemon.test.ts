// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH,
  inspectAccountRuntimeOwner,
  listAccountRuntimeProcesses,
  observeAccountRuntimeProcess,
  quarantineInvalidAccountRuntimeOwner,
  removeStaleAccountRuntimeOwner,
  stopAccountRuntimeProcesses
} from "../../tooling/runtime/account-runtime-daemon.mjs";
import { accountRuntimeConflicts } from "../../tooling/runtime/launcher.mjs";
import { workspaceIdentity } from "../../tooling/runtime/launcher-core.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const productionEntry = path.join(projectRoot, "tooling/runtime/account-runtime-daemon.mjs");
const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (!child.pid || !isAlive(child.pid)) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  await delay(50);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("account runtime daemon singleton", () => {
  it("keeps one concurrent owner, claims each request once, and fails closed after a claimed request crashes", async () => {
    const fixture = await createDaemonFixture();
    const workspace = await createWorkspace("sunabot-account-daemon-concurrent-");
    const tracePath = path.join(fixture.root, "launcher-trace.log");
    const first = startDaemon({ fixture, workspace, token: token("first"), tracePath });
    const second = startDaemon({ fixture, workspace, token: token("second"), tracePath });
    const owner = await waitForOwner(workspace, fixture.entry);
    await waitFor(() => [first, second].filter((child) => child.pid && isAlive(child.pid)).length === 1);

    expect([first.pid, second.pid]).toContain(owner.record.pid);
    await expectOwnerPublishedAtomically(owner.ownerPath, owner.record);
    const requestId = "00000000-0000-4000-8000-000000000001";
    await writeRequest(workspace, requestId, "qq_arona");
    const resultPath = resultFile(workspace, requestId);
    await waitForPath(resultPath);
    await expect(traceLines(tracePath)).resolves.toEqual(["reconcile-account:qq_arona"]);
    await expect(fs.access(path.join(workspace, "runtime/account-reconciler/processing", `${requestId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const crashId = "00000000-0000-4000-8000-000000000002";
    await writeRequest(workspace, crashId, "hang");
    const claimedPath = path.join(workspace, "runtime/account-reconciler/processing", `${crashId}.json`);
    await waitForPath(claimedPath);
    await waitFor(async () => (await traceLines(tracePath)).includes("reconcile-account:hang"));
    process.kill(-owner.record.pid, "SIGKILL");
    await waitFor(() => !isAlive(owner.record.pid));

    startDaemon({ fixture, workspace, token: token("replacement"), tracePath });
    const replacement = await waitForOwner(workspace, fixture.entry, owner.record.pid);
    expect(replacement.record.pid).not.toBe(owner.record.pid);
    const recoveredPath = resultFile(workspace, crashId);
    await waitForPath(recoveredPath);
    const recovered = JSON.parse(await fs.readFile(recoveredPath, "utf8"));
    expect(recovered.state).toMatchObject({
      accountId: "hang",
      observedState: "unknown",
      reconcileRequired: true,
      lastError: expect.stringContaining("避免重复执行")
    });
    await expect(traceLines(tracePath)).resolves.toEqual([
      "reconcile-account:qq_arona",
      "reconcile-account:hang"
    ]);
  }, 20_000);

  it("forwards a forced restart only for the requested account", async () => {
    const fixture = await createDaemonFixture();
    const workspace = await createWorkspace("sunabot-account-daemon-restart-");
    const tracePath = path.join(fixture.root, "launcher-trace.log");
    startDaemon({ fixture, workspace, token: token("restart"), tracePath });
    await waitForOwner(workspace, fixture.entry);
    const requestId = "00000000-0000-4000-8000-000000000003";

    await writeRequest(workspace, requestId, "qq_arona", true);
    await waitForPath(resultFile(workspace, requestId));

    await expect(traceLines(tracePath)).resolves.toEqual(["reconcile-account:qq_arona:force-restart"]);
  }, 20_000);

  it("keeps exactly one owner when two starts race to reclaim the same stale owner", async () => {
    const fixture = await createDaemonFixture({ injectStaleClaimPause: true });
    const workspace = await createWorkspace("sunabot-account-daemon-stale-race-");
    const original = startDaemon({ fixture, workspace, token: token("stale-original") });
    const staleOwner = await waitForOwner(workspace, fixture.entry);
    process.kill(-staleOwner.record.pid, "SIGKILL");
    await waitFor(() => !isAlive(staleOwner.record.pid));

    const slowMarker = path.join(fixture.root, "slow-stale-claim.ready");
    const slow = startDaemon({
      fixture,
      workspace,
      token: token("stale-slow"),
      environment: {
        SUNABOT_TEST_STALE_CLAIM_MARKER: slowMarker,
        SUNABOT_TEST_STALE_CLAIM_DELAY_MS: "300"
      }
    });
    await waitForPath(slowMarker);
    const fast = startDaemon({ fixture, workspace, token: token("stale-fast") });
    const winner = await waitForOwner(workspace, fixture.entry, staleOwner.record.pid);
    await waitForChildExit(slow);

    expect(original.pid).toBe(staleOwner.record.pid);
    expect(winner.record.pid).toBe(fast.pid);
    expect(isAlive(fast.pid!)).toBe(true);
    await expectOwnerPublishedAtomically(winner.ownerPath, winner.record);
    const processes = await listAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: fixture.entry
    });
    expect(processes.map((item) => item.pid)).toEqual([fast.pid]);
  }, 20_000);

  it("preserves a recoverable owner across publish and claim-republish crash windows", async () => {
    const fixture = await createDaemonFixture({
      injectOwnerPublishFaults: true,
      injectClaimRepublishFaults: true,
      injectQuarantineRaceHook: true
    });
    const workspace = await createWorkspace("sunabot-account-daemon-publish-fault-");
    for (const stage of ["sync", "read", "stat", "verify"]) {
      const child = startDaemon({
        fixture,
        workspace,
        token: token(`publish-${stage}`),
        environment: { SUNABOT_TEST_OWNER_PUBLISH_FAULT: stage }
      });
      await waitForChildExit(child);
      const owner = await inspectAccountRuntimeOwner({
        workspace,
        workspaceId: workspaceIdentity(workspace),
        entry: fixture.entry
      });
      expect(owner).toMatchObject({ status: "stale", record: { pid: child.pid } });
      if (owner.status !== "stale") throw new Error(`post-link ${stage} 未保留可恢复 owner。`);
      await expectOwnerPublishedAtomically(owner.ownerPath, owner.record);
      await expect(removeStaleAccountRuntimeOwner({
        workspace,
        workspaceId: workspaceIdentity(workspace),
        entry: fixture.entry
      })).resolves.toBe(true);
    }

    for (const stage of ["before-evidence", "after-evidence", "after-link", "after-dir-sync", "before-old-cleanup"]) {
      const restoreWorkspace = await createWorkspace(`sunabot-account-daemon-restore-${stage}-`);
      const ownerPath = path.join(restoreWorkspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
      await fs.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
      const staleRecord = ownerRecord({
        workspace: restoreWorkspace,
        entry: fixture.entry,
        pid: 2_147_480_000,
        ownerToken: token(`restore-stale-${stage}`)
      });
      const replacementBytes = Buffer.byteLength(`${JSON.stringify(staleRecord, null, 2)}\n`);
      await fs.writeFile(ownerPath, "x".repeat(replacementBytes), { mode: 0o600 });
      const child = await startRestoreFaultDriver({
        fixture,
        workspace: restoreWorkspace,
        record: staleRecord,
        stage
      });
      const exit = await waitForChildExitResult(child);
      expect(exit).toMatchObject({ code: null, signal: "SIGKILL" });

      const crashed = await inspectAccountRuntimeOwner({
        workspace: restoreWorkspace,
        workspaceId: workspaceIdentity(restoreWorkspace),
        entry: fixture.entry
      });
      if (["before-evidence", "after-evidence"].includes(stage)) {
        expect(crashed).toMatchObject({ status: "missing" });
      } else {
        expect(crashed).toMatchObject({ status: "stale", record: { ownerToken: staleRecord.ownerToken } });
        if (crashed.status !== "stale") throw new Error(`${stage} 未保留可恢复 owner。`);
        await expectOwnerPublishedAtomically(crashed.ownerPath, crashed.record);
      }
      await expectNoOwnerLinkCountAboveTwo(path.dirname(ownerPath));

      startDaemon({ fixture, workspace: restoreWorkspace, token: token(`restore-restart-${stage}`) });
      const restarted = await waitForOwner(restoreWorkspace, fixture.entry);
      await expectOwnerPublishedAtomically(restarted.ownerPath, restarted.record);
      await expectNoOwnerLinkCountAboveTwo(path.dirname(ownerPath));
      await stopWorkspaceDaemons(restoreWorkspace, fixture.entry);
    }
  }, 30_000);

  it("reports state loss and split-brain, then stops every proven workspace daemon without killing another process", async () => {
    const workspace = await createWorkspace("sunabot-account-daemon-down-");
    startDaemon({ workspace, token: token("owner-a") });
    const firstOwner = await waitForOwner(workspace, productionEntry);
    const oneProcess = await listAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry
    });
    expect(accountRuntimeConflicts({
      healthy: false,
      processes: oneProcess,
      owner: firstOwner,
      stateAlive: false,
      stateMatches: false
    }, { statePath: path.join(workspace, "runtime/launcher-state.json") }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "ACCOUNT_RECONCILER_UNREGISTERED" })]));
    await stopAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry,
      processes: oneProcess,
      timeoutMs: 1_000
    });
    await waitFor(() => !isAlive(firstOwner.record.pid));
    const stoppedOwner = await inspectAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry
    });
    if (stoppedOwner.status === "stale") {
      await removeStaleAccountRuntimeOwner({
        workspace,
        workspaceId: workspaceIdentity(workspace),
        entry: productionEntry
      });
    }

    const legacyEntry = path.join(await createWorkspace("sunabot-account-daemon-legacy-entry-"), "account-runtime-daemon.mjs");
    await fs.writeFile(legacyEntry, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
    const legacyFirst = startLegacyDaemon(workspace, legacyEntry);
    const legacySecond = startLegacyDaemon(workspace, legacyEntry);
    await waitFor(() => Boolean(
      legacyFirst.pid && legacySecond.pid && isAlive(legacyFirst.pid) && isAlive(legacySecond.pid)
    ));
    const duplicates = await listAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: legacyEntry
    });
    expect(duplicates.map((item) => item.pid).sort((a, b) => a - b))
      .toEqual([legacyFirst.pid!, legacySecond.pid!].sort((a, b) => a - b));
    expect(duplicates.every((item) => item.legacy && item.safeToSignal)).toBe(true);
    expect(accountRuntimeConflicts({
      healthy: false,
      processes: duplicates,
      owner: { status: "missing" },
      stateAlive: true,
      stateMatches: true
    })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ACCOUNT_RECONCILER_SPLIT_BRAIN" })]));

    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    childProcesses.push(unrelated);
    await waitFor(() => Boolean(unrelated.pid && isAlive(unrelated.pid)));
    await stopAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: legacyEntry,
      processes: duplicates,
      timeoutMs: 250
    });

    await waitFor(() => duplicates.every((item) => !isAlive(item.pid)));
    expect(isAlive(unrelated.pid!)).toBe(true);

    const safeLegacy = startLegacyDaemon(workspace, legacyEntry);
    const safeProcesses = await waitFor(async () => {
      const listed = await listAccountRuntimeProcesses({
        workspace,
        workspaceId: workspaceIdentity(workspace),
        entry: legacyEntry
      });
      return listed.length === 1 ? listed : null;
    });
    await expect(stopAccountRuntimeProcesses({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: legacyEntry,
      processes: [{ ...safeProcesses[0], pid: unrelated.pid, safeToSignal: false }, ...safeProcesses],
      timeoutMs: 250
    })).rejects.toMatchObject({ code: "ACCOUNT_RUNTIME_PROCESS_IDENTITY_INVALID" });
    await waitFor(() => !isAlive(safeLegacy.pid!));
    expect(isAlive(unrelated.pid!)).toBe(true);
  }, 20_000);

  it("ignores pre-publish evidence, quarantines corrupt owners, and never signals a PID-reused process", async () => {
    const workspace = await createWorkspace("sunabot-account-daemon-invalid-");
    const ownerPath = path.join(workspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
    const ownerDirectory = path.dirname(ownerPath);
    await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
    const orphanEvidencePath = path.join(
      ownerDirectory,
      `.owner.999999.${token("pre-publish")}.evidence`
    );
    await fs.writeFile(orphanEvidencePath, "{partial", { mode: 0o600 });
    startDaemon({ workspace, token: token("after-pre-publish") });
    const published = await waitForOwner(workspace, productionEntry);
    await expectOwnerPublishedAtomically(published.ownerPath, published.record);
    await stopWorkspaceDaemons(workspace, productionEntry);
    await waitFor(async () => (await inspectAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry
    })).status === "missing");
    await expect(fs.readFile(orphanEvidencePath, "utf8")).resolves.toBe("{partial");

    await fs.writeFile(ownerPath, "{partial", { mode: 0o600 });
    const corruptAttempt = startDaemon({ workspace, token: token("corrupt") });
    await waitForChildExit(corruptAttempt);
    await expect(fs.readFile(ownerPath, "utf8")).resolves.toBe("{partial");
    const corruptQuarantine = await quarantineInvalidAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry
    });
    expect(corruptQuarantine).toBeTruthy();
    await expect(fs.readFile(corruptQuarantine!, "utf8")).resolves.toBe("{partial");
    await expect(fs.access(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });

    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    childProcesses.push(unrelated);
    const observed = await waitFor(async () => unrelated.pid
      ? await observeAccountRuntimeProcess(unrelated.pid, { workspace })
      : null);
    const ownerToken = token("reused-pid");
    await fs.writeFile(ownerPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "account-runtime-daemon-owner",
      workspace,
      workspaceId: workspaceIdentity(workspace),
      pid: unrelated.pid,
      processGroup: unrelated.pid,
      signature: observed.signature,
      entry: productionEntry,
      ownerToken,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
    const reusedEvidencePath = path.join(
      ownerDirectory,
      `.owner.${unrelated.pid}.${ownerToken}.evidence`
    );
    await fs.rename(ownerPath, reusedEvidencePath);
    await fs.link(reusedEvidencePath, ownerPath);

    const reusedAttempt = startDaemon({ workspace, token: token("replacement-attempt") });
    await waitForChildExit(reusedAttempt);
    expect(isAlive(unrelated.pid!)).toBe(true);
    const inspected = await inspectAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: productionEntry
    });
    expect(inspected).toMatchObject({ status: "invalid", record: { pid: unrelated.pid } });
    const docker = await createDockerFixture(workspaceIdentity(workspace));
    const down = await runLauncherDown(workspace, docker);
    expect(down, JSON.stringify(down)).toMatchObject({ code: 0, signal: null });
    expect(down.stderr).toBe("");
    expect(down.stdout).toContain("Sunabot Core 与 NapCat 已停止。");
    await expect(fs.access(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(isAlive(unrelated.pid!)).toBe(true);

    const dockerCalls = (await fs.readFile(docker.tracePath, "utf8")).trim().split("\n");
    expect(dockerCalls).toContain("stop --timeout 30 napcat-fixture core-fixture");
    expect(dockerCalls).toContain("rm napcat-fixture core-fixture");

    const quarantines = (await fs.readdir(ownerDirectory))
      .filter((name) => name.endsWith(".quarantine"));
    expect(quarantines).toHaveLength(2);
    const reusedQuarantine = quarantines.find((name) => path.join(ownerDirectory, name) !== corruptQuarantine);
    expect(reusedQuarantine).toBeTruthy();
    await expect(fs.readFile(path.join(ownerDirectory, reusedQuarantine!), "utf8"))
      .resolves.toContain(`"pid": ${unrelated.pid}`);
  }, 15_000);

  it("republishes a valid replacement and an old record after claim-time evidence failure", async () => {
    const fixture = await createDaemonFixture({
      injectEvidenceFailureHook: true,
      injectQuarantineRaceHook: true
    });
    const fixtureModule = await import(`${pathToFileURL(fixture.entry).href}?quarantine-race=${Date.now()}`);
    const workspace = await createWorkspace("sunabot-account-daemon-quarantine-race-");
    const ownerPath = path.join(workspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
    await fs.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(ownerPath, "{partial", { mode: 0o600 });
    const invalid = await fixtureModule.inspectAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry: fixture.entry
    });
    expect(invalid).toMatchObject({ status: "invalid", identity: { dev: expect.any(Number), ino: expect.any(Number) } });

    let replacement: ChildProcess | undefined;
    let replacementBeforeClaim: Awaited<ReturnType<typeof waitForOwner>> | undefined;
    const hookName = "__SUNABOT_TEST_BEFORE_QUARANTINE_CLAIM__";
    (globalThis as Record<string, unknown>)[hookName] = async () => {
      await fs.unlink(ownerPath);
      replacement = startDaemon({ fixture, workspace, token: token("quarantine-replacement") });
      replacementBeforeClaim = await waitForOwner(workspace, fixture.entry);
    };
    try {
      await expect(fixtureModule.quarantineInvalidAccountRuntimeOwner({
        workspace,
        workspaceId: workspaceIdentity(workspace),
        entry: fixture.entry
      })).rejects.toMatchObject({ code: "ACCOUNT_RUNTIME_OWNER_CHANGED" });
    } finally {
      delete (globalThis as Record<string, unknown>)[hookName];
    }

    const restored = await waitForOwner(workspace, fixture.entry);
    expect(restored.record.pid).toBe(replacement?.pid);
    expect(isAlive(replacement!.pid!)).toBe(true);
    expect(restored.identity).not.toMatchObject(replacementBeforeClaim!.identity);
    await expectOwnerPublishedAtomically(restored.ownerPath, restored.record);
    const quarantines = (await fs.readdir(path.dirname(ownerPath)))
      .filter((name) => name.endsWith(".quarantine"));
    expect(quarantines).toEqual([]);

    const evidenceWorkspace = await createWorkspace("sunabot-account-daemon-evidence-race-");
    const evidenceOwnerPath = path.join(evidenceWorkspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
    await fs.mkdir(path.dirname(evidenceOwnerPath), { recursive: true, mode: 0o700 });
    const staleRecord = ownerRecord({
      workspace: evidenceWorkspace,
      entry: fixture.entry,
      pid: 2_147_480_001,
      ownerToken: token("evidence-failure-stale")
    });
    const stalePublished = await writeLinkedOwnerRecord(evidenceOwnerPath, staleRecord);
    const evidenceHookName = "__SUNABOT_TEST_AFTER_OWNER_CLAIM__";
    (globalThis as Record<string, unknown>)[evidenceHookName] = async () => {
      await fs.unlink(stalePublished.evidencePath);
    };
    try {
      await expect(fixtureModule.removeStaleAccountRuntimeOwner({
        workspace: evidenceWorkspace,
        workspaceId: workspaceIdentity(evidenceWorkspace),
        entry: fixture.entry
      })).rejects.toMatchObject({ code: "ACCOUNT_RUNTIME_OWNER_INVALID" });
    } finally {
      delete (globalThis as Record<string, unknown>)[evidenceHookName];
    }
    const republished = await inspectAccountRuntimeOwner({
      workspace: evidenceWorkspace,
      workspaceId: workspaceIdentity(evidenceWorkspace),
      entry: fixture.entry
    });
    expect(republished).toMatchObject({ status: "stale", record: { ownerToken: staleRecord.ownerToken } });
    if (republished.status !== "stale") throw new Error("evidence failure 后未恢复 stale owner。");
    expect(republished.identity).not.toMatchObject(stalePublished.identity);
    await expectOwnerPublishedAtomically(republished.ownerPath, republished.record);
    await expect(fixtureModule.removeStaleAccountRuntimeOwner({
      workspace: evidenceWorkspace,
      workspaceId: workspaceIdentity(evidenceWorkspace),
      entry: fixture.entry
    })).resolves.toBe(true);
  }, 20_000);
});

async function createDaemonFixture(options: {
  injectOwnerPublishFaults?: boolean;
  injectClaimRepublishFaults?: boolean;
  injectEvidenceFailureHook?: boolean;
  injectQuarantineRaceHook?: boolean;
  injectStaleClaimPause?: boolean;
} = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-account-daemon-fixture-"));
  temporaryDirectories.push(temporaryRoot);
  const root = await fs.realpath(temporaryRoot);
  const copies = [
    "tooling/runtime/account-runtime-daemon.mjs",
    "tooling/runtime/launcher-core.mjs",
    "tooling/shared/paths.mjs",
    "tooling/shared/safe-absolute-path.mjs",
    "packages/platform/multiAgentMigrationGate.mjs"
  ];
  for (const relative of copies) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    if (relative !== "tooling/runtime/account-runtime-daemon.mjs") {
      await fs.copyFile(path.join(projectRoot, relative), path.join(root, relative));
      continue;
    }
    let source = (await fs.readFile(path.join(projectRoot, relative), "utf8")).replace(/\r\n/gu, "\n");
    if (options.injectOwnerPublishFaults) {
      source = replaceExactlyOnce(source,
        "      published = true;\n      await syncDirectory(ownerDirectory);\n      const snapshot = await readOwnerSnapshot(ownerPath);",
        [
          "      published = true;",
          "      if (process.env.SUNABOT_TEST_OWNER_PUBLISH_FAULT === 'sync') throw new Error('injected sync fault');",
          "      await syncDirectory(ownerDirectory);",
          "      if (process.env.SUNABOT_TEST_OWNER_PUBLISH_FAULT === 'read') throw new Error('injected read fault');",
          "      const snapshot = await readOwnerSnapshot(ownerPath);",
          "      if (process.env.SUNABOT_TEST_OWNER_PUBLISH_FAULT === 'stat') throw new Error('injected stat fault');"
        ].join("\n"),
        "owner publish sync/read/stat faults"
      );
      source = replaceExactlyOnce(source,
        "      await assertOwnerEvidence(ownerPath, snapshot.identity, publishedRecord);",
        [
          "      if (process.env.SUNABOT_TEST_OWNER_PUBLISH_FAULT === 'verify') throw new Error('injected verify fault');",
          "      await assertOwnerEvidence(ownerPath, snapshot.identity, publishedRecord);"
        ].join("\n"),
        "owner publish verify fault"
      );
    }
    if (options.injectQuarantineRaceHook) {
      source = replaceExactlyOnce(source,
        "  if (!inspected.identity) {",
        "  await globalThis.__SUNABOT_TEST_BEFORE_QUARANTINE_CLAIM__?.();\n  if (!inspected.identity) {",
        "quarantine claim race hook"
      );
    }
    if (options.injectClaimRepublishFaults) {
      source = replaceExactlyOnce(source,
        "  const evidencePath = recoveryOwnerEvidencePath(options.ownerPath, record);",
        "  if (process.env.SUNABOT_TEST_RESTORE_FAULT === 'before-evidence') process.kill(process.pid, 'SIGKILL');\n  const evidencePath = recoveryOwnerEvidencePath(options.ownerPath, record);",
        "claim republish before-evidence fault"
      );
      source = replaceExactlyOnce(source,
        "    await handle.close();\n    handle = undefined;\n  } catch (error) {",
        "    await handle.close();\n    handle = undefined;\n    if (process.env.SUNABOT_TEST_RESTORE_FAULT === 'after-evidence') process.kill(process.pid, 'SIGKILL');\n  } catch (error) {",
        "claim republish after-evidence fault"
      );
      source = replaceExactlyOnce(source,
        "    await fs.link(evidencePath, options.ownerPath);\n  } catch (error) {",
        "    await fs.link(evidencePath, options.ownerPath);\n    if (process.env.SUNABOT_TEST_RESTORE_FAULT === 'after-link') process.kill(process.pid, 'SIGKILL');\n  } catch (error) {",
        "claim republish after-link fault"
      );
      source = replaceExactlyOnce(source,
        "  await syncDirectory(ownerDirectory);\n  const published = await readOwnerSnapshot(options.ownerPath);",
        "  await syncDirectory(ownerDirectory);\n  if (process.env.SUNABOT_TEST_RESTORE_FAULT === 'after-dir-sync') process.kill(process.pid, 'SIGKILL');\n  const published = await readOwnerSnapshot(options.ownerPath);",
        "claim republish after-dir-sync fault"
      );
      source = replaceExactlyOnce(source,
        "  await cleanupClaimedOwnerArtifacts({",
        "  if (process.env.SUNABOT_TEST_RESTORE_FAULT === 'before-old-cleanup') process.kill(process.pid, 'SIGKILL');\n  await cleanupClaimedOwnerArtifacts({",
        "claim republish before-old-cleanup fault"
      );
    }
    if (options.injectEvidenceFailureHook) {
      source = replaceExactlyOnce(source,
        "  let evidencePath;\n  try {",
        "  await globalThis.__SUNABOT_TEST_AFTER_OWNER_CLAIM__?.();\n  let evidencePath;\n  try {",
        "owner claim evidence failure hook"
      );
    }
    if (options.injectStaleClaimPause) {
      source = replaceExactlyOnce(source,
        "async function removeOwnerSnapshot(ownerPath, expectedIdentity, record) {\n  const ownerDirectory = path.dirname(ownerPath);",
        [
          "async function removeOwnerSnapshot(ownerPath, expectedIdentity, record) {",
          "  if (process.env.SUNABOT_TEST_STALE_CLAIM_MARKER) {",
          "    await fs.writeFile(process.env.SUNABOT_TEST_STALE_CLAIM_MARKER, 'ready', { flag: 'wx' });",
          "    await delay(Number(process.env.SUNABOT_TEST_STALE_CLAIM_DELAY_MS) || 250);",
          "  }",
          "  const ownerDirectory = path.dirname(ownerPath);"
        ].join("\n"),
        "stale owner claim pause"
      );
    }
    if (options.injectClaimRepublishFaults && !source.includes("SUNABOT_TEST_RESTORE_FAULT")) {
      throw new Error("claim republish fault injection 未生效。");
    }
    if (options.injectEvidenceFailureHook && !source.includes("__SUNABOT_TEST_AFTER_OWNER_CLAIM__")) {
      throw new Error("evidence failure hook injection 未生效。");
    }
    await fs.writeFile(path.join(root, relative), source, { mode: 0o700 });
  }
  await fs.writeFile(path.join(root, "package.json"), "{\"type\":\"module\"}\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "fixture\n");
  await fs.writeFile(path.join(root, "tooling/runtime/launcher.mjs"), [
    "import fs from 'node:fs/promises';",
    "const command = process.argv[2];",
    "const account = process.argv.find((value) => value.startsWith('--account='))?.slice(10) ?? '';",
    "const restart = process.argv.includes('--force-restart') ? ':force-restart' : '';",
    "await fs.appendFile(process.env.TRACE_FILE, `${command}:${account}${restart}\\n`);",
    "if (account === 'hang') await new Promise(() => setInterval(() => {}, 1000));",
    "console.log(`SUNABOT_ACCOUNT_RECONCILE=${JSON.stringify({schemaVersion:1,accountId:account,desiredState:'running',observedState:'running',reconcileRequired:false,lastError:null,updatedAt:new Date().toISOString()})}`);"
  ].join("\n"));
  return { root, entry: path.join(root, "tooling/runtime/account-runtime-daemon.mjs") };
}

function replaceExactlyOnce(source: string, search: string, replacement: string, label: string) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label} 注入锚点必须且只能出现一次。`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

async function createWorkspace(prefix: string) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(workspace);
  return workspace;
}

async function createDockerFixture(identity: string) {
  const directory = await createWorkspace("sunabot-account-daemon-docker-");
  const bin = path.join(directory, "bin");
  const tracePath = path.join(directory, "docker-trace.log");
  const statePath = path.join(directory, "docker-state.log");
  const project = "sunabot-" + identity.slice(0, 12);
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(statePath, [
    "napcat-fixture\tnapcat\trunning\t" + project + "-napcat-qq-arona\tqq_arona\tfalse",
    "core-fixture\tcore\trunning\t" + project + "\t\tfalse",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(bin, "docker"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$DOCKER_TRACE_FILE\"",
    "if [ \"${1:-}\" = \"info\" ]; then",
    "  printf '%s\\n' 'fixture-docker'",
    "  exit 0",
    "fi",
    "if [ \"${1:-}\" = \"container\" ] && [ \"${2:-}\" = \"inspect\" ]; then",
    "  exit 1",
    "fi",
    "case \" $* \" in",
    "  *\"label=com.docker.compose.oneoff=true\"*) exit 0 ;;",
    "  *\"label=io.sunabot.component=workspace-bash\"*) exit 0 ;;",
    "esac",
    "if [ \"${1:-}\" = \"stop\" ]; then",
    "  sed 's/\\trunning\\t/\\texited\\t/' \"$DOCKER_STATE_FILE\" > \"$DOCKER_STATE_FILE.next\"",
    "  mv \"$DOCKER_STATE_FILE.next\" \"$DOCKER_STATE_FILE\"",
    "  exit 0",
    "fi",
    "if [ \"${1:-}\" = \"rm\" ]; then",
    "  : > \"$DOCKER_STATE_FILE\"",
    "  exit 0",
    "fi",
    "if [ \"${1:-}\" = \"network\" ] && [ \"${2:-}\" = \"inspect\" ]; then",
    "  exit 1",
    "fi",
    "if [ \"${1:-}\" = \"ps\" ]; then",
    "  case \" $* \" in",
    "    *\"--filter label=io.sunabot.workspace-id=\"*)",
    "      cat \"$DOCKER_STATE_FILE\"",
    "      ;;",
    "  esac",
    "fi",
    "exit 0",
    ""
  ].join("\n"), { mode: 0o700 });
  return {
    bin,
    tracePath,
    statePath,
    project
  };
}

async function runLauncherDown(
  workspace: string,
  docker: { bin: string; tracePath: string; statePath: string; project: string }
) {
  const child = spawn(process.execPath, [
    path.join(projectRoot, "tooling/runtime/launcher.mjs"),
    "down",
    "--core=docker"
  ], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SUNABOT_WORKSPACE: workspace,
      PATH: `${docker.bin}:${process.env.PATH ?? ""}`,
      NODE_NO_WARNINGS: "1",
      DOCKER_TRACE_FILE: docker.tracePath,
      DOCKER_STATE_FILE: docker.statePath,
      DOCKER_PROJECT: docker.project
    }
  });
  childProcesses.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

async function startRestoreFaultDriver(options: {
  fixture: { root: string; entry: string };
  workspace: string;
  record: ReturnType<typeof ownerRecord>;
  stage: string;
}) {
  const driverPath = path.join(options.fixture.root, `restore-fault-${options.stage}.mjs`);
  await fs.writeFile(driverPath, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    `const daemon = await import(${JSON.stringify(pathToFileURL(options.fixture.entry).href)});`,
    "const ownerPath = process.env.SUNABOT_TEST_OWNER_PATH;",
    "const record = JSON.parse(process.env.SUNABOT_TEST_RESTORE_RECORD);",
    "globalThis.__SUNABOT_TEST_BEFORE_QUARANTINE_CLAIM__ = async () => {",
    "  await fs.unlink(ownerPath);",
    "  const evidencePath = path.join(path.dirname(ownerPath), `.owner.${record.pid}.${record.ownerToken}.evidence`);",
    "  await fs.writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\\n`, { mode: 0o600, flag: 'wx' });",
    "  await fs.link(evidencePath, ownerPath);",
    "};",
    "await daemon.quarantineInvalidAccountRuntimeOwner({",
    "  workspace: process.env.SUNABOT_WORKSPACE,",
    "  workspaceId: process.env.SUNABOT_TEST_WORKSPACE_ID,",
    `  entry: ${JSON.stringify(options.fixture.entry)}`,
    "});"
  ].join("\n"), { mode: 0o700 });
  const ownerPath = path.join(options.workspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
  const child = spawn(process.execPath, [driverPath], {
    cwd: options.fixture.root,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SUNABOT_WORKSPACE: options.workspace,
      SUNABOT_TEST_OWNER_PATH: ownerPath,
      SUNABOT_TEST_RESTORE_RECORD: JSON.stringify(options.record),
      SUNABOT_TEST_RESTORE_FAULT: options.stage,
      SUNABOT_TEST_WORKSPACE_ID: workspaceIdentity(options.workspace)
    }
  });
  child.stderr?.resume();
  childProcesses.push(child);
  return child;
}

function startDaemon(options: {
  workspace: string;
  token: string;
  fixture?: { root: string; entry: string };
  tracePath?: string;
  environment?: Record<string, string>;
}) {
  const entry = options.fixture?.entry ?? productionEntry;
  const child = spawn(process.execPath, [
    entry,
    `--workspace-id=${workspaceIdentity(options.workspace)}`,
    `--owner-token=${options.token}`
  ], {
    cwd: options.fixture?.root ?? projectRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SUNABOT_WORKSPACE: options.workspace,
      ...(options.tracePath ? { TRACE_FILE: options.tracePath } : {}),
      ...options.environment
    }
  });
  child.stderr?.resume();
  childProcesses.push(child);
  return child;
}

function startLegacyDaemon(workspace: string, entry: string) {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SUNABOT_WORKSPACE: workspace }
  });
  childProcesses.push(child);
  return child;
}

async function waitForOwner(workspace: string, entry: string, excludedPid?: number) {
  return waitFor(async () => {
    const owner = await inspectAccountRuntimeOwner({
      workspace,
      workspaceId: workspaceIdentity(workspace),
      entry
    });
    return owner.status === "running" && owner.record.pid !== excludedPid ? owner : null;
  });
}

async function writeRequest(workspace: string, requestId: string, accountId: string, forceRestart = false) {
  const directory = path.join(workspace, "runtime/account-reconciler/requests");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `${requestId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    kind: "account-reconcile",
    requestId,
    accountId,
    desiredState: "running",
    ...(forceRestart ? { forceRestart: true } : {})
  })}\n`, { mode: 0o600 });
}

function resultFile(workspace: string, requestId: string) {
  return path.join(workspace, "runtime/account-reconciler/results", `${requestId}.json`);
}

async function waitForPath(filePath: string) {
  await waitFor(async () => fs.access(filePath).then(() => true, () => false));
}

async function traceLines(tracePath: string) {
  return fs.readFile(tracePath, "utf8")
    .then((content) => content.trim().split("\n").filter(Boolean), (error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
}

function ownerRecord(options: {
  workspace: string;
  entry: string;
  pid: number;
  ownerToken: string;
}) {
  return {
    schemaVersion: 1,
    kind: "account-runtime-daemon-owner",
    workspace: options.workspace,
    workspaceId: workspaceIdentity(options.workspace),
    pid: options.pid,
    processGroup: options.pid,
    signature: "Thu Jul 18 17:00:00 2026",
    entry: options.entry,
    ownerToken: options.ownerToken,
    startedAt: new Date().toISOString()
  };
}

async function writeLinkedOwnerRecord(ownerPath: string, record: ReturnType<typeof ownerRecord>) {
  const evidencePath = path.join(
    path.dirname(ownerPath),
    `.owner.${record.pid}.${record.ownerToken}.evidence`
  );
  await fs.writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.link(evidencePath, ownerPath);
  const stat = await fs.lstat(ownerPath);
  return {
    evidencePath,
    identity: { dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size) }
  };
}

async function expectOwnerPublishedAtomically(ownerPath: string, record: { pid: number; ownerToken: string }) {
  const owner = await fs.lstat(ownerPath);
  const prefix = `.owner.${record.pid}.${record.ownerToken}`;
  const names = (await fs.readdir(path.dirname(ownerPath))).filter((name) => (
    name === `${prefix}.evidence`
    || (name.startsWith(`${prefix}.recovery.`)
      && /^[a-f0-9]{64}\.evidence$/u.test(name.slice(`${prefix}.recovery.`.length)))
  ));
  const evidenceCandidates = await Promise.all(names.map(async (name) => ({
    name,
    stat: await fs.lstat(path.join(path.dirname(ownerPath), name))
  })));
  const matches = evidenceCandidates.filter(({ stat }) => (
    Number(owner.dev) === Number(stat.dev) && Number(owner.ino) === Number(stat.ino)
  ));
  expect(matches).toHaveLength(1);
  const evidence = matches[0].stat;
  expect(owner.isFile()).toBe(true);
  expect(evidence.isFile()).toBe(true);
  expect(Number(owner.dev)).toBe(Number(evidence.dev));
  expect(Number(owner.ino)).toBe(Number(evidence.ino));
  expect(owner.nlink).toBe(2);
  expect(evidence.nlink).toBe(2);
}

async function expectNoOwnerLinkCountAboveTwo(ownerDirectory: string) {
  const names = await fs.readdir(ownerDirectory);
  const stats = await Promise.all(names.map((name) => fs.lstat(path.join(ownerDirectory, name))));
  expect(stats.filter((stat) => stat.isFile()).every((stat) => stat.nlink <= 2)).toBe(true);
}

async function stopWorkspaceDaemons(workspace: string, entry: string) {
  const processes = await listAccountRuntimeProcesses({
    workspace,
    workspaceId: workspaceIdentity(workspace),
    entry
  });
  await stopAccountRuntimeProcesses({
    workspace,
    workspaceId: workspaceIdentity(workspace),
    entry,
    processes,
    timeoutMs: 1_000
  });
}

function token(seed: string) {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

async function waitForChildExit(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function waitForChildExitResult(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode != null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => T | Promise<T>, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(25);
  }
  throw new Error("等待 account runtime daemon 测试条件超时。");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
