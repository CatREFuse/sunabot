// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortMigration,
  applyMigration,
  assertRowsEqualReplacements,
  databaseLogicalSha256,
  dryRunPlans,
  exportBaseline,
  generateProposals,
  installStagedMigration,
  prepareMigration,
  refreshPlans,
  signProposalDirectory,
  stageRollback,
  validateMemoryFact,
  validateReplacements,
  verifyMigration
} from "../../tooling/migrations/memory-perspective-v1.mjs";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  createRecoveryPoint,
  restoreRecoveryPoint,
  verifyRecoveryPoint
} from "../../tooling/workspace/sqlite-recovery.mjs";

const AGENTS = ["plana", "arona", "koharu", "laobfeng"];
const temporaryDirectories: string[] = [];
const offline = {
  quiesced: true,
  portProbe: async () => false,
  handleProbe: async () => false
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("memory-perspective-v1 tracked migration", () => {
  it("exports only signed memory rows with relative paths, then refreshes after row-id and position drift", async () => {
    const fixture = await createFixture();
    const exported = exportBaseline({ workspace: fixture.workspace, output: "business/migrations/export.json" });
    expect(exported.agents).toHaveLength(4);
    const snapshot = await readJson(path.join(fixture.workspace, "business/migrations/export.json"));
    expect(JSON.stringify(snapshot)).not.toContain(fixture.root);
    expect(snapshot.agents.every((agent: Record<string, unknown>) => !path.isAbsolute(String(agent.database)))).toBe(true);
    expect(snapshot.agents[0].rows[0]).toEqual(expect.objectContaining({
      rowId: expect.any(Number),
      source: expect.any(String),
      effectiveData: expect.any(Object),
      stableKey: expect.stringContaining("sha256:")
    }));
    expect(JSON.stringify(snapshot)).not.toContain("conversation-private");
    expect(JSON.stringify(snapshot)).not.toContain("queue-secret");

    generateProposals({
      exportFile: path.join(fixture.workspace, "business/migrations/export.json"),
      proposalDir: path.join(fixture.workspace, "business/migrations/proposals")
    });
    await resolveAllProposals(fixture.workspace);
    driftEveryRowIdAndPosition(fixture.applicationPaths);
    const refreshed = refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    expect(refreshed.plans).toHaveLength(4);
    const dryRun = dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.agents.every((agent: { before: Record<string, number> }) => (
      agent.before.working === 1 && agent.before.long_term === 1 && agent.before.user_profile === 1
    ))).toBe(true);
  });

  it.each([
    ["root unknown field", (document: any) => { document.remoteFlag = true; }],
    ["Agent unknown field", (document: any) => { document.agents[0].remoteFlag = true; }],
    ["row unknown field", (document: any) => { document.agents[0].rows[0].remoteFlag = true; }],
    ["absolute nested artifact path", (document: any) => {
      document.agents[0].rows[0].effectiveData.remotePath = "/tmp/export-artifact";
    }]
  ] as const)("rejects a re-signed export with %s", async (_label, mutate) => {
    const fixture = await createFixture();
    exportBaseline({ workspace: fixture.workspace, output: "business/migrations/export.json" });
    const exportPath = path.join(fixture.workspace, "business/migrations/export.json");
    const document = await readJson(exportPath);
    mutate(document);
    await fs.writeFile(
      exportPath,
      `${JSON.stringify(resignTestDocument(document, "exportSha256"), null, 2)}\n`
    );
    expect(() => generateProposals({
      exportFile: exportPath,
      proposalDir: path.join(fixture.workspace, "business/migrations/rejected-proposals")
    })).toThrow(/export|未知字段|绝对路径|artifact|path/i);
  });

  it("fails closed on added, deleted, duplicate, ambiguous, missing, and tampered inputs without SQLite writes", async () => {
    const fixture = await createFixture();
    await exportGenerateResolve(fixture);
    const before = snapshotMemoryRows(fixture.applicationPaths);

    insertMemory(fixture.applicationPaths[0], "working", "extra", "额外事实", ["12345678"]);
    expect(() => refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans-added"
    })).toThrow(/重新 export\/generate|集合已变化/);
    removeMemoryById(fixture.applicationPaths[0], "extra");

    const proposalPath = path.join(fixture.workspace, "business/migrations/proposals/arona.proposal.json");
    const proposal = await readJson(proposalPath);
    proposal.targets.working[0].targetFact += "篡改";
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() => refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans-tampered"
    })).toThrow(/proposalSha256|签名|signature/i);

    signProposalDirectory({ proposalDir: path.dirname(proposalPath) });
    await fs.rm(path.join(fixture.workspace, "business/migrations/proposals/koharu.proposal.json"));
    expect(() => refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans-missing"
    })).toThrow(/集合不完整/);

    expect(snapshotMemoryRows(fixture.applicationPaths.slice(1))).toEqual(before.slice(1));
  });

  it("rejects wrapper-only promotion and cross-user profile evidence", async () => {
    const wrapperFixture = await createFixture({ wrapperWorking: true });
    await exportGenerateResolve(wrapperFixture);
    expect(() => refreshPlans({
      workspace: wrapperFixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    })).toThrow(/wrapper/);

    const profileFixture = await createFixture({ secondProfileUser: "87654321" });
    await exportGenerateResolve(profileFixture, { mergeProfiles: true });
    expect(() => refreshPlans({
      workspace: profileFixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    })).toThrow(/跨 userId|画像/);
  });

  it("enforces one profile per user plus strict QQ presence and natural mention", () => {
    const fact = "我记得 QQ 12345678 与 QQ 87654321 都在意这件事，我觉得需要谨慎回应，我也愿意让他们安心。";
    expect(() => validateMemoryFact("plana", "working", { id: "ok", fact, userIds: ["12345678", "87654321"] })).not.toThrow();
    for (const invalid of [undefined, [], [""], ["abc"]]) {
      expect(() => validateMemoryFact("plana", "working", {
        id: "bad",
        fact: "我记得这件事，我觉得重要，我也很在意。",
        userIds: invalid
      })).toThrow(/QQ|userId/);
    }
    expect(() => validateMemoryFact("plana", "long_term", {
      id: "bad-missing-one",
      fact: "我记得 QQ 12345678 的想法，我觉得重要，我也很在意。",
      userIds: ["12345678", "87654321"]
    })).toThrow(/87654321/);
    expect(() => validateMemoryFact("plana", "long_term", {
      id: "bad-substring",
      fact: "我记得 QQ 912345678 的想法，我觉得重要，我也很在意。",
      userIds: ["12345678"]
    })).toThrow(/12345678/);
    expect(() => validateMemoryFact("plana", "long_term", {
      id: "bad-prefix",
      fact: "我记得 QQ 123456789 的想法，我觉得重要，我也很在意。",
      userIds: ["12345678"]
    })).toThrow(/12345678/);
    expect(() => validateMemoryFact("plana", "working", {
      id: "parenthesized-qq",
      fact: "我记得（12345678）的请求，我觉得需要认真回应，我也很在意。",
      userIds: ["12345678"]
    })).not.toThrow();
    expect(() => validateMemoryFact("plana", "working", {
      id: "task-number-is-not-qq",
      fact: "我记得任务号 12345678 需要处理，我觉得它很重要，我也很在意。",
      userIds: ["12345678"]
    })).toThrow(/QQ 12345678/);
    expect(() => validateMemoryFact("plana", "user_profile", {
      id: "quoted-emotion",
      userId: "12345678",
      fact: "我记得他说他觉得开心，我认为这是一条稳定信息。"
    })).toThrow(/情绪|态度/);
    expect(() => validateMemoryFact("plana", "user_profile", {
      id: "quoted-cognition",
      userId: "12345678",
      fact: "我很开心，因为他说他觉得这件事很重要。"
    })).toThrow(/认知|感知/);
    expect(() => validateReplacements("plana", {
      working: [],
      long_term: [],
      user_profile: [
        { id: "p1", userId: "12345678", fact: "我注意到他的偏好，我觉得很清楚，我也愿意尊重。" },
        { id: "p2", userId: "12345678", fact: "我记得他的习惯，我认为很稳定，我也很在意。" }
      ]
    })).toThrow(/只能保留 1 条/);
  });

  it("compares record_id, position, wrapper, and full metadata exactly", () => {
    const replacement = {
      working: [{ id: "w", fact: "我记得 QQ 12345678 的请求，我觉得重要，我也愿意认真回应。", userIds: ["12345678"], mood: "calm" }],
      long_term: [],
      user_profile: []
    };
    const base = [{
      rowId: 1,
      source: "working",
      position: 0,
      recordId: "w",
      wrapper: false,
      effectiveData: replacement.working[0]
    }];
    expect(() => assertRowsEqualReplacements("plana", base, replacement)).not.toThrow();
    for (const changed of [
      [{ ...base[0], recordId: "wrong" }],
      [{ ...base[0], position: 1 }],
      [{ ...base[0], wrapper: true }],
      [{ ...base[0], effectiveData: { ...base[0].effectiveData, mood: "changed" } }]
    ]) expect(() => assertRowsEqualReplacements("plana", changed, replacement)).toThrow(/完整记录/);
  });

  it("binds schema, indexes, triggers, views, pragmas, and sqlite_sequence into logical SHA", async () => {
    const fixture = await createFixture();
    const databasePath = fixture.applicationPaths[0];
    const initial = databaseLogicalSha256(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE INDEX idx_other_value ON other_state(value)");
    database.close();
    expect(databaseLogicalSha256(databasePath)).not.toBe(initial);

    const indexed = databaseLogicalSha256(databasePath);
    const changed = new DatabaseSync(databasePath);
    changed.exec("CREATE VIEW other_view AS SELECT value FROM other_state; PRAGMA user_version=7;");
    changed.close();
    expect(databaseLogicalSha256(databasePath)).not.toBe(indexed);
  });

  it("writes a durable awaiting-backup intent and aborts without changing drifted production bytes", async () => {
    const fixture = await createFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
    const prepared = await prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    expect(prepared.state).toBe("awaiting-backup");
    const intentPath = path.join(fixture.workspace, "business/migrations/memory-perspective-v1-intent.json");
    const firstIntent = await readJson(intentPath);
    expect(firstIntent.intentSha256).toMatch(/^sha256:/);
    const aborted = await abortMigration({ workspace: fixture.workspace, ...offline });
    expect(aborted.ok).toBe(true);
    await expect(readJson(path.join(fixture.workspace, aborted.report))).resolves.toMatchObject({
      status: "aborted",
      previousState: "awaiting-backup",
      intentSha256: firstIntent.intentSha256,
      reportSha256: expect.stringMatching(/^sha256:/)
    });
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });

    await prepareMigration({ workspace: fixture.workspace, planDir: "business/migrations/plans", ...offline });
    const drifted = new DatabaseSync(fixture.queuePaths[0]);
    drifted.prepare("UPDATE outbox SET payload = ? WHERE id = 1").run("drift");
    drifted.close();
    const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    await fs.rm(path.join(fixture.workspace, "business/migrations/plans"), { recursive: true, force: true });
    await expect(abortMigration({ workspace: fixture.workspace, ...offline })).resolves.toMatchObject({ ok: true });
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the signed intent and production bytes unchanged when an abort stop gate fails", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
    await prepareMigration({ workspace: fixture.workspace, planDir: "business/migrations/plans", ...offline });
    const intentPath = migrationIntentFile(fixture);
    const intentBefore = await fs.readFile(intentPath, "utf8");
    const sidecar = `${fixture.queuePaths[0]}-wal`;
    await fs.writeFile(sidecar, Buffer.from("abort-stop-gate-sidecar"));
    const bytesBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const migrationDirectory = path.dirname(intentPath);
    const reportsBefore = (await fs.readdir(migrationDirectory)).filter((name) => name.includes("-abort-"));

    await expect(abortMigration({
      workspace: fixture.workspace,
      quiesced: true,
      portProbe: async () => true,
      handleProbe: async () => false
    })).rejects.toThrow(/仍在监听|running/i);
    await expect(abortMigration({
      workspace: fixture.workspace,
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => true
    })).rejects.toThrow(/仍被进程持有|handle/i);
    const outsideSidecar = path.join(fixture.root, "outside-wal");
    const sidecarBefore = await fs.readFile(sidecar);
    await fs.writeFile(outsideSidecar, "outside");
    await fs.rm(sidecar);
    try {
      await fs.symlink(outsideSidecar, sidecar);
      await expect(abortMigration({ workspace: fixture.workspace, ...offline }))
        .rejects.toThrow(/sidecar|符号链接|类型异常/i);
    } finally {
      await fs.rm(sidecar, { force: true });
      await fs.writeFile(sidecar, sidecarBefore);
    }

    expect(await fs.readFile(intentPath, "utf8")).toBe(intentBefore);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(bytesBefore);
    expect((await fs.readdir(migrationDirectory)).filter((name) => name.includes("-abort-"))).toEqual(reportsBefore);
  });

  it("rejects a missing registered pair and an unregistered orphan pair from export", async () => {
    const missing = await createFixture();
    await fs.rm(missing.queuePaths[3]);
    expect(() => exportBaseline({ workspace: missing.workspace, output: "business/migrations/export.json" })).toThrow(/成对/);

    const orphan = await createFixture();
    const orphanData = path.join(orphan.workspace, "business/agents/orphan/data");
    await fs.mkdir(orphanData, { recursive: true });
    createApplication(path.join(orphanData, "sunabot.sqlite"), "orphan");
    createQueue(path.join(orphanData, "session-queue.sqlite"));
    expect(() => exportBaseline({ workspace: orphan.workspace, output: "business/migrations/export.json" })).toThrow(/注册表|集合/);
  });

  it("allows the default Plana databases alongside a configuration-only agents/plana workspace", async () => {
    const fixture = await createFixture();
    const planaWorkspace = path.join(fixture.workspace, "business/agents/plana");
    await fs.mkdir(path.join(planaWorkspace, "system-prompts"), { recursive: true });
    await fs.writeFile(path.join(planaWorkspace, "agent.json"), "{}\n");
    await fs.writeFile(path.join(planaWorkspace, "system-prompts/tone.json"), "{}\n");

    await exportGenerateResolve(fixture);
    const exported = await readJson(path.join(fixture.workspace, "business/migrations/export.json"));
    const refreshed = refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    expect(exported.agents.map((agent: { agentId: string }) => agent.agentId).sort()).toEqual([...AGENTS].sort());
    expect(refreshed.plans).toHaveLength(4);
    expect(dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" }).ok).toBe(true);
  });

  it("allows an empty agents/plana/data directory as configuration-only workspace state", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.join(fixture.workspace, "business/agents/plana/data"), { recursive: true });

    expect(exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    }).agents).toHaveLength(4);
  });

  it("rejects a single Plana database under agents/plana/data", async () => {
    const fixture = await createFixture();
    const duplicateData = path.join(fixture.workspace, "business/agents/plana/data");
    await fs.mkdir(duplicateData, { recursive: true });
    createApplication(path.join(duplicateData, "sunabot.sqlite"), "plana");

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/成对|incomplete/i);
  });

  it("rejects a queue-only Plana database under agents/plana/data", async () => {
    const fixture = await createFixture();
    const duplicateData = path.join(fixture.workspace, "business/agents/plana/data");
    await fs.mkdir(duplicateData, { recursive: true });
    createQueue(path.join(duplicateData, "session-queue.sqlite"));

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/成对|incomplete/i);
  });

  it("rejects a complete duplicate Plana database pair under agents/plana/data", async () => {
    const fixture = await createFixture();
    const duplicateData = path.join(fixture.workspace, "business/agents/plana/data");
    await fs.mkdir(duplicateData, { recursive: true });
    createApplication(path.join(duplicateData, "sunabot.sqlite"), "plana");
    createQueue(path.join(duplicateData, "session-queue.sqlite"));

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/不能同时|duplicate|重复/i);
  });

  it.each(["data-symlink", "database-symlink", "data-file"] as const)(
    "rejects an unsafe agents/plana %s discovery path",
    async (kind) => {
      const fixture = await createFixture();
      const planaWorkspace = path.join(fixture.workspace, "business/agents/plana");
      const data = path.join(planaWorkspace, "data");
      await fs.mkdir(planaWorkspace, { recursive: true });
      if (kind === "data-symlink") {
        const external = path.join(fixture.root, "external-plana-data");
        await fs.mkdir(external);
        await fs.symlink(external, data, "dir");
      } else if (kind === "database-symlink") {
        await fs.mkdir(data);
        const external = path.join(fixture.root, "external-plana.sqlite");
        createApplication(external, "plana");
        await fs.symlink(external, path.join(data, "sunabot.sqlite"));
        createQueue(path.join(data, "session-queue.sqlite"));
      } else {
        await fs.writeFile(data, "not-a-directory\n");
      }

      expect(() => exportBaseline({
        workspace: fixture.workspace,
        output: "business/migrations/export.json"
      })).toThrow(/符号链接|symlink|必须是目录|layout/i);
    }
  );

  it("rejects a symbolic-link agents/plana root", async () => {
    const fixture = await createFixture();
    const external = path.join(fixture.root, "external-plana-workspace");
    await fs.mkdir(external);
    await fs.symlink(external, path.join(fixture.workspace, "business/agents/plana"), "dir");

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/Agent 目录|符号链接|symlink/i);
  });

  it("rejects agents/plana databases when the default Plana pair is missing", async () => {
    const fixture = await createFixture();
    await fs.rm(path.join(fixture.workspace, "business/data"), { recursive: true });
    const duplicateData = path.join(fixture.workspace, "business/agents/plana/data");
    await fs.mkdir(duplicateData, { recursive: true });
    createApplication(path.join(duplicateData, "sunabot.sqlite"), "plana");
    createQueue(path.join(duplicateData, "session-queue.sqlite"));

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/默认位置|registry|Plana/i);
  });

  it.each(["same-agent-pair", "cross-agent"] as const)(
    "rejects %s hard-linked database identities before writing the export",
    async (kind) => {
      const fixture = await createFixture();
      const output = path.join(fixture.workspace, "business/migrations/export.json");
      if (kind === "same-agent-pair") {
        await fs.rm(fixture.queuePaths[0]);
        await fs.link(fixture.applicationPaths[0], fixture.queuePaths[0]);
      } else {
        await fs.rm(fixture.applicationPaths[1]);
        await fs.link(fixture.applicationPaths[0], fixture.applicationPaths[1]);
      }

      expect(() => exportBaseline({ workspace: fixture.workspace, output })).toThrow(/同一数据库文件|identity|duplicate/i);
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("requires the registry exact set and never inserts Plana implicitly", async () => {
    const missingPlana = await createFixture();
    const registry = new DatabaseSync(missingPlana.applicationPaths[0]);
    registry.prepare("DELETE FROM agents WHERE id = ?").run("plana");
    registry.close();
    expect(() => exportBaseline({
      workspace: missingPlana.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/注册表|集合/);

    const emptyRegistry = await createFixture();
    const empty = new DatabaseSync(emptyRegistry.applicationPaths[0]);
    empty.exec("DELETE FROM agent_accounts; DELETE FROM agents;");
    empty.close();
    for (const agentId of AGENTS.slice(1)) {
      await fs.rm(path.join(emptyRegistry.workspace, `business/agents/${agentId}`), { recursive: true });
    }
    expect(() => exportBaseline({
      workspace: emptyRegistry.workspace,
      output: "business/migrations/export.json"
    })).toThrow(/注册表|集合/);
  });

  it("runs the complete staged recovery, install journal, and final verify chain on four Agent pairs", async () => {
    const { fixture, stagingWorkspace, staged } = await prepareStagedFull();
    expect(staged.state).toBe("staged-ready");
    expect((await verifyRecoveryPoint(staged.changedRecoveryPoint)).ok).toBe(true);
    const installed = await installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    });
    expect(installed.state).toBe("verifying");
    const verified = await verifyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    expect(verified.ok).toBe(true);
    await expect(fs.stat(path.join(
      fixture.workspace,
      "business/migrations/memory-perspective-v1-intent.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("observes every recovery SQLite open, including v2 registry validation and restore preflight", async () => {
    const fixture = await createFullFixture();
    const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const verifyEvents: Array<{ databasePath: string; id: string; phase?: string }> = [];
    await expect(verifyRecoveryPoint(recovery.directory, {
      databaseOpenObserver: (event: { databasePath: string; id: string; phase?: string }) => verifyEvents.push(event)
    })).resolves.toMatchObject({ ok: true });
    expect(verifyEvents).toHaveLength(9);
    expect(verifyEvents.filter((event) => event.phase === "agent-registry")).toHaveLength(1);

    const restoreEvents: Array<{ databasePath: string; id: string; phase?: string }> = [];
    const targetWorkspace = path.join(fixture.root, "observer-restore-target");
    await expect(restoreRecoveryPoint({
      backupDirectory: recovery.directory,
      targetWorkspace,
      databaseOpenObserver: (event: { databasePath: string; id: string; phase?: string }) => restoreEvents.push(event)
    })).resolves.toMatchObject({ ok: true, targetWorkspace });
    expect(restoreEvents).toHaveLength(25);
    expect(restoreEvents.filter((event) => event.phase === "agent-registry")).toHaveLength(1);
    expect(restoreEvents.filter((event) => event.phase === "restore-staging-verify")).toHaveLength(8);
    expect(restoreEvents.filter((event) => event.phase === "restored-workspace-verify")).toHaveLength(8);
  }, 30_000);

  it("resumes install after real SIGKILL at quarantine, rename, and intent boundaries", async () => {
    for (const point of ["after-install-quarantine:arona", "after-install-rename:arona", "after-install-intent:arona"]) {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
      const code = `
        import { installStagedMigration } from ${JSON.stringify(pathToFileUrl(cli))};
        await installStagedMigration({
          workspace: ${JSON.stringify(fixture.workspace)},
          stagingWorkspace: ${JSON.stringify(stagingWorkspace)},
          confirmReplace: true,
          quiesced: true,
          portProbe: async () => false,
          handleProbe: async () => false
        });
      `;
      const killed = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
        encoding: "utf8"
      });
      expect(killed.signal).toBe("SIGKILL");
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        ...offline
      })).resolves.toMatchObject({ state: "verifying" });
      await expect(verifyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        ...offline
      })).resolves.toMatchObject({ ok: true });
    }
  }, 60_000);

  it("rejects a changed-recovery-to-staged hardlink on install reentry after SIGKILL quarantine", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    expect(runKilledInstall(
      fixture.workspace,
      stagingWorkspace,
      "after-install-quarantine:arona"
    ).signal).toBe("SIGKILL");
    const intent = await readJson(migrationIntentFile(fixture));
    expect(intent.state).toBe("installing");
    const binding = intent.installDirectories.find((candidate: any) => candidate.agentId === "arona");
    if (!binding) throw new Error("install journal 缺少 Arona");
    const alias = await hardlinkBoundRecoveryToMatchingLive(
      fixture.workspace,
      intent.changedRecovery,
      stagingWorkspace
    );
    expect(alias.recoveryStat.dev).toBe(alias.liveStat.dev);
    expect(alias.recoveryStat.ino).toBe(alias.liveStat.ino);
    expect(alias.recoveryStat.nlink).toBe(2);
    const journalDirectoriesBefore = await snapshotDirectoryBytes([
      binding.stagedAbsolute,
      binding.quarantineAbsolute
    ]);
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/独立|身份|link|rollback/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes([
      binding.stagedAbsolute,
      binding.quarantineAbsolute
    ])).toEqual(journalDirectoriesBefore);
    await expect(fs.stat(binding.currentAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
  }, 60_000);

  it("rejects cross-filesystem install before the first data-directory rename", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    const original = await fs.stat(fixture.applicationPaths[0]);
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      deviceProbe: (directory: string) => directory.startsWith(stagingWorkspace) ? 2 : 1,
      ...offline
    })).rejects.toThrow(/filesystem|跨/);
    expect((await fs.stat(fixture.applicationPaths[0])).ino).toBe(original.ino);
  }, 30_000);

  it("fails cross-filesystem staging with zero rename and permits byte-preserving abort", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "cross-device-staging");
    const original = await fs.stat(fixture.applicationPaths[0]);
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      deviceProbe: (directory: string) => directory.startsWith(stagingWorkspace) ? 2 : 1,
      ...offline
    })).rejects.toThrow(/filesystem|跨/);
    expect((await fs.stat(fixture.applicationPaths[0])).ino).toBe(original.ino);
    const intentPath = path.join(fixture.workspace, "business/migrations/memory-perspective-v1-intent.json");
    expect((await readJson(intentPath)).state).toBe("staging-failed");
    const beforeAbort = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    await expect(abortMigration({ workspace: fixture.workspace, ...offline })).resolves.toMatchObject({ ok: true });
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(beforeAbort);
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("binds final staging files only after changed recovery closes and leaves no SQLite sidecars", async () => {
    const { fixture, stagingWorkspace, staged } = await prepareStagedFull();
    const intent = await readJson(migrationIntentFile(fixture));
    const changed = await verifyRecoveryPoint(staged.changedRecoveryPoint);
    expect(intent.state).toBe("staged-ready");
    expect(intent.stagingDatabases).toHaveLength(8);

    for (const binding of intent.stagingDatabases) {
      const databasePath = path.join(stagingWorkspace, binding.source);
      const fileSha256 = await sha256FileForTest(databasePath);
      expect(fileSha256).toBe(binding.fileSha256);
      expect(changed.manifest.databases.find((entry: { source: string }) => entry.source === binding.source)?.sha256)
        .toBe(fileSha256);
      await expect(fs.stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

  it("resumes rollback install after real SIGKILL at every directory journal boundary", async () => {
    for (const point of ["after-install-quarantine:arona", "after-install-rename:arona", "after-install-intent:arona"]) {
      const { fixture, rollbackStaging } = await prepareRollbackStaged();
      const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
      const code = `
        import { installStagedMigration } from ${JSON.stringify(pathToFileUrl(cli))};
        await installStagedMigration({
          workspace: ${JSON.stringify(fixture.workspace)},
          stagingWorkspace: ${JSON.stringify(rollbackStaging)},
          confirmReplace: true,
          quiesced: true,
          portProbe: async () => false,
          handleProbe: async () => false
        });
      `;
      const killed = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
        encoding: "utf8"
      });
      expect(killed.signal).toBe("SIGKILL");
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace: rollbackStaging,
        confirmReplace: true,
        ...offline
      })).resolves.toMatchObject({ status: "rolled-back" });
    }
  }, 60_000);

  it("fails a stale recovery point and permits a signed PRE-state abort", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
    const old = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true, now: new Date("2026-01-01T00:00:00.000Z") });
    await prepareMigration({ workspace: fixture.workspace, planDir: "business/migrations/plans", ...offline });
    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: old.directory,
      ...offline
    })).rejects.toThrow(/createdAt|晚于/);
    await expect(abortMigration({ workspace: fixture.workspace, ...offline })).resolves.toMatchObject({ ok: true });
  }, 30_000);

  it("rolls production back through a verified empty staging after final verify detects queue drift", async () => {
    const { fixture, stagingWorkspace, recovery } = await prepareStagedFull();
    await installStagedMigration({ workspace: fixture.workspace, stagingWorkspace, confirmReplace: true, ...offline });
    const queue = new SessionStore({ databasePath: fixture.queuePaths[0] });
    queue.enqueueEvent({
      sessionId: "private:plana:12345678",
      kind: "incoming",
      dedupeKey: "rollback-drift",
      payload: { text: "drift" }
    });
    queue.close();
    await expect(verifyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    })).rejects.toThrow(/ROLLBACK|verify|摘要/i);
    const rollbackStaging = path.join(fixture.root, "rollback-staging");
    await stageRollback({
      workspace: fixture.workspace,
      backup: recovery.directory,
      targetWorkspace: rollbackStaging,
      ...offline
    });
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace: rollbackStaging,
      confirmReplace: true,
      ...offline
    })).resolves.toMatchObject({ status: "rolled-back" });
    const database = new DatabaseSync(fixture.applicationPaths[0], { readOnly: true });
    const row = database.prepare("SELECT data_json FROM memory_records WHERE source='working'").get();
    database.close();
    expect(JSON.parse(String(row?.data_json)).fact).toBe("旧工作事实");
  }, 60_000);

  it.each(["deleted", "invalid-json", "invalid-signature"] as const)(
    "marks a %s pending report rollback-required and restores all eight original databases",
    async (failure) => {
      const { fixture, stagingWorkspace, recovery } = await prepareStagedFull();
      const databaseFiles = [...fixture.applicationPaths, ...fixture.queuePaths];
      const originalRecovery = await verifyRecoveryPoint(recovery.directory);
      const recoveryBytesBySource = new Map(await Promise.all(
        originalRecovery.manifest.databases.map(async (entry: { source: string; file: string }) => [
          entry.source,
          await fs.readFile(path.join(recovery.directory, entry.file))
        ] as const)
      ));
      const signedIntent = await readJson(migrationIntentFile(fixture));
      const originalLogicalBySource = new Map(signedIntent.backup.databases.map((entry: {
        source: string;
        logicalSha256: string;
      }) => [entry.source, entry.logicalSha256]));
      const originalLogical = databaseFiles.map((file) => originalLogicalBySource.get(
        path.relative(fixture.workspace, file).split(path.sep).join("/")
      ));
      const externalSentinel = path.join(fixture.root, `external-${failure}.bin`);
      const externalBytes = Buffer.from(`external-${failure}-unchanged`);
      await fs.writeFile(externalSentinel, externalBytes);

      const installed = await installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        ...offline
      });
      const reportPath = path.join(fixture.workspace, String(installed.pendingReport));
      if (failure === "deleted") {
        await fs.rm(reportPath);
      } else if (failure === "invalid-json") {
        await fs.writeFile(reportPath, "{invalid-json\n");
      } else {
        const report = await readJson(reportPath);
        report.reportSha256 = "sha256:invalid";
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }

      await expect(verifyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        ...offline
      })).rejects.toThrow(/ROLLBACK|verify|pending-report|JSON|signature/i);

      const intentPath = path.join(
        fixture.workspace,
        "business/migrations/memory-perspective-v1-intent.json"
      );
      expect((await readJson(intentPath)).state).toBe("rollback-required");
      const rollbackStaging = path.join(fixture.root, `rollback-${failure}`);
      await stageRollback({
        workspace: fixture.workspace,
        backup: recovery.directory,
        targetWorkspace: rollbackStaging,
        ...offline
      });
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace: rollbackStaging,
        confirmReplace: true,
        ...offline
      })).resolves.toMatchObject({ status: "rolled-back" });

      expect(await Promise.all(databaseFiles.map((file) => fs.readFile(file)))).toEqual(
        databaseFiles.map((file) => recoveryBytesBySource.get(
          path.relative(fixture.workspace, file).split(path.sep).join("/")
        ))
      );
      expect(databaseFiles.map((file) => databaseLogicalSha256(file))).toEqual(originalLogical);
      expect(await fs.readFile(externalSentinel)).toEqual(externalBytes);
      await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000
  );

  it("rejects a changed-recovery hardlink to production before verify opens or checkpoints live SQLite", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    await installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    });
    const intent = await readJson(migrationIntentFile(fixture));
    const alias = await hardlinkBoundRecoveryToMatchingLive(
      fixture.workspace,
      intent.changedRecovery,
      fixture.workspace
    );
    expect(alias.recoveryStat.dev).toBe(alias.liveStat.dev);
    expect(alias.recoveryStat.ino).toBe(alias.liveStat.ino);
    expect(alias.recoveryStat.nlink).toBe(2);
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(verifyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/独立|身份|link|rollback/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
  }, 60_000);

  it("rejects an original-recovery hardlink to production before rollback opens or checkpoints live SQLite", async () => {
    const prepared = await prepareRollbackStaged();
    await rewriteBoundRecoveryWithExactLiveFile(
      prepared.fixture.workspace,
      "backup",
      prepared.fixture.workspace,
      "application"
    );
    const intent = await readJson(migrationIntentFile(prepared.fixture));
    const alias = await hardlinkBoundRecoveryToMatchingLive(
      prepared.fixture.workspace,
      intent.backup,
      prepared.fixture.workspace
    );
    expect(alias.recoveryStat.dev).toBe(alias.liveStat.dev);
    expect(alias.recoveryStat.ino).toBe(alias.liveStat.ino);
    expect(alias.recoveryStat.nlink).toBe(2);
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(prepared.fixture));
    const rollbackTarget = path.join(prepared.fixture.root, "rejected-rollback-identity-alias");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(stageRollback({
      workspace: prepared.fixture.workspace,
      backup: prepared.recovery.directory,
      targetWorkspace: rollbackTarget,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/独立|身份|link/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(prepared.fixture))).toEqual(productionBefore);
    expect((await readJson(migrationIntentFile(prepared.fixture))).state).toBe("rollback-staged");
    await expect(fs.stat(rollbackTarget)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects an existing rollback target hardlink to production before opening target SQLite", async () => {
    const prepared = await prepareRollbackStaged();
    const productionPath = prepared.fixture.applicationPaths[0];
    const targetPath = path.join(
      prepared.rollbackStaging,
      path.relative(prepared.fixture.workspace, productionPath)
    );
    await fs.rm(targetPath);
    await fs.link(productionPath, targetPath);
    const [productionStat, targetStat] = await Promise.all([
      fs.stat(productionPath),
      fs.stat(targetPath)
    ]);
    expect(productionStat.dev).toBe(targetStat.dev);
    expect(productionStat.ino).toBe(targetStat.ino);
    expect(productionStat.nlink).toBe(2);
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(prepared.fixture));
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(stageRollback({
      workspace: prepared.fixture.workspace,
      backup: prepared.recovery.directory,
      targetWorkspace: prepared.rollbackStaging,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/独立|身份|link/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(prepared.fixture))).toEqual(productionBefore);
    expect((await readJson(migrationIntentFile(prepared.fixture))).state).toBe("rollback-staged");
  }, 60_000);

  it.each(["database-missing", "registry-schema-corrupt"] as const)(
    "moves verify %s failures to rollback-required and restores all eight databases",
    async (failure) => {
      const { fixture, stagingWorkspace, recovery } = await prepareStagedFull();
      await installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        ...offline
      });
      if (failure === "database-missing") {
        await fs.rm(fixture.applicationPaths[1]);
      } else {
        const database = new DatabaseSync(fixture.applicationPaths[0]);
        database.exec("DROP TABLE agent_accounts");
        database.close();
      }

      await expect(verifyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        ...offline
      })).rejects.toThrow(/ROLLBACK|verify|数据库|schema|Agent/i);
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");

      const rollbackStaging = path.join(fixture.root, `rollback-verify-${failure}`);
      await stageRollback({
        workspace: fixture.workspace,
        backup: recovery.directory,
        targetWorkspace: rollbackStaging,
        ...offline
      });
      await installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace: rollbackStaging,
        confirmReplace: true,
        ...offline
      });
      await expectWorkspaceMatchesRecovery(fixture, recovery.directory);
      await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000
  );

  it.each(["deleted", "symlink-corrupt"] as const)(
    "recovers a SIGKILL forward install after its staging workspace is %s",
    async (failure) => {
      const { fixture, stagingWorkspace, recovery } = await prepareStagedFull();
      expect(runKilledInstall(fixture.workspace, stagingWorkspace, "after-install-intent:arona").signal).toBe("SIGKILL");
      const sentinel = path.join(fixture.root, `external-staging-${failure}`);
      await fs.mkdir(sentinel);
      await fs.writeFile(path.join(sentinel, "sentinel.txt"), "unchanged");
      await fs.rm(stagingWorkspace, { recursive: true, force: true });
      if (failure === "symlink-corrupt") await fs.symlink(sentinel, stagingWorkspace, "dir");

      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        ...offline
      })).rejects.toThrow(/ROLLBACK|staging|符号链接|workspace/i);
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");

      const rollbackStaging = path.join(fixture.root, `rollback-forward-${failure}`);
      await stageRollback({
        workspace: fixture.workspace,
        backup: recovery.directory,
        targetWorkspace: rollbackStaging,
        ...offline
      });
      await installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace: rollbackStaging,
        confirmReplace: true,
        ...offline
      });
      await expectWorkspaceMatchesRecovery(fixture, recovery.directory);
      expect(await fs.readFile(path.join(sentinel, "sentinel.txt"), "utf8")).toBe("unchanged");
      await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000
  );

  it("rebuilds a fresh rollback journal after SIGKILL and rollback staging loss", async () => {
    const { fixture, recovery, rollbackStaging } = await prepareRollbackStaged();
    expect(runKilledInstall(fixture.workspace, rollbackStaging, "after-install-intent:arona").signal).toBe("SIGKILL");
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-installing");
    await fs.rm(rollbackStaging, { recursive: true, force: true });

    const rebuilt = path.join(fixture.root, "rollback-rebuilt-after-loss");
    await stageRollback({
      workspace: fixture.workspace,
      backup: recovery.directory,
      targetWorkspace: rebuilt,
      ...offline
    });
    const restagedIntent = await readJson(migrationIntentFile(fixture));
    expect(restagedIntent.state).toBe("rollback-staged");
    expect(restagedIntent.stagingWorkspace).toBe(rebuilt);
    await installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace: rebuilt,
      confirmReplace: true,
      ...offline
    });
    await expectWorkspaceMatchesRecovery(fixture, recovery.directory);
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rebuilds a missing rollback-staged workspace from the signed original backup", async () => {
    const { fixture, recovery, rollbackStaging } = await prepareRollbackStaged();
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-staged");
    await fs.rm(rollbackStaging, { recursive: true, force: true });
    const rebuilt = path.join(fixture.root, "rollback-restaged-after-loss");
    await stageRollback({
      workspace: fixture.workspace,
      backup: recovery.directory,
      targetWorkspace: rebuilt,
      ...offline
    });
    await installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace: rebuilt,
      confirmReplace: true,
      ...offline
    });
    await expectWorkspaceMatchesRecovery(fixture, recovery.directory);
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("finalizes an already installed rollback from signed database evidence if the backup later corrupts", async () => {
    const { fixture, recovery, rollbackStaging } = await prepareRollbackStaged();
    const verified = await verifyRecoveryPoint(recovery.directory);
    const expectedBySource = new Map(await Promise.all(verified.manifest.databases.map(async (entry) => [
      String(entry.source),
      await fs.readFile(path.join(verified.directory, String(entry.file)))
    ] as const)));
    expect(runKilledInstall(fixture.workspace, rollbackStaging, "after-install-directories").signal).toBe("SIGKILL");
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-installing");
    const manifestPath = path.join(recovery.directory, "manifest.json");
    const manifest = await readJson(manifestPath);
    manifest.createdAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace: rollbackStaging,
      confirmReplace: true,
      ...offline
    })).resolves.toMatchObject({ status: "rolled-back" });
    const databaseFiles = [...fixture.applicationPaths, ...fixture.queuePaths];
    expect(await Promise.all(databaseFiles.map((file) => fs.readFile(file)))).toEqual(
      databaseFiles.map((file) => expectedBySource.get(
        path.relative(fixture.workspace, file).split(path.sep).join("/")
      ))
    );
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("keeps verifying retryable when quiescence confirmation or probes fail", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    await installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    });
    await expect(verifyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      quiesced: false
    })).rejects.toThrow(/quiesced|停服|显式/i);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("verifying");
    await expect(verifyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      quiesced: true,
      portProbe: async () => true,
      handleProbe: async () => false
    })).rejects.toThrow(/仍在监听|running/i);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("verifying");
  }, 30_000);

  it.each([
    "original-deleted",
    "original-manifest-tampered",
    "changed-deleted",
    "changed-database-tampered"
  ] as const)("rejects %s recovery evidence before the first production rename", async (failure) => {
    const { fixture, stagingWorkspace, recovery, staged } = await prepareStagedFull();
    const directoryInodes = await Promise.all(fixture.applicationPaths.map((file) => fs.stat(path.dirname(file))));
    const original = await verifyRecoveryPoint(recovery.directory);
    const changed = await verifyRecoveryPoint(staged.changedRecoveryPoint);
    if (failure === "original-deleted") {
      await fs.rm(recovery.directory, { recursive: true, force: true });
    } else if (failure === "original-manifest-tampered") {
      const manifestPath = path.join(recovery.directory, "manifest.json");
      const manifest = await readJson(manifestPath);
      manifest.createdAt = "2000-01-01T00:00:00.000Z";
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (failure === "changed-deleted") {
      await fs.rm(staged.changedRecoveryPoint, { recursive: true, force: true });
    } else {
      await fs.appendFile(path.join(
        changed.directory,
        changed.manifest.databases[0].file
      ), Buffer.from("tampered"));
    }

    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    })).rejects.toThrow(/recovery|恢复点|backup|manifest|checksum|安装/i);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
    expect((await Promise.all(fixture.applicationPaths.map((file) => fs.stat(path.dirname(file)))))
      .map((stat) => stat.ino)).toEqual(directoryInodes.map((stat) => stat.ino));
    expect(original.manifest.databases).toHaveLength(8);
  }, 60_000);

  it("aborts prepared drift without reading the plan or backup or replacing production bytes", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const queue = new SessionStore({ databasePath: fixture.queuePaths[0] });
    queue.enqueueEvent({
      sessionId: "private:plana:12345678",
      kind: "incoming",
      dedupeKey: "prepared-abort-drift",
      payload: { text: "drift" }
    });
    queue.close();
    const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    await Promise.all([
      fs.rm(recovery.directory, { recursive: true, force: true }),
      fs.rm(path.join(fixture.workspace, "business/migrations/plans"), { recursive: true, force: true })
    ]);
    const aborted = await abortMigration({ workspace: fixture.workspace, ...offline });
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
    await expect(readJson(path.join(fixture.workspace, aborted.report))).resolves.toMatchObject({
      previousState: "prepared",
      intentSha256: expect.stringMatching(/^sha256:/)
    });
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("aborts a signed missing Agent data directory without recreating or replacing it", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const missingDataDirectory = path.dirname(fixture.applicationPaths[1]);
    await fs.rm(missingDataDirectory, { recursive: true, force: true });
    const existingDirectories = fixtureDataDirectories(fixture).filter((directory) => directory !== missingDataDirectory);
    const before = await snapshotDirectoryBytes(existingDirectories);
    await Promise.all([
      fs.rm(recovery.directory, { recursive: true, force: true }),
      fs.rm(path.join(fixture.workspace, "business/migrations/plans"), { recursive: true, force: true })
    ]);
    await expect(abortMigration({ workspace: fixture.workspace, ...offline })).resolves.toMatchObject({ ok: true });
    await expect(fs.stat(missingDataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await snapshotDirectoryBytes(existingDirectories)).toEqual(before);
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("keeps staged-ready after install preflight drift and then aborts without replacing production bytes", async () => {
    const { fixture, stagingWorkspace, recovery } = await prepareStagedFull();
    const queue = new SessionStore({ databasePath: fixture.queuePaths[0] });
    queue.enqueueEvent({
      sessionId: "private:plana:12345678",
      kind: "incoming",
      dedupeKey: "staged-ready-abort-drift",
      payload: { text: "drift" }
    });
    queue.close();
    const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    await fs.rm(stagingWorkspace, { recursive: true, force: true });
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    })).rejects.toThrow(/staging|安装|目录|不存在/i);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
    await Promise.all([
      fs.rm(recovery.directory, { recursive: true, force: true }),
      fs.rm(path.join(fixture.workspace, "business/migrations/plans"), { recursive: true, force: true })
    ]);
    await expect(abortMigration({ workspace: fixture.workspace, ...offline })).resolves.toMatchObject({ ok: true });
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it.each([
    ["staging-restored", "after-staging-restore"],
    ["staging-applying", "before-staging-commit:arona"]
  ] as const)("aborts %s without plan, backup, or staging inputs", async (expectedState, fault) => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, `apply-state-${expectedState}`);
    expect(runKilledApply(
      fixture.workspace,
      recovery.directory,
      stagingWorkspace,
      fault
    ).signal).toBe("SIGKILL");
    expect((await readJson(migrationIntentFile(fixture))).state).toBe(expectedState);
    const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    await Promise.all([
      fs.rm(path.join(fixture.workspace, "business/migrations/plans"), { recursive: true, force: true }),
      fs.rm(recovery.directory, { recursive: true, force: true }),
      fs.rm(stagingWorkspace, { recursive: true, force: true })
    ]);
    const aborted = await abortMigration({ workspace: fixture.workspace, ...offline });
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
    await expect(readJson(path.join(fixture.workspace, aborted.report))).resolves.toMatchObject({
      previousState: expectedState,
      intentSha256: expect.stringMatching(/^sha256:/)
    });
    await expect(fs.stat(migrationIntentFile(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects a production hardlink hidden behind staging after an after-staging-restore SIGKILL", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "staging-restored-hardlink-reentry");
    expect(runKilledApply(
      fixture.workspace,
      recovery.directory,
      stagingWorkspace,
      "after-staging-restore"
    ).signal).toBe("SIGKILL");
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staging-restored");
    const productionPath = fixture.applicationPaths[0];
    const stagedPath = path.join(stagingWorkspace, path.relative(fixture.workspace, productionPath));
    await fs.rm(stagedPath);
    await fs.link(productionPath, stagedPath);
    const [productionStat, stagedStat] = await Promise.all([
      fs.stat(productionPath),
      fs.stat(stagedPath)
    ]);
    expect(productionStat.dev).toBe(stagedStat.dev);
    expect(productionStat.ino).toBe(stagedStat.ino);
    expect(productionStat.nlink).toBe(2);
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/独立|身份|link|staging/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staging-failed");
  }, 60_000);

  it("binds one direct and one wrapper row with the same source/effectiveId through refresh and dry-run", async () => {
    const { fixture } = await prepareDuplicateWorkingProposal();
    const refreshed = refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });

    expect(refreshed.plans).toHaveLength(4);
    expect(dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" }).ok).toBe(true);
  });

  it.each(["wrapper-base", "missing-evidence", "delete", "split-target"] as const)(
    "rejects an invalid duplicate source/effectiveId group with %s",
    async (kind) => {
      const prepared = await prepareDuplicateWorkingProposal({ otherWorking: kind === "split-target" });
      const proposalPath = path.join(prepared.fixture.workspace, "business/migrations/proposals/plana.proposal.json");
      const proposal = await readJson(proposalPath);
      const target = proposal.targets.working.find((candidate: { id: string }) => candidate.id === prepared.effectiveId);
      const directAction = proposal.rowActions.find((action: { stableKey: string }) => action.stableKey === prepared.directStableKey);
      const wrapperAction = proposal.rowActions.find((action: { stableKey: string }) => action.stableKey === prepared.wrapperStableKey);
      if (kind === "wrapper-base") {
        target.baseStableKey = prepared.wrapperStableKey;
      } else if (kind === "missing-evidence") {
        target.sourceStableKeys = [prepared.directStableKey];
      } else if (kind === "delete") {
        wrapperAction.action = "delete";
        wrapperAction.targetId = null;
      } else {
        wrapperAction.targetId = "other-working";
      }
      expect(directAction.action).toBe("keep");
      await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
      signProposalDirectory({ proposalDir: path.dirname(proposalPath) });

      expect(() => refreshPlans({
        workspace: prepared.fixture.workspace,
        proposalDir: "business/migrations/proposals",
        planDir: "business/migrations/rejected-plans"
      })).toThrow(/重复 stableKey|全部 stableKey|direct\/non-wrapper|base 必须 keep|唯一 target|证据与 action/i);
    }
  );

  it("enforces the duplicate source/effectiveId group again while validating a signed plan", async () => {
    const { fixture, wrapperStableKey } = await prepareDuplicateWorkingProposal();
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
    const planPath = path.join(fixture.workspace, "business/migrations/plans/plana.plan.json");
    const plan = await readJson(planPath);
    const wrapperAction = plan.rowActions.find((action: { stableKey: string }) => action.stableKey === wrapperStableKey);
    wrapperAction.action = "delete";
    wrapperAction.targetId = null;
    await fs.writeFile(planPath, `${JSON.stringify(resignTestDocument(plan, "planSha256"), null, 2)}\n`);

    expect(() => dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" }))
      .toThrow(/base 必须 keep|其余记录必须 merge|重复 stableKey/i);
  });

  it("allows the same effectiveId in different memory sources", async () => {
    const fixture = await createFixture();
    insertMemory(fixture.applicationPaths[0], "working", "cross-source-id", "工作事实", ["12345678"]);
    insertMemory(fixture.applicationPaths[0], "long_term", "cross-source-id", "长期事实", ["12345678"]);
    await exportGenerateResolve(fixture);
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });

    expect(dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" }).ok).toBe(true);
  });

  it("still rejects two rows with the exact same stableKey", async () => {
    const fixture = await createFixture();
    duplicateMemoryRow(fixture.applicationPaths[0], "working", "working-plana");

    expect(() => exportBaseline({ workspace: fixture.workspace, output: "business/migrations/export.json" }))
      .toThrow(/stableKey 重复/);
  });

  it("rejects deleted rows and duplicated proposal stable keys independently", async () => {
    const deleted = await createFixture();
    await exportGenerateResolve(deleted);
    removeMemoryById(deleted.applicationPaths[0], "working-plana");
    expect(() => refreshPlans({
      workspace: deleted.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    })).toThrow(/集合已变化|重新 export/);

    const duplicate = await createFixture();
    await exportGenerateResolve(duplicate);
    const proposalPath = path.join(duplicate.workspace, "business/migrations/proposals/plana.proposal.json");
    const proposal = await readJson(proposalPath);
    proposal.inputs.push({ ...proposal.inputs[0] });
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() => signProposalDirectory({ proposalDir: path.dirname(proposalPath) })).toThrow(/stableKey 重复/);
  });

  it("rejects forbidden metadata patches and artifact paths outside workspace", async () => {
    const fixture = await createFixture();
    await exportGenerateResolve(fixture);
    const outsideSignedProposals = path.join(fixture.root, "outside-signed-proposals");
    await fs.cp(
      path.join(fixture.workspace, "business/migrations/proposals"),
      outsideSignedProposals,
      { recursive: true }
    );
    expect(() => signProposalDirectory({ proposalDir: outsideSignedProposals })).toThrow(/workspace|所属/);

    const proposalPath = path.join(fixture.workspace, "business/migrations/proposals/plana.proposal.json");
    const proposal = await readJson(proposalPath);
    proposal.targets.working[0].metadataPatch.set.addressName = "越权修改";
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() => signProposalDirectory({ proposalDir: path.dirname(proposalPath) })).toThrow(/禁止修改|metadata/);
    delete proposal.targets.working[0].metadataPatch.set.addressName;
    proposal.targets.working[0].metadataPatch.remotePath = "/tmp/forbidden";
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() => signProposalDirectory({ proposalDir: path.dirname(proposalPath) })).toThrow(/metadataPatch|未知字段/);
    delete proposal.targets.working[0].metadataPatch.remotePath;
    proposal.sourceExportSha256 = `sha256:${"0".repeat(64)}`;
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() => signProposalDirectory({ proposalDir: path.dirname(proposalPath) })).toThrow(/signed export|绑定/);

    expect(() => exportBaseline({
      workspace: fixture.workspace,
      output: path.join(fixture.root, "outside-export.json")
    })).toThrow(/workspace 内/);
    expect(() => generateProposals({
      exportFile: path.join(fixture.workspace, "business/migrations/export.json"),
      proposalDir: path.join(fixture.root, "outside-proposals")
    })).toThrow(/workspace 内/);

    const planFixture = await createFixture();
    await exportGenerateResolve(planFixture);
    refreshPlans({
      workspace: planFixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    const planPath = path.join(planFixture.workspace, "business/migrations/plans/plana.plan.json");
    const plan = await readJson(planPath);
    plan.remotePath = "/tmp/unknown-plan-artifact";
    await fs.writeFile(planPath, `${JSON.stringify(resignTestDocument(plan, "planSha256"), null, 2)}\n`);
    expect(() => dryRunPlans({
      workspace: planFixture.workspace,
      planDir: "business/migrations/plans"
    })).toThrow(/remotePath|未知字段/);
    delete plan.remotePath;
    plan.sourceExport = "/tmp/absolute-export.json";
    await fs.writeFile(planPath, `${JSON.stringify(resignTestDocument(plan, "planSha256"), null, 2)}\n`);
    expect(() => dryRunPlans({
      workspace: planFixture.workspace,
      planDir: "business/migrations/plans"
    })).toThrow(/绝对|artifact|relative|相对/i);
  });

  it("keeps all eight main, wal, and shm files byte-identical through export, refresh, and dry-run", async () => {
    const fixture = await createFixture();
    const files = [...fixture.applicationPaths, ...fixture.queuePaths];
    const liveConnections = files.map((file, index) => {
      const database = new DatabaseSync(file);
      database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${index + 1};`);
      return database;
    });
    const directories = [...new Set(files.map((file) => path.dirname(file)))].sort();
    try {
      const before = await snapshotDirectoryBytes(directories);
      for (const directory of before) {
        const names = directory.files.map((file) => file.name);
        expect(names.filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
        expect(names.filter((name) => name.endsWith(".sqlite-wal"))).toHaveLength(2);
        expect(names.filter((name) => name.endsWith(".sqlite-shm"))).toHaveLength(2);
      }

      exportBaseline({ workspace: fixture.workspace, output: "business/migrations/export.json" });
      expect(await snapshotDirectoryBytes(directories)).toEqual(before);
      generateProposals({
        exportFile: path.join(fixture.workspace, "business/migrations/export.json"),
        proposalDir: path.join(fixture.workspace, "business/migrations/proposals")
      });
      await resolveAllProposals(fixture.workspace);
      expect(await snapshotDirectoryBytes(directories)).toEqual(before);
      refreshPlans({
        workspace: fixture.workspace,
        proposalDir: "business/migrations/proposals",
        planDir: "business/migrations/plans"
      });
      expect(await snapshotDirectoryBytes(directories)).toEqual(before);
      expect(dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" }).ok).toBe(true);
      expect(await snapshotDirectoryBytes(directories)).toEqual(before);
    } finally {
      for (const database of liveConnections) database.close();
    }
  });

  it("detects trigger and sqlite_sequence changes as independent logical-SHA mutations", async () => {
    const fixture = await createFixture();
    const databasePath = fixture.applicationPaths[0];
    const beforeTrigger = databaseLogicalSha256(databasePath);
    const trigger = new DatabaseSync(databasePath);
    trigger.exec("CREATE TRIGGER other_state_guard AFTER INSERT ON other_state BEGIN UPDATE other_state SET value = value WHERE id = NEW.id; END;");
    trigger.close();
    expect(databaseLogicalSha256(databasePath)).not.toBe(beforeTrigger);

    const beforeSequence = databaseLogicalSha256(databasePath);
    const sequence = new DatabaseSync(databasePath);
    sequence.exec("INSERT INTO other_state(value) VALUES ('sequence-change'); DELETE FROM other_state WHERE value='sequence-change';");
    sequence.close();
    expect(databaseLogicalSha256(databasePath)).not.toBe(beforeSequence);
  });

  it("rejects original recovery binding after application baseline or queue content drifts", async () => {
    for (const drift of ["application", "queue"] as const) {
      const fixture = await createFullFixture();
      await exportGenerateResolve(fixture);
      refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
      await prepareMigration({ workspace: fixture.workspace, planDir: "business/migrations/plans", ...offline });
      const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
      const database = new DatabaseSync(drift === "application" ? fixture.applicationPaths[0] : fixture.queuePaths[0]);
      if (drift === "application") {
        database.prepare("UPDATE memory_records SET data_json = json_set(data_json, '$.fact', '漂移') WHERE source='working'").run();
      } else {
        database.exec("PRAGMA user_version=99");
      }
      database.close();
      await expect(prepareMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        backup: recovery.directory,
        ...offline
      })).rejects.toThrow(/摘要|绑定|漂移/);
    }
  }, 60_000);

  it("mechanically unions scalar working userId evidence and removes an ambiguous scalar", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.applicationPaths[0]);
    const first = database.prepare("SELECT row_id, data_json FROM memory_records WHERE source='working'").get();
    const firstData = JSON.parse(String(first?.data_json));
    delete firstData.userIds;
    firstData.userId = "12345678";
    database.prepare("UPDATE memory_records SET data_json=? WHERE row_id=?").run(JSON.stringify(firstData), first?.row_id);
    insertMemory(fixture.applicationPaths[0], "working", "working-second", "第二条", []);
    const second = database.prepare("SELECT row_id, data_json FROM memory_records WHERE record_id='working-second'").get();
    const secondData = JSON.parse(String(second?.data_json));
    delete secondData.userIds;
    secondData.userId = "87654321";
    database.prepare("UPDATE memory_records SET data_json=? WHERE row_id=?").run(JSON.stringify(secondData), second?.row_id);
    database.close();

    await exportGenerateResolve(fixture);
    const proposalPath = path.join(fixture.workspace, "business/migrations/proposals/plana.proposal.json");
    const proposal = await readJson(proposalPath);
    const workingTargets = proposal.targets.working;
    workingTargets[0].sourceStableKeys.push(workingTargets[1].sourceStableKeys[0]);
    workingTargets[0].targetFact = "我记得 QQ 12345678 与 QQ 87654321 都留下了请求，我觉得两人的需要都重要，我也愿意认真回应。";
    proposal.targets.working = [workingTargets[0]];
    for (const action of proposal.rowActions.filter((candidate: { source: string }) => candidate.source === "working")) {
      action.action = action.targetId === workingTargets[0].id ? "keep" : "merge";
      action.targetId = workingTargets[0].id;
    }
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    signProposalDirectory({ proposalDir: path.dirname(proposalPath) });
    refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
    const plan = await readJson(path.join(fixture.workspace, "business/migrations/plans/plana.plan.json"));
    expect(plan.replacements.working[0].userIds).toEqual(["12345678", "87654321"]);
    expect(plan.replacements.working[0]).not.toHaveProperty("userId");
    expect(() => dryRunPlans({ workspace: fixture.workspace, planDir: "business/migrations/plans" })).not.toThrow();
  });

  it("rejects malformed mutable metadata and dangling cross-memory references with zero database writes", async () => {
    for (const mutation of [
      (proposal: any) => { proposal.targets.working[0].metadataPatch.set.userIds = [""]; },
      (proposal: any) => { proposal.targets.working[0].metadataPatch.set.eventFingerprint = "bad"; },
      (proposal: any) => { proposal.targets.working[0].metadataPatch.set.longTermId = "missing-long-term"; },
      (proposal: any) => { proposal.targets.long_term[0].metadataPatch.set.sourceWorkingMemoryIds = ["missing-working"]; }
    ]) {
      const fixture = await createFixture();
      await exportGenerateResolve(fixture);
      const before = snapshotMemoryRows(fixture.applicationPaths);
      const proposalPath = path.join(fixture.workspace, "business/migrations/proposals/plana.proposal.json");
      const proposal = await readJson(proposalPath);
      mutation(proposal);
      await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
      let failedDuringSign = false;
      try {
        signProposalDirectory({ proposalDir: path.dirname(proposalPath) });
      } catch {
        failedDuringSign = true;
      }
      if (!failedDuringSign) {
        expect(() => refreshPlans({
          workspace: fixture.workspace,
          proposalDir: "business/migrations/proposals",
          planDir: "business/migrations/plans"
        })).toThrow(/引用不存在|metadata/i);
      }
      expect(snapshotMemoryRows(fixture.applicationPaths)).toEqual(before);
    }
  });

  it("rejects a symlinked data parent before opening or renaming external databases", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    const dataDirectory = path.join(fixture.workspace, "business/agents/arona/data");
    const external = path.join(fixture.root, "external-arona-data");
    await fs.rename(dataDirectory, external);
    const externalApplication = path.join(external, "sunabot.sqlite");
    const before = await fs.readFile(externalApplication);
    await fs.symlink(external, dataDirectory);
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      ...offline
    })).rejects.toThrow(/symlink|符号链接/);
    expect(await fs.readFile(externalApplication)).toEqual(before);
    await expect(fs.stat(path.join(
      fixture.workspace,
      "business/migrations/memory-perspective-v1-quarantine/arona/data"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects staging and quarantine parent symlinks before any rename", async () => {
    for (const kind of ["staging", "quarantine"] as const) {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      const currentApplication = fixture.applicationPaths[1];
      const currentBefore = await fs.readFile(currentApplication);
      const external = path.join(fixture.root, `external-${kind}`);
      await fs.mkdir(external, { recursive: true });
      const sentinel = path.join(external, "sentinel.bin");
      await fs.writeFile(sentinel, Buffer.from("unchanged"));
      if (kind === "staging") {
        const stagedData = path.join(stagingWorkspace, "business/agents/arona/data");
        const moved = path.join(external, "data");
        await fs.rename(stagedData, moved);
        await fs.symlink(moved, stagedData);
      } else {
        const quarantineAgent = path.join(
          fixture.workspace,
          "business/migrations/memory-perspective-v1-quarantine/arona"
        );
        await fs.mkdir(path.dirname(quarantineAgent), { recursive: true });
        await fs.rmdir(quarantineAgent);
        await fs.symlink(external, quarantineAgent);
      }
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        ...offline
      })).rejects.toThrow(/symlink|符号链接|状态无法/);
      expect(await fs.readFile(currentApplication)).toEqual(currentBefore);
      expect(await fs.readFile(sentinel)).toEqual(Buffer.from("unchanged"));
    }
  }, 60_000);

  it("binds and revalidates an existing prepare intent without opening or mutating production SQLite", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    await prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];

    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).resolves.toMatchObject({ state: "prepared" });
    const boundIntent = await fs.readFile(migrationIntentFile(fixture), "utf8");
    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).resolves.toMatchObject({ state: "prepared" });

    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(boundIntent);

    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        afterBackupValidationBeforePrepareIntent: async () => {
          await fs.writeFile(`${fixture.queuePaths[0]}-wal`, Buffer.from("prepared-retry-final-cas"));
        }
      },
      ...offline
    })).rejects.toThrow(/sidecar|WAL|SHM/i);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(boundIntent);
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
  }, 30_000);

  it("rechecks production bytes after backup validation before persisting prepared intent", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    await prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        afterBackupValidationBeforePrepareIntent: async () => {
          await fs.appendFile(fixture.applicationPaths[0], Buffer.from("prepare-final-cas-drift"));
        }
      },
      ...offline
    })).rejects.toThrow(/摘要|绑定|漂移/i);
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("awaiting-backup");
  }, 30_000);

  it("rejects a new production database pair at the final prepare CAS without opening SQLite", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    await prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    let productionAfterExternalDrift: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;
    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        afterBackupValidationBeforePrepareIntent: async () => {
          const orphanData = await addOrphanDatabasePair(fixture.workspace, "prepare-final-orphan");
          productionAfterExternalDrift = await snapshotDirectoryBytes([
            ...fixtureDataDirectories(fixture),
            orphanData
          ]);
        }
      },
      ...offline
    })).rejects.toThrow(/数据库.*集合|集合.*数据库/i);
    expectOnlyRecoveryDatabaseOpens(events, 9);
    expect(productionAfterExternalDrift).not.toBeNull();
    expect(await snapshotDirectoryBytes(productionAfterExternalDrift!.map((entry) => entry.directory)))
      .toEqual(productionAfterExternalDrift);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
  }, 30_000);

  it("rejects a re-signed plan replacement at the final prepare authorization CAS", async () => {
    const fixture = await createFullFixture();
    await exportGenerateResolve(fixture);
    refreshPlans({
      workspace: fixture.workspace,
      proposalDir: "business/migrations/proposals",
      planDir: "business/migrations/plans"
    });
    await prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      ...offline
    });
    const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(prepareMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        afterBackupValidationBeforePrepareIntent: async () => {
          await rewriteSignedPlanReplacement(fixture.workspace, "prepare-plan-drift");
        }
      },
      ...offline
    })).rejects.toThrow(/plan|replacement|intent|绑定/i);
    expectOnlyRecoveryDatabaseOpens(events, 9);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
  }, 30_000);

  it("keeps production zero-open and byte-identical through apply, then makes staged-ready apply a pure-file idempotent path", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "zero-open-staging");
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    let blockedProbe = false;

    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        afterFinalStagingCheckpoint: async ({ databasePaths, probeDatabaseOpen }: {
          databasePaths: string[];
          probeDatabaseOpen: (databasePath: string) => void;
        }) => {
          expect(databasePaths).toHaveLength(8);
          try {
            probeDatabaseOpen(databasePaths[0]);
          } catch (error) {
            expect(error).toMatchObject({ code: "SQLITE_OPEN_FORBIDDEN" });
            blockedProbe = true;
          }
        }
      },
      ...offline
    })).resolves.toMatchObject({ state: "staged-ready" });

    expect(blockedProbe).toBe(true);
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect(events.filter((event) => event.scope === "staging-live" && !event.blocked).length).toBeGreaterThan(0);
    expect(events.filter((event) => event.scope === "staging-live" && event.blocked)).toHaveLength(1);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);

    const finalizedBefore = await snapshotDirectoryBytes(fixtureDataDirectories({
      applicationPaths: fixture.applicationPaths.map((file) => path.join(stagingWorkspace, path.relative(fixture.workspace, file)))
    }));
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const retryEvents: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => retryEvents.push(event),
      ...offline
    })).resolves.toMatchObject({ state: "staged-ready" });
    expect(retryEvents).toHaveLength(18);
    expect(retryEvents.every((event) => event.scope === "recovery" && event.blocked === false)).toBe(true);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
    expect(await snapshotDirectoryBytes(finalizedBefore.map((entry) => entry.directory))).toEqual(finalizedBefore);
  }, 30_000);

  it("resumes after the durable staged-ready boundary without opening production or finalized staging", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "staged-ready-kill-staging");
    expect(runKilledApply(
      fixture.workspace,
      recovery.directory,
      stagingWorkspace,
      "after-staged-ready-intent"
    ).signal).toBe("SIGKILL");
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const stagingDirectories = fixtureDataDirectories({
      applicationPaths: fixture.applicationPaths.map((file) => path.join(stagingWorkspace, path.relative(fixture.workspace, file)))
    });
    const stagingBefore = await snapshotDirectoryBytes(stagingDirectories);
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];

    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).resolves.toMatchObject({ state: "staged-ready" });
    expect(events).toHaveLength(18);
    expect(events.every((event) => event.scope === "recovery" && event.blocked === false)).toBe(true);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    expect(await snapshotDirectoryBytes(stagingDirectories)).toEqual(stagingBefore);
  }, 30_000);

  it("rechecks production bytes immediately before persisting staged-ready intent", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "final-production-cas-staging");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    let productionAfterExternalDrift: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        beforeStagedReadyIntent: async () => {
          await fs.writeFile(`${fixture.applicationPaths[0]}-wal`, Buffer.from("apply-final-cas-sidecar"));
          productionAfterExternalDrift = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
        }
      },
      ...offline
    })).rejects.toThrow(/sidecar|WAL|SHM|staging/i);
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect(productionAfterExternalDrift).not.toBeNull();
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionAfterExternalDrift);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staging-failed");
  }, 30_000);

  it.each(["production", "staging"] as const)(
    "rejects a new %s database pair at the final staged-ready CAS without opening production SQLite",
    async (scope) => {
      const { fixture, recovery } = await prepareBoundFull();
      const stagingWorkspace = path.join(fixture.root, `final-${scope}-set-cas-staging`);
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      let driftSnapshot: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;
      await expect(applyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        backup: recovery.directory,
        stagingWorkspace,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        operationLockHooks: {
          beforeStagedReadyIntent: async () => {
            const targetWorkspace = scope === "production" ? fixture.workspace : stagingWorkspace;
            const orphanData = await addOrphanDatabasePair(targetWorkspace, `apply-final-${scope}-orphan`);
            const knownDirectories = fixtureDataDirectories({
              applicationPaths: fixture.applicationPaths.map((file) => (
                scope === "production" ? file : path.join(stagingWorkspace, path.relative(fixture.workspace, file))
              ))
            });
            driftSnapshot = await snapshotDirectoryBytes([...knownDirectories, orphanData]);
          }
        },
        ...offline
      })).rejects.toThrow(/数据库.*集合|集合.*数据库|staging/i);
      expect(events.filter((event) => event.scope === "production")).toEqual([]);
      expect(driftSnapshot).not.toBeNull();
      expect(await snapshotDirectoryBytes(driftSnapshot!.map((entry) => entry.directory)))
        .toEqual(driftSnapshot);
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("staging-failed");
    },
    60_000
  );

  it("rejects a re-signed prepared replacement before creating or opening staging", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    await rewriteSignedPlanReplacement(fixture.workspace, "apply-plan-drift");
    const stagingWorkspace = path.join(fixture.root, "rejected-plan-drift-staging");
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/plan|replacement|intent|绑定/i);
    expectOnlyRecoveryDatabaseOpens(events, 9);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    await expect(fs.stat(stagingWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
  }, 60_000);

  it.each(["production", "staging"] as const)(
    "rejects a new %s database pair on staged-ready apply retry with zero SQLite open",
    async (scope) => {
      const { fixture, recovery, stagingWorkspace } = await prepareStagedFull();
      const targetWorkspace = scope === "production" ? fixture.workspace : stagingWorkspace;
      const orphanData = await addOrphanDatabasePair(targetWorkspace, `apply-retry-${scope}-orphan`);
      const knownDirectories = fixtureDataDirectories({
        applicationPaths: fixture.applicationPaths.map((file) => (
          scope === "production" ? file : path.join(stagingWorkspace, path.relative(fixture.workspace, file))
        ))
      });
      const driftSnapshot = await snapshotDirectoryBytes([...knownDirectories, orphanData]);
      const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(applyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        backup: recovery.directory,
        stagingWorkspace,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        ...offline
      })).rejects.toThrow(/数据库.*集合|集合.*数据库|未授权安装数据库|安装/i);
      expect(events).toEqual([]);
      expect(await snapshotDirectoryBytes(driftSnapshot.map((entry) => entry.directory))).toEqual(driftSnapshot);
      expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
    },
    60_000
  );

  it("rejects a changed-recovery hardlink to finalized staging before staged-ready apply retry opens recovery SQLite", async () => {
    const { fixture, recovery, stagingWorkspace } = await prepareStagedFull();
    const intent = await readJson(migrationIntentFile(fixture));
    const alias = await hardlinkBoundRecoveryToMatchingLive(
      fixture.workspace,
      intent.changedRecovery,
      stagingWorkspace
    );
    expect(alias.recoveryStat.dev).toBe(alias.liveStat.dev);
    expect(alias.recoveryStat.ino).toBe(alias.liveStat.ino);
    expect(alias.recoveryStat.nlink).toBe(2);
    let recoveryOpenCount = 0;
    await expect(verifyRecoveryPoint(alias.recoveryDirectory, {
      databaseOpenObserver: () => { recoveryOpenCount += 1; }
    })).rejects.toThrow(/hardlink|独立文件|身份/i);
    expect(recoveryOpenCount).toBe(0);

    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const stagingDirectories = fixtureDataDirectories({
      applicationPaths: fixture.applicationPaths.map((file) => (
        path.join(stagingWorkspace, path.relative(fixture.workspace, file))
      ))
    });
    const stagingBefore = await snapshotDirectoryBytes(stagingDirectories);
    const intentBefore = await fs.readFile(migrationIntentFile(fixture), "utf8");
    const quarantineDirectory = path.join(
      fixture.workspace,
      "business/migrations/memory-perspective-v1-quarantine/plana/data"
    );
    await expect(fs.stat(quarantineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/hardlink|独立|身份|link/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    expect(await snapshotDirectoryBytes(stagingDirectories)).toEqual(stagingBefore);
    expect(await fs.readFile(migrationIntentFile(fixture), "utf8")).toBe(intentBefore);
    await expect(fs.stat(quarantineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects a production-to-staging hardlink at the final staged-ready identity CAS", async () => {
    const { fixture, recovery } = await prepareBoundFull();
    const stagingWorkspace = path.join(fixture.root, "final-live-identity-alias-staging");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    let alias: Awaited<ReturnType<typeof hardlinkMatchingLiveDatabase>> | null = null;
    await expect(applyMigration({
      workspace: fixture.workspace,
      planDir: "business/migrations/plans",
      backup: recovery.directory,
      stagingWorkspace,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        beforeStagedReadyIntent: async () => {
          alias = await hardlinkMatchingLiveDatabase(fixture.workspace, stagingWorkspace);
          expect(alias.leftStat.dev).toBe(alias.rightStat.dev);
          expect(alias.leftStat.ino).toBe(alias.rightStat.ino);
          expect(alias.leftStat.nlink).toBe(2);
        }
      },
      ...offline
    })).rejects.toThrow(/独立|身份|link|staging/i);
    expect(alias).not.toBeNull();
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staging-failed");
  }, 60_000);

  it("installs finalized staging without opening either finalized or destination database paths", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    const productionPaths = new Set([...fixture.applicationPaths, ...fixture.queuePaths].map((file) => path.resolve(file)));
    const stagingPaths = new Set([...fixture.applicationPaths, ...fixture.queuePaths].map((file) => (
      path.resolve(stagingWorkspace, path.relative(fixture.workspace, file))
    )));
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).resolves.toMatchObject({ state: "verifying" });
    expect(events.filter((event) => productionPaths.has(event.databasePath))).toEqual([]);
    expect(events.filter((event) => stagingPaths.has(event.databasePath))).toEqual([]);
    expect(events.filter((event) => event.scope === "production")).toEqual([]);
    expect(events.filter((event) => event.scope === "staging-live")).toEqual([]);
  }, 30_000);

  it.each(["main", "sidecar"] as const)(
    "rejects production %s drift before apply staging creation with zero production mutation or SQLite open",
    async (drift) => {
      const { fixture, recovery } = await prepareBoundFull();
      if (drift === "main") {
        await fs.appendFile(fixture.applicationPaths[0], Buffer.from("production-main-drift"));
      } else {
        await fs.writeFile(`${fixture.applicationPaths[0]}-wal`, Buffer.from("production-sidecar-drift"));
      }
      const before = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
      const stagingWorkspace = path.join(fixture.root, `rejected-production-${drift}`);
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(applyMigration({
        workspace: fixture.workspace,
        planDir: "business/migrations/plans",
        backup: recovery.directory,
        stagingWorkspace,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        ...offline
      })).rejects.toThrow(/摘要|sidecar|WAL|SHM|staging|绑定/i);
      expect(events).toEqual([]);
      expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(before);
      await expect(fs.stat(stagingWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    }
  , 60_000);

  it.each(["production", "staging"] as const)(
    "rejects a new %s database pair before the first install rename with zero SQLite open",
    async (scope) => {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      const targetWorkspace = scope === "production" ? fixture.workspace : stagingWorkspace;
      const orphanData = await addOrphanDatabasePair(targetWorkspace, `install-${scope}-orphan`);
      const productionDirectories = fixtureDataDirectories(fixture);
      const stagingDirectories = fixtureDataDirectories({
        applicationPaths: fixture.applicationPaths.map((file) => (
          path.join(stagingWorkspace, path.relative(fixture.workspace, file))
        ))
      });
      const productionSnapshot = await snapshotDirectoryBytes([
        ...productionDirectories,
        ...(scope === "production" ? [orphanData] : [])
      ]);
      const stagingSnapshot = await snapshotDirectoryBytes([
        ...stagingDirectories,
        ...(scope === "staging" ? [orphanData] : [])
      ]);
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        ...offline
      })).rejects.toThrow(/数据库.*集合|集合.*数据库|安装/i);
      expect(events).toEqual([]);
      expect(await snapshotDirectoryBytes(productionSnapshot.map((entry) => entry.directory)))
        .toEqual(productionSnapshot);
      expect(await snapshotDirectoryBytes(stagingSnapshot.map((entry) => entry.directory)))
        .toEqual(stagingSnapshot);
      await expect(fs.stat(path.join(
        fixture.workspace,
        "business/migrations/memory-perspective-v1-quarantine/plana/data"
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
    },
    60_000
  );

  it.each([
    ["changed recovery", "changedRecovery", "staging"],
    ["original recovery", "backup", "production"]
  ] as const)(
    "rejects a %s hardlink alias before the first install rename",
    async (_label, recoveryField, liveScope) => {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      if (recoveryField === "backup") {
        await rewriteBoundRecoveryWithExactLiveFile(
          fixture.workspace,
          recoveryField,
          fixture.workspace
        );
      }
      const intent = await readJson(migrationIntentFile(fixture));
      const liveWorkspace = liveScope === "production" ? fixture.workspace : stagingWorkspace;
      const alias = await hardlinkBoundRecoveryToMatchingLive(
        fixture.workspace,
        intent[recoveryField],
        liveWorkspace
      );
      expect(alias.recoveryStat.dev).toBe(alias.liveStat.dev);
      expect(alias.recoveryStat.ino).toBe(alias.liveStat.ino);
      expect(alias.recoveryStat.nlink).toBe(2);
      const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
      const stagingDirectories = fixtureDataDirectories({
        applicationPaths: fixture.applicationPaths.map((file) => (
          path.join(stagingWorkspace, path.relative(fixture.workspace, file))
        ))
      });
      const stagingBefore = await snapshotDirectoryBytes(stagingDirectories);
      const directoryInodesBefore = await Promise.all([
        ...fixtureDataDirectories(fixture),
        ...stagingDirectories
      ].map(async (directory) => (await fs.stat(directory)).ino));
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        ...offline
      })).rejects.toThrow(/hardlink|独立|身份|link|安装/i);
      expect(events).toEqual([]);
      expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
      expect(await snapshotDirectoryBytes(stagingDirectories)).toEqual(stagingBefore);
      expect(await Promise.all([
        ...fixtureDataDirectories(fixture),
        ...stagingDirectories
      ].map(async (directory) => (await fs.stat(directory)).ino))).toEqual(directoryInodesBefore);
      await expect(fs.stat(path.join(
        fixture.workspace,
        "business/migrations/memory-perspective-v1-quarantine/plana/data"
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
    },
    60_000
  );

  it("rejects a production queue hardlink to finalized staging before the first install rename", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    const alias = await hardlinkMatchingLiveDatabase(
      fixture.workspace,
      stagingWorkspace,
      "business/data/session-queue.sqlite"
    );
    expect(alias.leftStat.dev).toBe(alias.rightStat.dev);
    expect(alias.leftStat.ino).toBe(alias.rightStat.ino);
    expect(alias.leftStat.nlink).toBe(2);
    const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
    const stagingDirectories = fixtureDataDirectories({
      applicationPaths: fixture.applicationPaths.map((file) => (
        path.join(stagingWorkspace, path.relative(fixture.workspace, file))
      ))
    });
    const stagingBefore = await snapshotDirectoryBytes(stagingDirectories);
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/hardlink|独立|身份|link|安装/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
    expect(await snapshotDirectoryBytes(stagingDirectories)).toEqual(stagingBefore);
    await expect(fs.stat(path.join(
      fixture.workspace,
      "business/migrations/memory-perspective-v1-quarantine/plana/data"
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("staged-ready");
  }, 60_000);

  it.each(["main", "sidecar"] as const)(
    "rejects finalized staging %s drift before the first install rename with zero production mutation or SQLite open",
    async (drift) => {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      const stagedApplication = path.join(
        stagingWorkspace,
        path.relative(fixture.workspace, fixture.applicationPaths[0])
      );
      if (drift === "main") {
        await fs.appendFile(stagedApplication, Buffer.from("staging-main-drift"));
      } else {
        await fs.writeFile(`${stagedApplication}-wal`, Buffer.from("staging-sidecar-drift"));
      }
      const productionBefore = await snapshotDirectoryBytes(fixtureDataDirectories(fixture));
      const stagingDirectories = fixtureDataDirectories({
        applicationPaths: fixture.applicationPaths.map((file) => path.join(stagingWorkspace, path.relative(fixture.workspace, file)))
      });
      const stagingBefore = await snapshotDirectoryBytes(stagingDirectories);
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        ...offline
      })).rejects.toThrow(/staging|目录|摘要|sidecar|安装/i);
      expect(events).toEqual([]);
      expect(await snapshotDirectoryBytes(fixtureDataDirectories(fixture))).toEqual(productionBefore);
      expect(await snapshotDirectoryBytes(stagingDirectories)).toEqual(stagingBefore);
      await expect(fs.stat(path.join(
        fixture.workspace,
        "business/migrations/memory-perspective-v1-quarantine/plana/data"
      ))).rejects.toMatchObject({ code: "ENOENT" });
    }
  , 60_000);

  it("rejects an unsigned database pair on install reentry before another directory rename", async () => {
    const { fixture, stagingWorkspace } = await prepareStagedFull();
    expect(runKilledInstall(
      fixture.workspace,
      stagingWorkspace,
      "after-install-quarantine:arona"
    ).signal).toBe("SIGKILL");
    const intent = await readJson(migrationIntentFile(fixture));
    expect(intent.state).toBe("installing");
    const binding = intent.installDirectories.find((candidate: any) => candidate.agentId === "arona");
    if (!binding) throw new Error("install journal 缺少 Arona");
    const orphanData = await addOrphanDatabasePair(fixture.workspace, "install-reentry-orphan");
    const before = await snapshotDirectoryBytes([
      binding.stagedAbsolute,
      binding.quarantineAbsolute,
      orphanData
    ]);
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace,
      confirmReplace: true,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/未授权|数据库.*集合|集合.*数据库|安装/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes([
      binding.stagedAbsolute,
      binding.quarantineAbsolute,
      orphanData
    ])).toEqual(before);
    await expect(fs.stat(binding.currentAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
  }, 60_000);

  it("rechecks the full identity universe immediately before rollback normalize restores quarantine", async () => {
    const { fixture, recovery, stagingWorkspace } = await prepareStagedFull();
    expect(runKilledInstall(
      fixture.workspace,
      stagingWorkspace,
      "after-install-quarantine:arona"
    ).signal).toBe("SIGKILL");
    const intent = await readJson(migrationIntentFile(fixture));
    const binding = intent.installDirectories.find((candidate: any) => candidate.agentId === "arona");
    if (!binding) throw new Error("install journal 缺少 Arona");
    await expect(fs.stat(binding.currentAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
    const rollbackTarget = path.join(fixture.root, "rollback-normalize-final-identity-cas");
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    let eventsAtHook = -1;
    let injected = false;
    let quarantineAfterInjection: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;

    await expect(stageRollback({
      workspace: fixture.workspace,
      backup: recovery.directory,
      targetWorkspace: rollbackTarget,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      operationLockHooks: {
        beforeRollbackNormalizeRename: async (event: { binding: any }) => {
          if (event.binding.agentId !== "arona") return;
          injected = true;
          const manifest = await readJson(path.join(recovery.directory, "manifest.json"));
          const recoveryEntry = manifest.databases.find((candidate: any) => (
            candidate.agentId === "arona" && candidate.kind === "application"
          ));
          if (!recoveryEntry) throw new Error("original recovery 缺少 Arona application");
          const recoveryPath = path.join(recovery.directory, recoveryEntry.file);
          const quarantinePath = path.join(binding.quarantineAbsolute, "sunabot.sqlite");
          await fs.rm(quarantinePath);
          await fs.link(recoveryPath, quarantinePath);
          const [recoveryStat, quarantineStat] = await Promise.all([
            fs.stat(recoveryPath),
            fs.stat(quarantinePath)
          ]);
          expect(recoveryStat.dev).toBe(quarantineStat.dev);
          expect(recoveryStat.ino).toBe(quarantineStat.ino);
          expect(recoveryStat.nlink).toBe(2);
          quarantineAfterInjection = await snapshotDirectoryBytes([binding.quarantineAbsolute]);
          eventsAtHook = events.length;
        }
      },
      ...offline
    })).rejects.toThrow(/hardlink|独立|身份|link|rollback/i);

    expect(injected).toBe(true);
    expect(eventsAtHook).toBeGreaterThanOrEqual(0);
    expect(events.slice(eventsAtHook)).toEqual([]);
    expect(quarantineAfterInjection).not.toBeNull();
    expect(await snapshotDirectoryBytes([binding.quarantineAbsolute])).toEqual(quarantineAfterInjection);
    await expect(fs.stat(binding.currentAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
  }, 60_000);

  it("rejects an unsigned pair beside signed retained quarantine evidence before rollback rename", async () => {
    const { fixture, rollbackStaging } = await prepareRollbackStaged();
    const intent = await readJson(migrationIntentFile(fixture));
    expect(intent.state).toBe("rollback-staged");
    expect(intent.retainedQuarantineDirectories).toHaveLength(4);
    const orphanData = path.join(
      fixture.workspace,
      "business/migrations/memory-perspective-v1-rollback-quarantine/unsigned/data"
    );
    await fs.mkdir(orphanData, { recursive: true });
    await Promise.all([
      fs.copyFile(
        path.join(rollbackStaging, "business/data/sunabot.sqlite"),
        path.join(orphanData, "sunabot.sqlite")
      ),
      fs.copyFile(
        path.join(rollbackStaging, "business/data/session-queue.sqlite"),
        path.join(orphanData, "session-queue.sqlite")
      )
    ]);
    const productionDirectories = fixtureDataDirectories(fixture);
    const rollbackDirectories = fixtureDataDirectories({
      applicationPaths: fixture.applicationPaths.map((file) => (
        path.join(rollbackStaging, path.relative(fixture.workspace, file))
      ))
    });
    const before = await snapshotDirectoryBytes([
      ...productionDirectories,
      ...rollbackDirectories,
      orphanData
    ]);
    const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
    await expect(installStagedMigration({
      workspace: fixture.workspace,
      stagingWorkspace: rollbackStaging,
      confirmReplace: true,
      databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
      ...offline
    })).rejects.toThrow(/未授权|数据库.*集合|集合.*数据库|安装/i);
    expect(events).toEqual([]);
    expect(await snapshotDirectoryBytes([
      ...productionDirectories,
      ...rollbackDirectories,
      orphanData
    ])).toEqual(before);
    expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-staged");
  }, 60_000);

  it.each(["main", "sidecar"] as const)(
    "rejects current %s drift at the final current-to-quarantine CAS without renaming that directory",
    async (drift) => {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      const intent = await readJson(migrationIntentFile(fixture));
      const binding = intent.installDirectories[0];
      if (!binding) throw new Error("install journal 缺少首个目录");
      const productionDirectories = fixtureDataDirectories(fixture);
      const stagingDirectories = fixtureDataDirectories({
        applicationPaths: fixture.applicationPaths.map((file) => (
          path.join(stagingWorkspace, path.relative(fixture.workspace, file))
        ))
      });
      let injected = false;
      let driftSnapshot: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        operationLockHooks: {
          afterInstallIdentityBeforeRename: async (event: { binding: any; phase: string }) => {
            if (injected
              || event.phase !== "current-to-quarantine"
              || event.binding.agentId !== binding.agentId) return;
            injected = true;
            const applicationPath = path.join(binding.currentAbsolute, "sunabot.sqlite");
            if (drift === "main") {
              await fs.appendFile(applicationPath, Buffer.from("current-final-cas-drift"));
            } else {
              await fs.writeFile(`${applicationPath}-wal`, Buffer.from("current-final-cas-sidecar"));
            }
            driftSnapshot = await snapshotDirectoryBytes([
              ...productionDirectories,
              ...stagingDirectories
            ]);
          }
        },
        ...offline
      })).rejects.toThrow(/最终 CAS|发生变化|目录|安装/i);
      expect(injected).toBe(true);
      expectOnlyRecoveryDatabaseOpens(events, 18);
      expect(driftSnapshot).not.toBeNull();
      expect(await snapshotDirectoryBytes([
        ...productionDirectories,
        ...stagingDirectories
      ])).toEqual(driftSnapshot);
      await expect(fs.stat(binding.quarantineAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(binding.currentAbsolute)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
    },
    60_000
  );

  it.each(["main", "sidecar"] as const)(
    "rejects staged %s drift at the final staged-to-current CAS after SIGKILL quarantine",
    async (drift) => {
      const { fixture, stagingWorkspace } = await prepareStagedFull();
      expect(runKilledInstall(
        fixture.workspace,
        stagingWorkspace,
        "after-install-quarantine:arona"
      ).signal).toBe("SIGKILL");
      const intent = await readJson(migrationIntentFile(fixture));
      expect(intent.state).toBe("installing");
      const binding = intent.installDirectories.find((candidate: any) => candidate.agentId === "arona");
      if (!binding) throw new Error("install journal 缺少 Arona");
      let injected = false;
      let driftSnapshot: Awaited<ReturnType<typeof snapshotDirectoryBytes>> | null = null;
      const events: Array<{ databasePath: string; scope: string; blocked: boolean }> = [];
      await expect(installStagedMigration({
        workspace: fixture.workspace,
        stagingWorkspace,
        confirmReplace: true,
        databaseOpenObserver: (event: { databasePath: string; scope: string; blocked: boolean }) => events.push(event),
        operationLockHooks: {
          afterInstallIdentityBeforeRename: async (event: { binding: any; phase: string }) => {
            if (injected
              || event.phase !== "staged-to-current"
              || event.binding.agentId !== "arona") return;
            injected = true;
            const applicationPath = path.join(binding.stagedAbsolute, "sunabot.sqlite");
            if (drift === "main") {
              await fs.appendFile(applicationPath, Buffer.from("staged-final-cas-drift"));
            } else {
              await fs.writeFile(`${applicationPath}-wal`, Buffer.from("staged-final-cas-sidecar"));
            }
            driftSnapshot = await snapshotDirectoryBytes([
              binding.stagedAbsolute,
              binding.quarantineAbsolute
            ]);
          }
        },
        ...offline
      })).rejects.toThrow(/最终 CAS|发生变化|目录|安装/i);
      expect(injected).toBe(true);
      expectOnlyRecoveryDatabaseOpens(events, 18);
      expect(driftSnapshot).not.toBeNull();
      expect(await snapshotDirectoryBytes([
        binding.stagedAbsolute,
        binding.quarantineAbsolute
      ])).toEqual(driftSnapshot);
      await expect(fs.stat(binding.currentAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readJson(migrationIntentFile(fixture))).state).toBe("rollback-required");
    },
    60_000
  );

  it.each([
    "prepare",
    "apply",
    "install",
    "verify",
    "rollback",
    "abort"
  ] as const)("acquires the same operation lock before running %s", async (command) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const owner = await publishTestOperationLock(fixture.workspace, {
      pid: externalTestPid(),
      processIdentity: `test:live-${command}-owner`
    });
    const intentBefore = await fs.readFile(fixture.intentPath, "utf8");
    await expect(invokeMinimalMigrationCommand(command, fixture, {
      processProbe: async (pid: number) => {
        expect(pid).toBe(owner.record.pid);
        return { status: "present", identity: owner.record.processIdentity };
      }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCKED" });
    expect(await fs.readFile(fixture.intentPath, "utf8")).toBe(intentBefore);
    expect(await fs.readFile(owner.lockPath, "utf8")).toBe(owner.raw);
    expect(await fs.readFile(owner.evidencePath, "utf8")).toBe(owner.raw);
  });

  it("publishes a 0600 hard-linked self lock without probing the current process", async () => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    let processProbeCalls = 0;
    let observedEvidencePath = "";
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: {
        processProbe: async () => {
          processProbeCalls += 1;
          throw new Error("current process must not be probed externally");
        },
        afterAcquire: async ({ lockPath, evidencePath }: { lockPath: string; evidencePath: string }) => {
          observedEvidencePath = evidencePath;
          const [canonical, evidence] = await Promise.all([fs.stat(lockPath), fs.stat(evidencePath)]);
          expect(canonical.ino).toBe(evidence.ino);
          expect(canonical.nlink).toBe(2);
          expect(evidence.nlink).toBe(2);
          expect(canonical.mode & 0o777).toBe(0o600);
          expect(evidence.mode & 0o777).toBe(0o600);
        }
      }
    })).resolves.toMatchObject({ ok: true, command: "abort" });
    expect(processProbeCalls).toBe(0);
    expect(observedEvidencePath).toContain(".memory-perspective-v1-operation.");
    await expectNoOperationLockArtifacts(fixture.workspace);
  });

  it("fails closed on an externally live owner and reclaims a PID-reuse mismatch", async () => {
    const live = await createMinimalAbortFixture("awaiting-backup");
    const liveOwner = await publishTestOperationLock(live.workspace, {
      pid: externalTestPid(),
      processIdentity: "test:live-owner"
    });
    await expect(abortMigration({
      workspace: live.workspace,
      ...offline,
      operationLockHooks: {
        processProbe: async (pid: number) => {
          expect(pid).toBe(liveOwner.record.pid);
          return { status: "present", identity: liveOwner.record.processIdentity };
        }
      }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCKED" });
    await expect(fs.readFile(liveOwner.lockPath, "utf8")).resolves.toBe(liveOwner.raw);
    await expect(fs.readFile(liveOwner.evidencePath, "utf8")).resolves.toBe(liveOwner.raw);
    await expect(abortMigration({
      workspace: live.workspace,
      ...offline,
      operationLockHooks: {
        processProbe: async () => ({ status: "present", identity: null })
      }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCKED" });

    const reused = await createMinimalAbortFixture("awaiting-backup");
    const staleOwner = await publishTestOperationLock(reused.workspace, {
      pid: externalTestPid(),
      processIdentity: "test:old-process-start"
    });
    await expect(abortMigration({
      workspace: reused.workspace,
      ...offline,
      operationLockHooks: {
        processProbe: async (pid: number) => {
          expect(pid).toBe(staleOwner.record.pid);
          return { status: "present", identity: "test:new-process-start" };
        }
      }
    })).resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(reused.workspace);
  });

  it("keeps a contender out while a real holder pauses after acquisition", async () => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const readyPath = path.join(fixture.root, "holder-ready");
    const releasePath = path.join(fixture.root, "holder-release");
    const holder = runBarrierAbort(fixture.workspace, readyPath, releasePath);
    let holderResult: Awaited<ReturnType<typeof waitForChild>> | null = null;
    try {
      await waitForPath(readyPath);
      const canonicalPath = operationLockPathForTest(fixture.workspace);
      const holderRecord = JSON.parse(await fs.readFile(canonicalPath, "utf8"));
      const intentBefore = await fs.readFile(fixture.intentPath, "utf8");
      const reportsBefore = (await fs.readdir(path.dirname(fixture.intentPath)))
        .filter((name) => name.includes("-abort-"));
      let probeCalls = 0;
      await expect(abortMigration({
        workspace: fixture.workspace,
        ...offline,
        operationLockHooks: {
          processProbe: async (pid: number) => {
            probeCalls += 1;
            expect(pid).toBe(holderRecord.pid);
            return { status: "present", identity: holderRecord.processIdentity };
          }
        }
      })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCKED" });
      expect(probeCalls).toBe(1);
      expect(await fs.readFile(fixture.intentPath, "utf8")).toBe(intentBefore);
      expect((await fs.readdir(path.dirname(fixture.intentPath)))
        .filter((name) => name.includes("-abort-"))).toEqual(reportsBefore);
    } finally {
      await fs.writeFile(releasePath, "release");
      holderResult = await waitForChild(holder);
    }
    expect(holderResult).toMatchObject({ code: 0, signal: null });
    await expect(fs.stat(fixture.intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  }, 15_000);

  it("reclaims a stale owner and excludes a concurrent claimant after publishing the successor lease", async () => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    await publishTestOperationLock(fixture.workspace, {
      pid: externalTestPid(),
      processIdentity: "test:stale-concurrent-owner"
    });
    let releaseHolder!: () => void;
    let markAcquired!: () => void;
    const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const acquired = new Promise<void>((resolve) => { markAcquired = resolve; });
    const holder = abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: {
        processProbe: async () => ({ status: "absent" }),
        afterAcquire: async () => {
          markAcquired();
          await release;
        }
      }
    });
    try {
      await acquired;
      const successor = JSON.parse(await fs.readFile(operationLockPathForTest(fixture.workspace), "utf8"));
      expect(successor.pid).toBe(process.pid);
      await expect(abortMigration({ workspace: fixture.workspace, ...offline }))
        .rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCKED" });
      await expect(fs.stat(fixture.intentPath)).resolves.toBeTruthy();
    } finally {
      releaseHolder();
    }
    await expect(holder).resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  });

  it.each([
    ["canonical symlink", async (owner: Awaited<ReturnType<typeof publishTestOperationLock>>) => {
      await fs.unlink(owner.lockPath);
      await fs.symlink(path.basename(owner.evidencePath), owner.lockPath);
    }],
    ["evidence symlink", async (owner: Awaited<ReturnType<typeof publishTestOperationLock>>) => {
      await fs.unlink(owner.evidencePath);
      await fs.symlink(path.basename(owner.lockPath), owner.evidencePath);
    }],
    ["wrong mode", async (owner: Awaited<ReturnType<typeof publishTestOperationLock>>) => {
      await fs.chmod(owner.evidencePath, 0o640);
    }],
    ["extra hardlink", async (owner: Awaited<ReturnType<typeof publishTestOperationLock>>) => {
      await fs.link(owner.evidencePath, path.join(path.dirname(owner.evidencePath), "extra-operation-link"));
    }]
  ] as const)("fails closed on operation lock %s", async (_label, mutate) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const owner = await publishTestOperationLock(fixture.workspace, {
      pid: externalTestPid(),
      processIdentity: "test:invalid-artifact-owner"
    });
    await mutate(owner);
    const intentBefore = await fs.readFile(fixture.intentPath, "utf8");
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: { processProbe: async () => ({ status: "absent" }) }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCK_INVALID" });
    expect(await fs.readFile(fixture.intentPath, "utf8")).toBe(intentBefore);
    await expect(fs.stat(fixture.applicationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fixture.queuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["zero-byte", ""],
    ["truncated", "{\"schemaVersion\":1"]
  ] as const)("fails closed on a %s canonical operation-lock record", async (_label, raw) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const artifact = await publishMalformedOperationLock(fixture.workspace, raw);
    const intentBefore = await fs.readFile(fixture.intentPath, "utf8");
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: { processProbe: async () => ({ status: "absent" }) }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCK_INVALID" });
    expect(await fs.readFile(fixture.intentPath, "utf8")).toBe(intentBefore);
    expect(await fs.readFile(artifact.lockPath, "utf8")).toBe(raw);
    expect(await fs.readFile(artifact.evidencePath, "utf8")).toBe(raw);
  });

  it.each([
    "awaiting-backup",
    "prepared",
    "staging-restored",
    "staging-applying",
    "staging-failed",
    "staged-ready"
  ] as const)("aborts PRE state %s without opening SQLite or emitting exact-before recovery fields", async (state) => {
    const fixture = await createMinimalAbortFixture(state);
    await seedMinimalProductionBytes(fixture);
    const productionBefore = await snapshotDirectoryBytes([path.dirname(fixture.applicationPath)]);
    const result = await abortMigration({ workspace: fixture.workspace, ...offline });
    const report = await readJson(path.join(fixture.workspace, result.report));
    expect(report).toMatchObject({ status: "aborted", previousState: state });
    expect(report).not.toHaveProperty("databases");
    expect(report).not.toHaveProperty("manualRecovery");
    expect(report).not.toHaveProperty("manualRecoveryRequired");
    await expect(fs.stat(fixture.intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await snapshotDirectoryBytes([path.dirname(fixture.applicationPath)])).toEqual(productionBefore);
    await expectNoOperationLockArtifacts(fixture.workspace);
  });

  it.each([
    "installing",
    "verifying",
    "rollback-required",
    "rollback-staged",
    "rollback-installing"
  ] as const)("rejects POST state %s abort without touching production or intent", async (state) => {
    const fixture = await createMinimalAbortFixture(state);
    await seedMinimalProductionBytes(fixture);
    const productionBefore = await snapshotDirectoryBytes([path.dirname(fixture.applicationPath)]);
    const intentBefore = await fs.readFile(fixture.intentPath, "utf8");
    await expect(abortMigration({ workspace: fixture.workspace, ...offline }))
      .rejects.toMatchObject({ code: "ABORT_NOT_SAFE" });
    expect(await snapshotDirectoryBytes([path.dirname(fixture.applicationPath)])).toEqual(productionBefore);
    expect(await fs.readFile(fixture.intentPath, "utf8")).toBe(intentBefore);
    expect((await fs.readdir(path.dirname(fixture.intentPath)))
      .filter((name) => /^memory-perspective-v1-abort-[0-9]+\.json$/u.test(name))).toEqual([]);
    await expectNoOperationLockArtifacts(fixture.workspace);
  });

  it("preserves a successor intent replaced immediately before abort deletion", async () => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const originalIntent = await fs.readFile(fixture.intentPath, "utf8");
    let writtenSuccessorIntent = "";
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: {
        beforeAbortIntentDelete: async () => {
          await writeMinimalAbortIntent(fixture, "prepared");
          writtenSuccessorIntent = await fs.readFile(fixture.intentPath, "utf8");
        }
      }
    })).rejects.toMatchObject({ code: "MIGRATION_INTENT_CHANGED" });

    const successorIntent = await fs.readFile(fixture.intentPath, "utf8");
    expect(writtenSuccessorIntent).not.toBe(originalIntent);
    expect(successorIntent).toBe(writtenSuccessorIntent);
    expect(JSON.parse(successorIntent)).toMatchObject({ state: "prepared" });
    const abortReports = (await fs.readdir(path.dirname(fixture.intentPath)))
      .filter((name) => /^memory-perspective-v1-abort-[0-9]+\.json$/u.test(name));
    expect(abortReports).toHaveLength(1);
    await expect(readJson(path.join(path.dirname(fixture.intentPath), abortReports[0])))
      .resolves.toMatchObject({ status: "aborted", previousState: "awaiting-backup" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  });

  it.each([
    "operation-lock:after-evidence-open",
    "operation-lock:after-evidence-write",
    "operation-lock:after-evidence-fsync",
    "operation-lock:after-canonical-link",
    "operation-lock:after-publish-dir-fsync"
  ] as const)("recovers a real SIGKILL at publication point %s", async (point) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    expect(runKilledAbort(fixture.workspace, point).signal).toBe("SIGKILL");
    await expect(fs.stat(fixture.intentPath)).resolves.toBeTruthy();
    await expect(abortMigration({ workspace: fixture.workspace, ...offline }))
      .resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  }, 15_000);

  it.each([
    "operation-lock:before-canonical-claim",
    "operation-lock:after-canonical-claim",
    "operation-lock:after-claim-dir-fsync",
    "operation-lock:after-claim-unlink",
    "operation-lock:after-evidence-unlink"
  ] as const)("recovers a real SIGKILL at release point %s", async (point) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const killed = runKilledAbort(fixture.workspace, point);
    expect(
      killed.signal,
      `status=${killed.status} error=${killed.error?.message ?? ""} stderr=${killed.stderr}`
    ).toBe("SIGKILL");
    await writeMinimalAbortIntent(fixture, "awaiting-backup");
    await expect(abortMigration({ workspace: fixture.workspace, ...offline }))
      .resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  }, 15_000);

  it.each([
    "operation-lock:after-recovery-evidence-fsync",
    "operation-lock:after-recovery-canonical-link",
    "operation-lock:after-recovery-dir-fsync"
  ] as const)("recovers a successor republish after real SIGKILL at %s", async (point) => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    const killed = runKilledSuccessorRecovery(fixture.workspace, point);
    expect(
      killed.signal,
      `status=${killed.status} error=${killed.error?.message ?? ""} stderr=${killed.stderr}`
    ).toBe("SIGKILL");
    await writeMinimalAbortIntent(fixture, "awaiting-backup");
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: { processProbe: async () => ({ status: "absent" }) }
    })).resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  }, 15_000);

  it("republishes a successor captured during release and never unlinks its record", async () => {
    const fixture = await createMinimalAbortFixture("awaiting-backup");
    let successor: Awaited<ReturnType<typeof publishTestOperationLock>> | null = null;
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: {
        faultInjector: async (point: string, context: { lockPath?: string }) => {
          if (point !== "operation-lock:before-canonical-claim" || successor) return;
          expect(await fs.realpath(context.lockPath!)).toBe(
            await fs.realpath(operationLockPathForTest(fixture.workspace))
          );
          await fs.unlink(context.lockPath!);
          successor = await publishTestOperationLock(fixture.workspace, {
            pid: externalTestPid(),
            processIdentity: "test:successor-owner"
          });
        }
      }
    })).rejects.toMatchObject({ code: "MIGRATION_OPERATION_LOCK_CHANGED" });

    expect(successor).not.toBeNull();
    const canonicalPath = operationLockPathForTest(fixture.workspace);
    const canonicalRaw = await fs.readFile(canonicalPath, "utf8");
    expect(canonicalRaw).toBe(successor!.raw);
    const migrationDirectory = path.dirname(canonicalPath);
    const successorEvidence = (await fs.readdir(migrationDirectory))
      .filter((name) => name.endsWith(".recovery.evidence"));
    expect(successorEvidence).toHaveLength(1);
    const [canonicalStat, evidenceStat] = await Promise.all([
      fs.stat(canonicalPath),
      fs.stat(path.join(migrationDirectory, successorEvidence[0]))
    ]);
    expect(canonicalStat.ino).toBe(evidenceStat.ino);
    expect(canonicalStat.nlink).toBe(2);

    await writeMinimalAbortIntent(fixture, "awaiting-backup");
    await expect(abortMigration({
      workspace: fixture.workspace,
      ...offline,
      operationLockHooks: { processProbe: async () => ({ status: "absent" }) }
    })).resolves.toMatchObject({ ok: true, command: "abort" });
    await expectNoOperationLockArtifacts(fixture.workspace);
  });
});

type MinimalAbortFixture = {
  root: string;
  workspace: string;
  intentPath: string;
  applicationPath: string;
  queuePath: string;
};

async function createMinimalAbortFixture(state: string): Promise<MinimalAbortFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-operation-lock-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const migrationDirectory = path.join(workspace, "business/migrations");
  await fs.mkdir(migrationDirectory, { recursive: true, mode: 0o700 });
  const fixture = {
    root,
    workspace,
    intentPath: path.join(migrationDirectory, "memory-perspective-v1-intent.json"),
    applicationPath: path.join(workspace, "business/data/sunabot.sqlite"),
    queuePath: path.join(workspace, "business/data/session-queue.sqlite")
  };
  await writeMinimalAbortIntent(fixture, state);
  return fixture;
}

async function writeMinimalAbortIntent(fixture: MinimalAbortFixture, state: string) {
  const intent = resignTestDocument({
    schemaVersion: 1,
    migrationId: "memory-perspective-v1",
    state,
    planSetSha256: `sha256:${"0".repeat(64)}`,
    agents: [{
      agentId: "plana",
      application: "business/data/sunabot.sqlite",
      queue: "business/data/session-queue.sqlite"
    }],
    committedAgents: [],
    installedDirectories: [],
    failure: null
  }, "intentSha256");
  await fs.writeFile(fixture.intentPath, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
}

async function seedMinimalProductionBytes(fixture: MinimalAbortFixture) {
  await fs.mkdir(path.dirname(fixture.applicationPath), { recursive: true, mode: 0o700 });
  const files = [
    fixture.applicationPath,
    `${fixture.applicationPath}-wal`,
    `${fixture.applicationPath}-shm`,
    fixture.queuePath,
    `${fixture.queuePath}-wal`,
    `${fixture.queuePath}-shm`
  ];
  await Promise.all(files.map((file, index) => fs.writeFile(
    file,
    Buffer.from(`opaque-production-${index}-${path.basename(file)}`)
  )));
}

function invokeMinimalMigrationCommand(
  command: "prepare" | "apply" | "install" | "verify" | "rollback" | "abort",
  fixture: MinimalAbortFixture,
  operationLockHooks: Record<string, unknown>
) {
  const common = { workspace: fixture.workspace, ...offline, operationLockHooks };
  if (command === "prepare") {
    return prepareMigration({ ...common, planDir: "business/migrations/plans" });
  }
  if (command === "apply") {
    return applyMigration({
      ...common,
      planDir: "business/migrations/plans",
      backup: path.join(fixture.root, "backup"),
      stagingWorkspace: path.join(fixture.root, "staging")
    });
  }
  if (command === "install") {
    return installStagedMigration({
      ...common,
      stagingWorkspace: path.join(fixture.root, "staging"),
      confirmReplace: true
    });
  }
  if (command === "verify") {
    return verifyMigration({ ...common, planDir: "business/migrations/plans" });
  }
  if (command === "rollback") {
    return stageRollback({
      ...common,
      backup: path.join(fixture.root, "backup"),
      targetWorkspace: path.join(fixture.root, "rollback-staging")
    });
  }
  return abortMigration(common);
}

function operationLockPathForTest(workspace: string) {
  return path.join(workspace, "business/migrations/memory-perspective-v1-operation.lock");
}

function externalTestPid() {
  return process.pid + 1_000_000;
}

async function publishTestOperationLock(
  workspace: string,
  owner: { pid: number; processIdentity: string }
) {
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const identityDigest = crypto.createHash("sha256").update(owner.processIdentity).digest("hex");
  const record = {
    schemaVersion: 1,
    kind: "memory-perspective-operation-lock",
    migrationId: "memory-perspective-v1",
    pid: owner.pid,
    processIdentity: owner.processIdentity,
    ownerToken
  };
  const raw = `${JSON.stringify(record)}\n`;
  const migrationDirectory = path.join(workspace, "business/migrations");
  const evidencePath = path.join(
    migrationDirectory,
    `.memory-perspective-v1-operation.${owner.pid}.${identityDigest}.${ownerToken}.evidence`
  );
  const lockPath = operationLockPathForTest(workspace);
  await fs.writeFile(evidencePath, raw, { flag: "wx", mode: 0o600 });
  await fs.chmod(evidencePath, 0o600);
  await fs.link(evidencePath, lockPath);
  return { record, raw, evidencePath, lockPath };
}

async function publishMalformedOperationLock(workspace: string, raw: string) {
  const pid = externalTestPid();
  const processIdentity = "test:malformed-owner";
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const identityDigest = crypto.createHash("sha256").update(processIdentity).digest("hex");
  const migrationDirectory = path.join(workspace, "business/migrations");
  const evidencePath = path.join(
    migrationDirectory,
    `.memory-perspective-v1-operation.${pid}.${identityDigest}.${ownerToken}.evidence`
  );
  const lockPath = operationLockPathForTest(workspace);
  await fs.writeFile(evidencePath, raw, { flag: "wx", mode: 0o600 });
  await fs.chmod(evidencePath, 0o600);
  await fs.link(evidencePath, lockPath);
  return { evidencePath, lockPath };
}

async function expectNoOperationLockArtifacts(workspace: string) {
  const migrationDirectory = path.join(workspace, "business/migrations");
  const names = await fs.readdir(migrationDirectory);
  expect(names.filter((name) => (
    name === "memory-perspective-v1-operation.lock"
      || name.startsWith(".memory-perspective-v1-operation.")
  ))).toEqual([]);
}

function runKilledAbort(workspace: string, point: string) {
  const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
  const code = `
    import { abortMigration } from ${JSON.stringify(pathToFileUrl(cli))};
    await abortMigration({
      workspace: ${JSON.stringify(workspace)},
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => false
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
    encoding: "utf8",
    timeout: 10_000
  });
}

function runKilledSuccessorRecovery(workspace: string, point: string) {
  const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
  const code = `
    import crypto from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";
    import { abortMigration } from ${JSON.stringify(pathToFileUrl(cli))};
    let successorPublished = false;
    await abortMigration({
      workspace: ${JSON.stringify(workspace)},
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => false,
      operationLockHooks: {
        faultInjector: async (observedPoint, context) => {
          if (observedPoint !== "operation-lock:before-canonical-claim" || successorPublished) return;
          successorPublished = true;
          fs.unlinkSync(context.lockPath);
          const pid = process.pid + 1_000_000;
          const processIdentity = "test:killed-successor-owner";
          const ownerToken = crypto.randomBytes(32).toString("hex");
          const identityDigest = crypto.createHash("sha256").update(processIdentity).digest("hex");
          const record = {
            schemaVersion: 1,
            kind: "memory-perspective-operation-lock",
            migrationId: "memory-perspective-v1",
            pid,
            processIdentity,
            ownerToken
          };
          const evidencePath = path.join(
            path.dirname(context.lockPath),
            ".memory-perspective-v1-operation." + pid + "." + identityDigest + "." + ownerToken + ".evidence"
          );
          fs.writeFileSync(evidencePath, JSON.stringify(record) + "\\n", { flag: "wx", mode: 0o600 });
          fs.chmodSync(evidencePath, 0o600);
          fs.linkSync(evidencePath, context.lockPath);
        }
      }
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
    encoding: "utf8",
    timeout: 10_000
  });
}

function runBarrierAbort(workspace: string, readyPath: string, releasePath: string) {
  const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
  const code = `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { abortMigration } from ${JSON.stringify(pathToFileUrl(cli))};
    await abortMigration({
      workspace: ${JSON.stringify(workspace)},
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => false,
      operationLockHooks: {
        afterAcquire: async () => {
          fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
          while (!fs.existsSync(${JSON.stringify(releasePath)})) await delay(10);
        }
      }
    });
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForPath(filePath: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitForChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function createFixture(options: { wrapperWorking?: boolean; secondProfileUser?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-perspective-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const applicationPaths: string[] = [];
  const queuePaths: string[] = [];
  for (const agentId of AGENTS) {
    const data = agentId === "plana"
      ? path.join(workspace, "business/data")
      : path.join(workspace, `business/agents/${agentId}/data`);
    await fs.mkdir(data, { recursive: true });
    const application = path.join(data, "sunabot.sqlite");
    const queue = path.join(data, "session-queue.sqlite");
    createApplication(application, agentId, options);
    createQueue(queue);
    applicationPaths.push(application);
    queuePaths.push(queue);
  }
  const defaultDatabase = new DatabaseSync(applicationPaths[0]);
  const insertAgent = defaultDatabase.prepare("INSERT INTO agents(id, name, enabled, workspace) VALUES (?, ?, 1, ?)");
  for (const agentId of AGENTS) insertAgent.run(agentId, agentId, `business/agents/${agentId}`);
  defaultDatabase.close();
  return { root, workspace, applicationPaths, queuePaths };
}

async function createFullFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-perspective-full-")));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const applicationPaths: string[] = [];
  const queuePaths: string[] = [];
  for (const agentId of AGENTS) {
    const data = agentId === "plana"
      ? path.join(workspace, "business/data")
      : path.join(workspace, `business/agents/${agentId}/data`);
    await fs.mkdir(data, { recursive: true });
    const applicationPath = path.join(data, "sunabot.sqlite");
    const store = new ApplicationDataStore(applicationPath);
    store.replaceMemory("working", [{
      id: `working-${agentId}`,
      fact: "旧工作事实",
      userIds: ["12345678"],
      source: "conversation",
      createdAt: "2026-07-01T00:00:00.000Z"
    }]);
    store.replaceMemory("long_term", [{
      id: `long-${agentId}`,
      fact: "旧长期事实",
      userIds: ["12345678"],
      source: "conversation",
      createdAt: "2026-07-01T00:00:00.000Z"
    }]);
    store.replaceMemory("user_profile", [{
      id: `profile-${agentId}`,
      userId: "12345678",
      fact: "旧画像",
      value: "旧画像",
      source: "conversation",
      createdAt: "2026-07-01T00:00:00.000Z"
    }]);
    if (agentId === "plana") {
      for (const child of AGENTS) {
        store.createAgent({
          id: child,
          name: child,
          enabled: true,
          workspace: `workspace://business/agents/${child}`,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z"
        });
      }
    }
    store.close();
    const queuePath = path.join(data, "session-queue.sqlite");
    const queue = new SessionStore({ databasePath: queuePath });
    queue.close();
    applicationPaths.push(applicationPath);
    queuePaths.push(queuePath);
  }
  return { root, workspace, applicationPaths, queuePaths };
}

async function prepareStagedFull() {
  const { fixture, recovery } = await prepareBoundFull();
  const stagingWorkspace = path.join(fixture.root, "staging-workspace");
  const staged = await applyMigration({
    workspace: fixture.workspace,
    planDir: "business/migrations/plans",
    backup: recovery.directory,
    stagingWorkspace,
    ...offline
  });
  return { fixture, recovery, stagingWorkspace, staged };
}

async function prepareBoundFull() {
  const fixture = await createFullFixture();
  await exportGenerateResolve(fixture);
  refreshPlans({ workspace: fixture.workspace, proposalDir: "business/migrations/proposals", planDir: "business/migrations/plans" });
  await prepareMigration({ workspace: fixture.workspace, planDir: "business/migrations/plans", ...offline });
  const recovery = await createRecoveryPoint({ workspace: fixture.workspace, quiesced: true });
  await prepareMigration({
    workspace: fixture.workspace,
    planDir: "business/migrations/plans",
    backup: recovery.directory,
    ...offline
  });
  return { fixture, recovery };
}

async function prepareRollbackStaged() {
  const prepared = await prepareStagedFull();
  await installStagedMigration({
    workspace: prepared.fixture.workspace,
    stagingWorkspace: prepared.stagingWorkspace,
    confirmReplace: true,
    ...offline
  });
  const queue = new SessionStore({ databasePath: prepared.fixture.queuePaths[0] });
  queue.enqueueEvent({
    sessionId: "private:plana:12345678",
    kind: "incoming",
    dedupeKey: `rollback-drift-${Date.now()}`,
    payload: { text: "drift" }
  });
  queue.close();
  await expect(verifyMigration({
    workspace: prepared.fixture.workspace,
    planDir: "business/migrations/plans",
    ...offline
  })).rejects.toThrow();
  const rollbackStaging = path.join(prepared.fixture.root, "rollback-staging");
  await stageRollback({
    workspace: prepared.fixture.workspace,
    backup: prepared.recovery.directory,
    targetWorkspace: rollbackStaging,
    ...offline
  });
  return { ...prepared, rollbackStaging };
}

function pathToFileUrl(file: string) {
  return new URL(`file://${file}`).href;
}

function migrationIntentFile(fixture: { workspace: string }) {
  return path.join(fixture.workspace, "business/migrations/memory-perspective-v1-intent.json");
}

function runKilledInstall(workspace: string, stagingWorkspace: string, point: string) {
  const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
  const code = `
    import { installStagedMigration } from ${JSON.stringify(pathToFileUrl(cli))};
    await installStagedMigration({
      workspace: ${JSON.stringify(workspace)},
      stagingWorkspace: ${JSON.stringify(stagingWorkspace)},
      confirmReplace: true,
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => false
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
    encoding: "utf8"
  });
}

function runKilledApply(
  workspace: string,
  backup: string,
  stagingWorkspace: string,
  point: string
) {
  const cli = path.resolve("tooling/migrations/memory-perspective-v1.mjs");
  const code = `
    import { applyMigration } from ${JSON.stringify(pathToFileUrl(cli))};
    await applyMigration({
      workspace: ${JSON.stringify(workspace)},
      planDir: "business/migrations/plans",
      backup: ${JSON.stringify(backup)},
      stagingWorkspace: ${JSON.stringify(stagingWorkspace)},
      quiesced: true,
      portProbe: async () => false,
      handleProbe: async () => false
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SUNABOT_MEMORY_MIGRATION_FAULT: `sigkill:${point}` },
    encoding: "utf8"
  });
}

async function expectWorkspaceMatchesRecovery(
  fixture: { workspace: string; applicationPaths: string[]; queuePaths: string[] },
  recoveryDirectory: string
) {
  const recovery = await verifyRecoveryPoint(recoveryDirectory);
  const expectedBySource = new Map(await Promise.all(recovery.manifest.databases.map(async (entry) => [
    String(entry.source),
    await fs.readFile(path.join(recovery.directory, String(entry.file)))
  ] as const)));
  const databaseFiles = [...fixture.applicationPaths, ...fixture.queuePaths];
  expect(await Promise.all(databaseFiles.map((file) => fs.readFile(file)))).toEqual(
    databaseFiles.map((file) => expectedBySource.get(
      path.relative(fixture.workspace, file).split(path.sep).join("/")
    ))
  );
}

function createApplication(file: string, agentId: string, options: { wrapperWorking?: boolean; secondProfileUser?: string } = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE memory_records(
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      position INTEGER NOT NULL,
      record_id TEXT,
      data_json TEXT NOT NULL,
      UNIQUE(source, position)
    );
    CREATE TABLE other_state(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, workspace TEXT NOT NULL);
    CREATE TABLE agent_accounts(agent_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(agent_id, account_id));
    INSERT INTO other_state(value) VALUES ('conversation-private');
  `);
  const insert = database.prepare("INSERT INTO memory_records(source, position, record_id, data_json) VALUES (?, ?, ?, ?)");
  const working = {
    id: `working-${agentId}`,
    fact: "旧工作事实",
    userIds: ["12345678"],
    source: "conversation",
    createdAt: "2026-07-01T00:00:00.000Z"
  };
  insert.run("working", 0, working.id, JSON.stringify(options.wrapperWorking ? { recordId: working.id, position: 0, data: working } : working));
  const longTerm = {
    id: `long-${agentId}`,
    fact: "旧长期事实",
    userIds: ["12345678"],
    source: "conversation",
    createdAt: "2026-07-01T00:00:00.000Z"
  };
  insert.run("long_term", 0, longTerm.id, JSON.stringify(longTerm));
  const profile = {
    id: `profile-${agentId}`,
    userId: "12345678",
    fact: "旧画像",
    value: "旧画像",
    source: "conversation",
    createdAt: "2026-07-01T00:00:00.000Z"
  };
  insert.run("user_profile", 0, profile.id, JSON.stringify(profile));
  if (options.secondProfileUser) {
    const second = { ...profile, id: `profile-2-${agentId}`, userId: options.secondProfileUser };
    insert.run("user_profile", 1, second.id, JSON.stringify(second));
  }
  database.close();
}

function createQueue(file: string) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL); INSERT INTO outbox(payload) VALUES ('queue-secret');");
  database.close();
}

async function exportGenerateResolve(fixture: Awaited<ReturnType<typeof createFixture>>, options = {}) {
  exportBaseline({ workspace: fixture.workspace, output: "business/migrations/export.json" });
  generateProposals({
    exportFile: path.join(fixture.workspace, "business/migrations/export.json"),
    proposalDir: path.join(fixture.workspace, "business/migrations/proposals")
  });
  await resolveAllProposals(fixture.workspace, options);
}

async function resolveAllProposals(workspace: string, options: { mergeProfiles?: boolean } = {}) {
  const directory = path.join(workspace, "business/migrations/proposals");
  for (const agentId of AGENTS) {
    const file = path.join(directory, `${agentId}.proposal.json`);
    const proposal = await readJson(file);
    proposal.targets = { working: [], long_term: [], user_profile: [] };
    for (const input of proposal.inputs) {
      const fact = input.source === "working"
        ? "我记得 QQ 12345678 最近的请求，我觉得这件事很重要，我也愿意认真回应让他安心。"
        : input.source === "long_term"
          ? "我记得 QQ 12345678 一直重视可靠回应，我认为这很稳定，我也很在意维持信任。"
          : "我注意到他重视可靠回应，我觉得这是稳定偏好，我也愿意尊重并认真对待。";
      proposal.targets[input.source].push({
        id: input.effectiveId,
        source: input.source,
        baseStableKey: input.stableKey,
        sourceStableKeys: [input.stableKey],
        targetFact: fact,
        metadataPatch: { preserveFromBase: [], set: {}, remove: [] },
        originalSummary: input.originalSummary
      });
      const action = proposal.rowActions.find((candidate: { stableKey: string }) => candidate.stableKey === input.stableKey);
      action.action = "keep";
      action.targetId = input.effectiveId;
      action.reason = "压缩为一条第一人称认知与态度";
    }
    if (options.mergeProfiles && proposal.targets.user_profile.length > 1) {
      const [base, ...rest] = proposal.targets.user_profile;
      base.sourceStableKeys.push(...rest.flatMap((target: { sourceStableKeys: string[] }) => target.sourceStableKeys));
      proposal.targets.user_profile = [base];
      for (const action of proposal.rowActions.filter((candidate: { source: string }) => candidate.source === "user_profile")) {
        action.action = action.targetId === base.id ? "keep" : "merge";
        action.targetId = base.id;
      }
    }
    proposal.unresolved = [];
    proposal.generator = { kind: "codex-reviewed", providerCalled: false, model: null };
    await fs.writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`);
  }
  signProposalDirectory({ proposalDir: directory });
}

async function prepareDuplicateWorkingProposal(options: { otherWorking?: boolean } = {}) {
  const fixture = await createFixture();
  const effectiveId = "working-plana";
  insertWrapperMemory(fixture.applicationPaths[0], "working", effectiveId, "不同的旧包装事实", ["12345678"]);
  if (options.otherWorking) {
    insertMemory(fixture.applicationPaths[0], "working", "other-working", "另一条工作事实", ["12345678"]);
  }
  await exportGenerateResolve(fixture);
  const proposalPath = path.join(fixture.workspace, "business/migrations/proposals/plana.proposal.json");
  const proposal = await readJson(proposalPath);
  const inputs = proposal.inputs.filter((input: { source: string; effectiveId: string }) => (
    input.source === "working" && input.effectiveId === effectiveId
  ));
  const direct = inputs.find((input: { wrapper: boolean }) => !input.wrapper);
  const wrapper = inputs.find((input: { wrapper: boolean }) => input.wrapper);
  if (!direct || !wrapper || inputs.length !== 2) throw new Error("duplicate working test fixture is invalid");
  const target = proposal.targets.working.find((candidate: { baseStableKey: string }) => (
    candidate.baseStableKey === direct.stableKey
  ));
  if (!target) throw new Error("duplicate working direct target is missing");
  target.sourceStableKeys = [direct.stableKey, wrapper.stableKey];
  proposal.targets.working = proposal.targets.working.filter((candidate: { id: string; baseStableKey: string }) => (
    candidate.id !== effectiveId || candidate.baseStableKey === direct.stableKey
  ));
  for (const action of proposal.rowActions.filter((candidate: { stableKey: string }) => (
    candidate.stableKey === direct.stableKey || candidate.stableKey === wrapper.stableKey
  ))) {
    action.action = action.stableKey === direct.stableKey ? "keep" : "merge";
    action.targetId = effectiveId;
  }
  await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  signProposalDirectory({ proposalDir: path.dirname(proposalPath) });
  return {
    fixture,
    effectiveId,
    directStableKey: direct.stableKey,
    wrapperStableKey: wrapper.stableKey
  };
}

function driftEveryRowIdAndPosition(applicationPaths: string[]) {
  for (const file of applicationPaths) {
    const database = new DatabaseSync(file);
    const rows = database.prepare("SELECT row_id, source, position, record_id, data_json FROM memory_records ORDER BY row_id").all();
    database.exec("BEGIN; DELETE FROM memory_records;");
    const insert = database.prepare("INSERT INTO memory_records(row_id, source, position, record_id, data_json) VALUES (?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(Number(row.row_id) + 100, row.source, Number(row.position) + 10, row.record_id, row.data_json);
    database.exec("COMMIT");
    database.close();
  }
}

function insertMemory(file: string, source: string, id: string, fact: string, userIds: string[]) {
  const database = new DatabaseSync(file);
  const position = Number(database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS value FROM memory_records WHERE source = ?").get(source)?.value);
  database.prepare("INSERT INTO memory_records(source, position, record_id, data_json) VALUES (?, ?, ?, ?)")
    .run(source, position, id, JSON.stringify({ id, fact, userIds }));
  database.close();
}

function insertWrapperMemory(file: string, source: string, id: string, fact: string, userIds: string[]) {
  const database = new DatabaseSync(file);
  const position = Number(database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS value FROM memory_records WHERE source = ?").get(source)?.value);
  const data = { id, fact, userIds, source: "conversation", createdAt: "2026-07-02T00:00:00.000Z" };
  database.prepare("INSERT INTO memory_records(source, position, record_id, data_json) VALUES (?, ?, ?, ?)")
    .run(source, position, id, JSON.stringify({ recordId: id, position, data }));
  database.close();
}

function duplicateMemoryRow(file: string, source: string, id: string) {
  const database = new DatabaseSync(file);
  const row = database.prepare("SELECT record_id, data_json FROM memory_records WHERE source = ? AND record_id = ?").get(source, id);
  const position = Number(database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS value FROM memory_records WHERE source = ?").get(source)?.value);
  database.prepare("INSERT INTO memory_records(source, position, record_id, data_json) VALUES (?, ?, ?, ?)")
    .run(source, position, row.record_id, row.data_json);
  database.close();
}

function removeMemoryById(file: string, id: string) {
  const database = new DatabaseSync(file);
  database.prepare("DELETE FROM memory_records WHERE record_id = ?").run(id);
  database.close();
}

function snapshotMemoryRows(files: string[]) {
  return files.map((file) => {
    const database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare("SELECT source, position, record_id, data_json FROM memory_records ORDER BY source, position").all();
    database.close();
    return rows;
  });
}

async function snapshotDirectoryBytes(directories: string[]) {
  return Promise.all(directories.map(async (directory) => ({
    directory,
    files: await Promise.all((await fs.readdir(directory)).sort().map(async (name) => ({
      name,
      bytes: await fs.readFile(path.join(directory, name))
    })))
  })));
}

function fixtureDataDirectories(fixture: { applicationPaths: string[] }) {
  return [...new Set(fixture.applicationPaths.map((file) => path.dirname(file)))].sort();
}

async function addOrphanDatabasePair(workspace: string, agentId: string) {
  const dataDirectory = path.join(workspace, `business/agents/${agentId}/data`);
  await fs.mkdir(dataDirectory, { recursive: true });
  await Promise.all([
    fs.copyFile(
      path.join(workspace, "business/data/sunabot.sqlite"),
      path.join(dataDirectory, "sunabot.sqlite")
    ),
    fs.copyFile(
      path.join(workspace, "business/data/session-queue.sqlite"),
      path.join(dataDirectory, "session-queue.sqlite")
    )
  ]);
  return dataDirectory;
}

async function rewriteSignedPlanReplacement(workspace: string, suffix: string) {
  const planPath = path.join(workspace, "business/migrations/plans/plana.plan.json");
  const plan = await readJson(planPath);
  plan.replacements.working[0].fact = `我记得 QQ 12345678 的请求 ${suffix}，我觉得需要谨慎回应，我也愿意认真处理。`;
  plan.replacementSha256 = testCanonicalSha256(plan.replacements);
  await fs.writeFile(
    planPath,
    `${JSON.stringify(resignTestDocument(plan, "planSha256"), null, 2)}\n`
  );
}

async function hardlinkBoundRecoveryToMatchingLive(
  workspace: string,
  binding: any,
  liveWorkspace: string
) {
  const recoveryDirectory = binding.directoryAbsolute
    ?? path.join(workspace, binding.directory);
  const manifest = await readJson(path.join(recoveryDirectory, "manifest.json"));
  for (const entry of manifest.databases) {
    const livePath = path.join(liveWorkspace, entry.source);
    try {
      if (await sha256FileForTest(livePath) !== entry.sha256) continue;
    } catch {
      continue;
    }
    const recoveryPath = path.join(recoveryDirectory, entry.file);
    await fs.rm(recoveryPath);
    await fs.link(livePath, recoveryPath);
    const [recoveryStat, liveStat] = await Promise.all([
      fs.stat(recoveryPath),
      fs.stat(livePath)
    ]);
    return { recoveryDirectory, recoveryPath, livePath, recoveryStat, liveStat };
  }
  throw new Error("recovery 与 live workspace 中没有物理摘要相同的数据库");
}

async function rewriteBoundRecoveryWithExactLiveFile(
  workspace: string,
  recoveryField: "backup" | "changedRecovery",
  liveWorkspace: string,
  kind: "application" | "session_queue" = "session_queue"
) {
  const intentPath = path.join(
    workspace,
    "business/migrations/memory-perspective-v1-intent.json"
  );
  const intent = await readJson(intentPath);
  const binding = intent[recoveryField];
  const recoveryDirectory = binding.directoryAbsolute
    ?? path.join(workspace, binding.directory);
  const manifestPath = path.join(recoveryDirectory, "manifest.json");
  const checksumPath = path.join(recoveryDirectory, "manifest.sha256");
  const manifest = await readJson(manifestPath);
  const entry = manifest.databases.find((candidate: any) => (
    candidate.agentId === "plana" && candidate.kind === kind
  ));
  if (!entry) throw new Error(`恢复点缺少 Plana ${kind}`);
  const livePath = path.join(liveWorkspace, entry.source);
  const recoveryPath = path.join(recoveryDirectory, entry.file);
  await fs.copyFile(livePath, recoveryPath);
  const stat = await fs.stat(recoveryPath);
  const database = new DatabaseSync(recoveryPath, { readOnly: true });
  entry.bytes = stat.size;
  entry.sha256 = await sha256FileForTest(recoveryPath);
  entry.pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0);
  entry.pageCount = Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0);
  entry.userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  database.close();
  manifest.recoveryPointId = `sha256:${crypto.createHash("sha256").update(JSON.stringify(
    manifest.databases.map((candidate: any) => ({
      id: candidate.id,
      sha256: candidate.sha256,
      tables: candidate.tables,
      invariants: candidate.invariants
    }))
  )).digest("hex")}`;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(manifestPath, manifestBytes);
  await fs.writeFile(
    checksumPath,
    `${crypto.createHash("sha256").update(manifestBytes).digest("hex")}  manifest.json\n`
  );
  await expect(verifyRecoveryPoint(recoveryDirectory)).resolves.toMatchObject({ ok: true });
  binding.recoveryPointId = manifest.recoveryPointId;
  binding.manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  const databaseBinding = binding.databases.find((candidate: any) => candidate.source === entry.source);
  if (!databaseBinding) throw new Error("intent 恢复绑定缺少目标 queue");
  databaseBinding.fileSha256 = entry.sha256;
  intent[recoveryField] = binding;
  await fs.writeFile(
    intentPath,
    `${JSON.stringify(resignTestDocument(intent, "intentSha256"), null, 2)}\n`
  );
}

async function hardlinkMatchingLiveDatabase(
  leftWorkspace: string,
  rightWorkspace: string,
  selectedRelative?: string
) {
  const relativePaths = [
    "business/data/sunabot.sqlite",
    "business/data/session-queue.sqlite",
    ...AGENTS.filter((agentId) => agentId !== "plana").flatMap((agentId) => [
      `business/agents/${agentId}/data/sunabot.sqlite`,
      `business/agents/${agentId}/data/session-queue.sqlite`
    ])
  ];
  const candidates = selectedRelative ? [selectedRelative] : relativePaths;
  for (const relative of candidates) {
    const leftPath = path.join(leftWorkspace, relative);
    const rightPath = path.join(rightWorkspace, relative);
    await fs.rm(rightPath);
    await fs.link(leftPath, rightPath);
    const [leftStat, rightStat] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
    return { leftPath, rightPath, leftStat, rightStat };
  }
  throw new Error("production 与 staging 中没有可用的数据库对");
}

function expectOnlyRecoveryDatabaseOpens(
  events: Array<{ scope: string; blocked: boolean }>,
  expectedCount: number
) {
  expect(events).toHaveLength(expectedCount);
  expect(events.every((event) => event.scope === "recovery" && event.blocked === false)).toBe(true);
}

function testCanonicalSha256(value: unknown) {
  return `sha256:${crypto.createHash("sha256")
    .update(JSON.stringify(canonicalizeTestValue(value)))
    .digest("hex")}`;
}

async function sha256FileForTest(file: string) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function resignTestDocument(document: Record<string, any>, signatureField: string) {
  const output = structuredClone(document);
  delete output[signatureField];
  output[signatureField] = `sha256:${crypto.createHash("sha256")
    .update(JSON.stringify(canonicalizeTestValue(output)))
    .digest("hex")}`;
  return output;
}

function canonicalizeTestValue(value: any): any {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeTestValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeTestValue(value[key])]));
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
