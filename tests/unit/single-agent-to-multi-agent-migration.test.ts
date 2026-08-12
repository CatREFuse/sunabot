// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  inspectSingleAgentMigration,
  migrateSingleAgentToMultiAgent,
  workspaceContainerListArgs
} from "../../tooling/migrations/migrate-single-agent-to-multi-agent.mjs";
import {
  inspectMultiAgentMigrationGate,
  MULTI_AGENT_MIGRATION_MARKER,
  prepareFreshInstallMarker
} from "../../packages/platform/multiAgentMigrationGate.mjs";
import { verifyRecoveryPoint } from "../../tooling/workspace/sqlite-recovery.mjs";

const temporaryDirectories: string[] = [];
const systemPromptFiles = [
  "conversation_reply.json",
  "conversation_private_reply.json",
  "conversation_group_reply.json",
  "work_memory_compress_out.json",
  "user_groupchat_orchestrator.json",
  "group_chat_summary.json"
];
const agentPromptFiles = ["selfie_prompt_rewrite.json"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("single Agent to multi-Agent migration", () => {
  it("performs a read-only dry-run and reports the Plana/primary migration plan", async () => {
    const fixture = await createSingleAgentFixture();

    const result = await migrateSingleAgentToMultiAgent({ workspace: fixture.workspace });

    expect(result).toMatchObject({
      ok: true,
      mode: "dry-run",
      state: "ready",
      target: { agentId: "plana", accountId: "primary", webuiPort: 6099 },
      checks: {
        registryReady: false,
        manifestReady: false,
        primaryQqIdentityDetected: true,
        systemPromptsReady: false,
        migrationMarkerReady: false
      }
    });
    await expect(fs.access(path.join(fixture.workspace, "business/agents/plana/agent.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(fixture.workspace, "backups/sqlite-recovery")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a verified recovery point, preserves records and copies legacy NapCat state idempotently", async () => {
    const fixture = await createSingleAgentFixture();
    const now = new Date("2026-07-13T10:00:00.000Z");
    const first = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now,
      initialize: initializeFixture
    });

    expect(first).toMatchObject({
      ok: true,
      mode: "applied",
      state: "already-migrated",
      target: { agentId: "plana", accountId: "primary" }
    });
    expect((await verifyRecoveryPoint(first.recoveryPoint)).ok).toBe(true);
    const report = JSON.parse(await fs.readFile(first.reportPath, "utf8"));
    expect(report).toMatchObject({
      status: "completed",
      copiedRuntimeEntries: expect.arrayContaining([
        expect.objectContaining({
          destination: "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json",
          kind: "file"
        })
      ]),
      copiedSystemPrompts: expect.arrayContaining([
        expect.objectContaining({ destination: "business/prompts/conversation_reply.json" })
      ]),
      preservedRuntimeDivergences: [],
      preservedSystemPromptDivergences: [],
      verification: {
        mainIntegrity: "ok",
        queueIntegrity: "ok",
        runtimeHashes: "ok",
        systemPromptHashes: "ok"
      }
    });
    expect(await inspectMultiAgentMigrationGate(fixture.workspace)).toMatchObject({
      state: "trusted",
      marker: {
        schemaVersion: 1,
        kind: "completed-migration",
        recoveryPointId: path.basename(first.recoveryPoint),
        target: {
          agentId: "plana",
          agentWorkspace: "workspace/business/agents/plana",
          accountId: "primary",
          webuiPort: 6099
        }
      }
    });
    expect(report.preservedCounts.before.main.conversations).toBe(1);
    expect(report.preservedCounts.after.main.conversations).toBe(1);
    await expect(fs.readFile(path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"
    ), "utf8")).resolves.toBe("legacy-onebot\n");
    await expect(fs.readFile(path.join(
      fixture.workspace,
      "runtime/napcat/config-full/onebot11_123456789.json"
    ), "utf8")).resolves.toBe("legacy-onebot\n");
    await expect(fs.readFile(path.join(
      fixture.workspace,
      "business/prompts/conversation_reply.json"
    ), "utf8")).resolves.toBe("legacy:conversation_reply.json\n");
    await expect(fs.readFile(path.join(
      fixture.workspace,
      "business/agents/plana/selfie_prompt_rewrite.json"
    ), "utf8")).resolves.toBe("legacy:selfie_prompt_rewrite.json\n");
    await expect(fs.access(path.join(
      fixture.workspace,
      "business/prompts/selfie_prompt_rewrite.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const database = new DatabaseSync(fixture.mainDatabasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT id FROM agents").get()).toMatchObject({ id: "plana" });
      expect(database.prepare("SELECT id, agent_id, qq_id FROM agent_accounts").get())
        .toMatchObject({ id: "primary", agent_id: "plana", qq_id: "123456789" });
    } finally {
      database.close();
    }
    await expect(fs.readFile(path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/account.env"
    ), "utf8")).resolves.toBe("NAPCAT_ACCOUNT=123456789\n");

    await write(path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"
    ), "current-generated-onebot\n");
    const second = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      initialize: initializeFixture
    });
    expect(second).toMatchObject({ ok: true, mode: "already-migrated" });
    const recoveryDirectories = (await fs.readdir(path.join(fixture.workspace, "backups/sqlite-recovery")))
      .filter((name) => name.startsWith("sqlite-recovery-"));
    expect(recoveryDirectories).toHaveLength(1);
  });

  it("requires an explicit quiesced recovery point before sealing an unmarked current structure", async () => {
    const fixture = await createSingleAgentFixture();
    const first = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    await fs.rm(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER));
    const currentPrompt = path.join(fixture.workspace, "business/prompts/group_chat_summary.json");
    await fs.writeFile(currentPrompt, "current shared prompt\n", "utf8");
    const missingPrompt = path.join(fixture.workspace, "business/prompts/conversation_reply.json");
    await fs.rm(missingPrompt);
    const currentRuntime = path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"
    );
    await fs.writeFile(currentRuntime, "current generated onebot\n", "utf8");

    await expect(inspectSingleAgentMigration(fixture.workspace)).resolves.toMatchObject({
      state: "ready",
      checks: { migrationMarkerReady: false }
    });
    await expect(migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      allowRoot: true,
      skipServiceCheck: true,
      initialize: async () => undefined
    })).rejects.toMatchObject({ code: "QUIESCENCE_REQUIRED" });

    const sealed = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T11:00:00.000Z"),
      initialize: async () => undefined
    });
    expect(sealed).toMatchObject({
      ok: true,
      mode: "applied",
      state: "already-migrated",
      checks: { migrationMarkerReady: true }
    });
    expect(first.recoveryPoint).not.toBe(sealed.recoveryPoint);
    await expect(fs.readFile(currentPrompt, "utf8")).resolves.toBe("current shared prompt\n");
    const report = JSON.parse(await fs.readFile(sealed.reportPath, "utf8"));
    expect(report.copiedRuntimeEntries).toEqual([]);
    expect(report.copiedSystemPrompts).toEqual([
      expect.objectContaining({ destination: "business/prompts/conversation_reply.json" })
    ]);
    expect(report.preservedRuntimeDivergences).toEqual([
      {
        source: "runtime/napcat/config-full/onebot11_123456789.json",
        destination: "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json",
        sourceKind: "file",
        sourceSha256: sha256Text("legacy-onebot\n"),
        destinationKind: "file",
        destinationSha256: sha256Text("current generated onebot\n")
      }
    ]);
    expect(report.preservedSystemPromptDivergences).toEqual([
      expect.objectContaining({ destination: "business/prompts/group_chat_summary.json" })
    ]);
  });

  it("refuses to seal when a preserved primary runtime divergence changes during apply", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    await fs.rm(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER));
    const currentRuntime = path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"
    );
    await fs.writeFile(currentRuntime, "preserved before apply\n", "utf8");

    await expect(migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T11:00:00.000Z"),
      initialize: async () => {
        await fs.writeFile(currentRuntime, "changed during apply\n", "utf8");
      }
    })).rejects.toMatchObject({ code: "PRESERVED_RUNTIME_CHANGED" });
    await expect(fs.access(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses divergent public prompts while migrating a legacy single-Agent structure", async () => {
    const fixture = await createSingleAgentFixture();
    await write(
      path.join(fixture.workspace, "business/prompts/conversation_reply.json"),
      "unexpected public prompt\n"
    );

    await expect(inspectSingleAgentMigration(fixture.workspace)).rejects.toMatchObject({
      code: "SYSTEM_PROMPT_TARGET_CONFLICT"
    });
  });

  it("copies the legacy reply prompt into both scoped reply prompts", async () => {
    const fixture = await createSingleAgentFixture();
    await Promise.all(["conversation_private_reply.json", "conversation_group_reply.json"].map((fileName) => (
      fs.rm(path.join(fixture.workspace, "business/agents/plana", fileName))
    )));

    const result = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });

    for (const fileName of ["conversation_private_reply.json", "conversation_group_reply.json"]) {
      await expect(fs.readFile(path.join(fixture.workspace, "business/prompts", fileName), "utf8"))
        .resolves.toBe("legacy:conversation_reply.json\n");
    }
    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
    expect(report.copiedSystemPrompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: "business/prompts/conversation_private_reply.json" }),
      expect.objectContaining({ destination: "business/prompts/conversation_group_reply.json" })
    ]));
  });

  it("rejects a symbolic link in a configured system prompt path", async () => {
    const fixture = await createSingleAgentFixture();
    const configPath = path.join(fixture.workspace, "business/config/sunabot.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.bot = {
      memory: { workMemoryCompressOutPrompt: "nested/compress.json" }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await write(
      path.join(fixture.workspace, "business/agents/plana/nested/compress.json"),
      "legacy nested prompt\n"
    );
    const external = path.join(fixture.root, "external-prompts");
    await fs.mkdir(external, { recursive: true });
    await fs.mkdir(path.join(fixture.workspace, "business/prompts"), { recursive: true });
    await fs.symlink(external, path.join(fixture.workspace, "business/prompts/nested"), "dir");

    await expect(inspectSingleAgentMigration(fixture.workspace)).rejects.toMatchObject({
      code: "MIGRATION_PATH_INVALID"
    });
    await expect(fs.access(path.join(external, "compress.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a completed marker when the registered migration target is missing", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    const database = new DatabaseSync(fixture.mainDatabasePath);
    try {
      database.prepare("DELETE FROM agent_accounts WHERE id = ?").run("primary");
    } finally {
      database.close();
    }

    await expect(inspectMultiAgentMigrationGate(fixture.workspace)).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
    });
  });

  it("rejects a completed marker when another registered Agent is incomplete", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    await addSecondaryRegistration(fixture.workspace);

    await expect(inspectMultiAgentMigrationGate(fixture.workspace)).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
    });
  });

  it("rejects a completed marker when the Agent workspace or primary WebUI port drifts", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    const database = new DatabaseSync(fixture.mainDatabasePath);
    try {
      database.prepare("UPDATE agents SET workspace = ? WHERE id = ?")
        .run("workspace/business/agents/other", "plana");
      await expect(inspectMultiAgentMigrationGate(fixture.workspace)).rejects.toMatchObject({
        code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
      });

      database.prepare("UPDATE agents SET workspace = ? WHERE id = ?")
        .run("workspace/business/agents/plana", "plana");
      database.prepare("UPDATE agent_accounts SET webui_port = ? WHERE id = ?").run(6101, "primary");
      await expect(inspectMultiAgentMigrationGate(fixture.workspace)).rejects.toMatchObject({
        code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
      });
    } finally {
      database.close();
    }
  });

  it("validates every registered Agent and QQ runtime for fresh and migrated workspaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-multi-agent-gate-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await prepareFreshInstallMarker(workspace, new Date("2026-07-13T09:00:00.000Z"));
    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({ state: "trusted" });

    const mainDatabasePath = path.join(workspace, "business/data/sunabot.sqlite");
    const store = new ApplicationDataStore(mainDatabasePath);
    store.close();
    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
    });

    await createRegisteredAgentState(workspace, { includePlana: true });
    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({ state: "trusted" });

    await addSecondaryRegistration(workspace);
    await fs.mkdir(path.join(workspace, "business/agents/arona"), { recursive: true });
    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toThrow(/agent\.json/);
    await writeAgentManifest(workspace, "arona", "阿罗娜");
    await fs.mkdir(path.join(workspace, "business/agents/arona/data"), { recursive: true });
    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toThrow(/data\/sunabot\.sqlite/);
    await createAgentDatabases(workspace, "arona");
    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toThrow(/runtime\/napcat\/accounts\/secondary/);

    const externalRuntime = path.join(root, "secondary-runtime");
    await Promise.all(["config-full", "qq", "plugins"].map((segment) => (
      fs.mkdir(path.join(externalRuntime, segment), { recursive: true })
    )));
    const accountRoot = path.join(workspace, "runtime/napcat/accounts/secondary");
    await fs.symlink(externalRuntime, accountRoot, "dir");
    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
    });
    await fs.rm(accountRoot);
    await Promise.all(["config-full", "qq", "plugins"].map((segment) => (
      fs.mkdir(path.join(accountRoot, segment), { recursive: true })
    )));
    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({ state: "trusted" });

    const database = new DatabaseSync(mainDatabasePath);
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("CREATE TABLE agent_accounts_unchecked AS SELECT * FROM agent_accounts");
      database.exec("DROP TABLE agent_accounts");
      database.exec("ALTER TABLE agent_accounts_unchecked RENAME TO agent_accounts");
      database.prepare("UPDATE agent_accounts SET webui_port = 6099 WHERE id = 'secondary'").run();
      await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toMatchObject({
        code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
      });
      database.prepare("UPDATE agent_accounts SET webui_port = 6100 WHERE id = 'secondary'").run();
    } finally {
      database.close();
    }
    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({ state: "trusted" });
  });

  it("accepts a trusted fresh-install marker through the controlled /tmp alias", async () => {
    const workspace = await fs.mkdtemp("/tmp/sunabot-multi-agent-alias-");
    temporaryDirectories.push(workspace);

    await prepareFreshInstallMarker(workspace, new Date("2026-07-13T09:00:00.000Z"));

    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({
      state: "trusted",
      workspace
    });
  });

  it("refuses to write a completed marker when a registered secondary workspace is incomplete", async () => {
    const fixture = await createSingleAgentFixture();
    await initializeFixture({ workspace: fixture.workspace });
    await addSecondaryRegistration(fixture.workspace);
    await createAgentDatabases(fixture.workspace, "arona");

    await expect(migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: async () => undefined
    })).rejects.toMatchObject({ code: "MULTI_AGENT_MIGRATION_STATE_INVALID" });
    await expect(fs.access(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a completed marker when a required state path traverses a symbolic link", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    const accountsPath = path.join(fixture.workspace, "runtime/napcat/accounts");
    const movedAccountsPath = path.join(fixture.root, "accounts-moved");
    await fs.rename(accountsPath, movedAccountsPath);
    await fs.symlink(movedAccountsPath, accountsPath, "dir");

    await expect(inspectMultiAgentMigrationGate(fixture.workspace)).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_STATE_INVALID"
    });
  });

  it("requires quiescence and refuses divergent primary runtime files", async () => {
    const fixture = await createSingleAgentFixture();
    await expect(migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      allowRoot: true,
      skipServiceCheck: true,
      initialize: initializeFixture
    })).rejects.toMatchObject({ code: "QUIESCENCE_REQUIRED" });

    await write(path.join(
      fixture.workspace,
      "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"
    ), "different\n");
    await expect(inspectSingleAgentMigration(fixture.workspace))
      .rejects.toMatchObject({ code: "MIGRATION_TARGET_CONFLICT" });
  });

  it("refuses to seal an unmarked current workspace while a secondary account port is listening", async () => {
    const fixture = await createSingleAgentFixture();
    const first = await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试监听端口无效。");
      const database = new DatabaseSync(fixture.mainDatabasePath);
      try {
        database.prepare(`
          INSERT INTO agent_accounts(id, agent_id, label, enabled, webui_port, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
        `).run(
          "secondary",
          "plana",
          "备用账号",
          address.port,
          "2026-07-13T10:30:00.000Z",
          "2026-07-13T10:30:00.000Z"
        );
      } finally {
        database.close();
      }
      await fs.rm(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER));

      await expect(migrateSingleAgentToMultiAgent({
        workspace: fixture.workspace,
        apply: true,
        quiesced: true,
        allowRoot: true,
        initialize: async () => undefined
      })).rejects.toMatchObject({ code: "SERVICE_RUNNING" });
      const recoveryDirectories = (await fs.readdir(path.dirname(first.recoveryPoint)))
        .filter((name) => name.startsWith("sqlite-recovery-"));
      expect(recoveryDirectories).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refuses to seal an unmarked current workspace while a labeled runtime container is running", async () => {
    const fixture = await createSingleAgentFixture();
    await migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true,
      now: new Date("2026-07-13T10:00:00.000Z"),
      initialize: initializeFixture
    });
    await fs.rm(path.join(fixture.workspace, MULTI_AGENT_MIGRATION_MARKER));

    await expect(migrateSingleAgentToMultiAgent({
      workspace: fixture.workspace,
      apply: true,
      quiesced: true,
      allowRoot: true,
      initialize: async () => undefined,
      listRunningContainers: async () => ["container-123"]
    })).rejects.toMatchObject({ code: "SERVICE_RUNNING" });
  });

  it("inspects every active workspace container state before migration", () => {
    const args = workspaceContainerListArgs("/tmp/sunabot-workspace");
    expect(args).toContainEqual(expect.stringMatching(/^label=io\.sunabot\.workspace-id=/));
    expect(args).not.toContain("status=running");
    expect(args[0]).toBe("ps");
  });

  it("routes older workspace layouts to their prerequisite migration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-legacy-layout-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await write(path.join(workspace, "config/sunabot.json"), "{}\n");
    await write(path.join(workspace, "artifacts/sunabot.sqlite"), "legacy");

    await expect(inspectSingleAgentMigration(workspace))
      .rejects.toMatchObject({ code: "WORKSPACE_LAYOUT_MIGRATION_REQUIRED" });
  });

  it("rejects values attached to boolean CLI flags", () => {
    const cli = fileURLToPath(new URL(
      "../../tooling/migrations/migrate-single-agent-to-multi-agent.mjs",
      import.meta.url
    ));
    const result = spawnSync(process.execPath, [cli, "--apply", "yes"], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "ARGUMENT_INVALID" });
  });

  it("rejects the retired external main database override before migration", async () => {
    const fixture = await createSingleAgentFixture();
    const previous = process.env.SUNABOT_DATABASE_PATH;
    process.env.SUNABOT_DATABASE_PATH = path.join(fixture.root, "external.sqlite");
    try {
      await expect(migrateSingleAgentToMultiAgent({ workspace: fixture.workspace }))
        .rejects.toMatchObject({ code: "CUSTOM_DATABASE_PATH_UNSUPPORTED" });
    } finally {
      if (previous == null) delete process.env.SUNABOT_DATABASE_PATH;
      else process.env.SUNABOT_DATABASE_PATH = previous;
    }
  });

  it("validates the workspace before rejecting an external main database override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-missing-workspace-"));
    temporaryDirectories.push(root);
    const previous = process.env.SUNABOT_DATABASE_PATH;
    process.env.SUNABOT_DATABASE_PATH = path.join(root, "external.sqlite");
    try {
      await expect(migrateSingleAgentToMultiAgent({ workspace: path.join(root, "workspace") }))
        .rejects.toMatchObject({ code: "WORKSPACE_MISSING" });
    } finally {
      if (previous == null) delete process.env.SUNABOT_DATABASE_PATH;
      else process.env.SUNABOT_DATABASE_PATH = previous;
    }
  });

  it("rejects a symbolic-link workspace parent before migration writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-parent-link-"));
    temporaryDirectories.push(root);
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-external-"));
    temporaryDirectories.push(external);
    const linkedParent = path.join(root, "linked-parent");
    await fs.symlink(external, linkedParent, "dir");

    await expect(migrateSingleAgentToMultiAgent({
      workspace: path.join(linkedParent, "workspace"),
      apply: true,
      quiesced: true,
      allowRoot: true,
      skipServiceCheck: true
    })).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });

    await expect(fs.readdir(external)).resolves.toEqual([]);
  });

  it("rejects the runtime.env database override before database prerequisites", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-database-override-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await write(
      path.join(workspace, "secrets/runtime.env"),
      "SUNABOT_DATABASE_PATH=/tmp/external.sqlite\n"
    );

    await expect(migrateSingleAgentToMultiAgent({ workspace }))
      .rejects.toMatchObject({ code: "CUSTOM_DATABASE_PATH_UNSUPPORTED" });
  });
});

async function createSingleAgentFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-agent-migration-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const mainDatabasePath = path.join(workspace, "business/data/sunabot.sqlite");
  const queueDatabasePath = path.join(workspace, "business/data/session-queue.sqlite");
  await write(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
    server: { host: "127.0.0.1", port: 19_877 },
    persona: {
      name: "普拉娜",
      agentWorkspace: "workspace/business/agents/plana",
      memoryLimit: 32
    }
  }));
  await write(path.join(workspace, "business/agents/plana/AGENTS.md"), "legacy Plana\n");
  await Promise.all([...systemPromptFiles, ...agentPromptFiles].map((fileName) => write(
    path.join(workspace, "business/agents/plana", fileName),
    `legacy:${fileName}\n`
  )));
  await write(path.join(workspace, "secrets/runtime.env"), "NAPCAT_ACCOUNT=123456789\n");
  await write(path.join(
    workspace,
    "runtime/napcat/config-full/onebot11_123456789.json"
  ), "legacy-onebot\n");
  await write(path.join(workspace, "runtime/napcat/qq/session.dat"), "legacy-login\n");

  const main = new ApplicationDataStore(mainDatabasePath);
  main.replaceConversations([{
    id: "private:171419991",
    lastAt: "2026-07-13T09:00:00.000Z",
    messages: []
  }]);
  main.close();
  const legacyMain = new DatabaseSync(mainDatabasePath);
  legacyMain.exec("PRAGMA foreign_keys=OFF; DROP TABLE agent_accounts; DROP TABLE agents;");
  legacyMain.close();

  const queue = new SessionStore({ databasePath: queueDatabasePath });
  queue.enqueueEvent({
    sessionId: "private:171419991",
    kind: "incoming",
    dedupeKey: "onebot:single-agent-migration",
    payload: { text: "preserve me" }
  });
  queue.close();
  return { root, workspace, mainDatabasePath, queueDatabasePath };
}

async function initializeFixture({ workspace }: { workspace: string }) {
  const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        workspace TEXT NOT NULL UNIQUE,
        avatar_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_accounts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        label TEXT NOT NULL,
        qq_id TEXT,
        enabled INTEGER NOT NULL,
        webui_port INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, label),
        UNIQUE (qq_id)
      );
    `);
    const createdAt = "2026-07-13T10:00:00.000Z";
    database.prepare(`
      INSERT INTO agents(id, name, enabled, workspace, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run("plana", "普拉娜", "workspace/business/agents/plana", createdAt, createdAt);
    database.prepare(`
      INSERT INTO agent_accounts(id, agent_id, label, enabled, webui_port, created_at, updated_at)
      VALUES (?, ?, ?, 1, 6099, ?, ?)
    `).run("primary", "plana", "主账号", createdAt, createdAt);
  } finally {
    database.close();
  }

  await write(path.join(workspace, "business/agents/plana/agent.json"), JSON.stringify({
    schemaVersion: 1,
    id: "plana",
    name: "普拉娜",
    enabled: true,
    persona: { memoryLimit: 32 },
    prompts: { overrideSystem: false },
    bot: {},
    onebot: {},
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:00.000Z"
  }));
  const primaryRoot = path.join(workspace, "runtime/napcat/accounts/primary");
  await Promise.all(["config-full", "qq", "plugins"].map((name) => (
    fs.mkdir(path.join(primaryRoot, name), { recursive: true })
  )));
  await fs.cp(
    path.join(workspace, "runtime/napcat/config-full"),
    path.join(primaryRoot, "config-full"),
    { recursive: true, force: false }
  );
  await fs.cp(
    path.join(workspace, "runtime/napcat/qq"),
    path.join(primaryRoot, "qq"),
    { recursive: true, force: false }
  );
}

async function createRegisteredAgentState(workspace: string, options: { includePlana?: boolean } = {}) {
  const queue = new SessionStore({
    databasePath: path.join(workspace, "business/data/session-queue.sqlite")
  });
  queue.close();
  if (!options.includePlana) return;
  const store = new ApplicationDataStore(path.join(workspace, "business/data/sunabot.sqlite"));
  const createdAt = "2026-07-13T09:00:00.000Z";
  store.createAgent({
    id: "plana",
    name: "普拉娜",
    enabled: true,
    workspace: "workspace/business/agents/plana",
    createdAt,
    updatedAt: createdAt
  });
  store.createAgentAccount({
    id: "primary",
    agentId: "plana",
    label: "主账号",
    enabled: true,
    webuiPort: 6099,
    createdAt,
    updatedAt: createdAt
  });
  store.close();
  await writeAgentManifest(workspace, "plana", "普拉娜");
  await Promise.all(["config-full", "qq", "plugins"].map((segment) => (
    fs.mkdir(path.join(workspace, "runtime/napcat/accounts/primary", segment), { recursive: true })
  )));
}

async function addSecondaryRegistration(workspace: string) {
  const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
  try {
    const createdAt = "2026-07-13T09:30:00.000Z";
    database.prepare(`
      INSERT INTO agents(id, name, enabled, workspace, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run("arona", "阿罗娜", "workspace/business/agents/arona", createdAt, createdAt);
    database.prepare(`
      INSERT INTO agent_accounts(id, agent_id, label, enabled, webui_port, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run("secondary", "arona", "阿罗娜账号", 6100, createdAt, createdAt);
  } finally {
    database.close();
  }
}

async function writeAgentManifest(workspace: string, id: string, name: string) {
  await write(path.join(workspace, "business/agents", id, "agent.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name
  }));
}

async function createAgentDatabases(workspace: string, agentId: string) {
  const dataRoot = path.join(workspace, "business/agents", agentId, "data");
  const store = new ApplicationDataStore(path.join(dataRoot, "sunabot.sqlite"));
  store.close();
  const queue = new SessionStore({ databasePath: path.join(dataRoot, "session-queue.sqlite") });
  queue.close();
}

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function sha256Text(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
