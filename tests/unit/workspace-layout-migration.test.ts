// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateWorkspaceLayout } from "../../tooling/migrations/migrate-workspace-layout.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("workspace layout migration", () => {
  it("backs up and moves legacy business, runtime, secret and cache state idempotently", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-"));
    temporaryDirectories.push(workspace);
    await write(path.join(workspace, ".env"), "ONEBOT_ACCESS_TOKEN=test-only\n");
    await write(path.join(workspace, "config/sunabot.json"), JSON.stringify({
      server: { port: 19_877 },
      persona: { agentWorkspace: "workspace/agents/plana" },
      providers: { items: [{ envFile: "workspace/.env" }] }
    }));
    await write(path.join(workspace, "agents/plana/AGENTS.md"), "test agent\n");
    await write(path.join(workspace, "artifacts/images/test.png"), "not-a-real-image");
    await write(path.join(workspace, "artifacts/file-cache/cache-key/source.txt"), "cache");
    await write(path.join(workspace, "security/admin-credentials.json"), "{}\n");
    await write(path.join(workspace, "napcat/config-full/webui.json"), "{}\n");
    await write(path.join(workspace, "napcat/cache/qrcode.png"), "legacy-qr");
    await createDatabase(path.join(workspace, "artifacts/sunabot.sqlite"));
    await createDatabase(path.join(workspace, "artifacts/session-queue.sqlite"));

    const first = await migrateWorkspaceLayout({
      workspace,
      skipServiceCheck: true,
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });

    expect(first.migrated).toBe(true);
    await expect(fs.readFile(path.join(workspace, "business/agents/plana/AGENTS.md"), "utf8"))
      .resolves.toBe("test agent\n");
    await expect(fs.readFile(path.join(workspace, "secrets/runtime.env"), "utf8"))
      .resolves.toContain("ONEBOT_ACCESS_TOKEN");
    await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, "business/data/session-queue.sqlite"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, "runtime/napcat/config-full/webui.json"))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(workspace, "runtime/napcat/qrcode.png"), "utf8"))
      .resolves.toBe("legacy-qr");
    await expect(fs.access(path.join(workspace, "runtime/napcat/cache/qrcode.png")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(workspace, "cache/attachments/cache-key/source.txt"))).resolves.toBeUndefined();
    const config = JSON.parse(await fs.readFile(path.join(workspace, "business/config/sunabot.json"), "utf8"));
    expect(config.persona.agentWorkspace).toBe("workspace/business/agents/plana");
    expect(config.providers.items[0].envFile).toBe("workspace/secrets/runtime.env");
    const manifest = JSON.parse(await fs.readFile(path.join(first.backup!.directory, "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.files.some((file: { path: string }) => file.path === "artifacts/sunabot.sqlite")).toBe(true);
    expect(manifest.files.some((file: { path: string }) => file.path === ".env")).toBe(true);
    expect(manifest.files.some((file: { path: string }) => file.path === "security/admin-credentials.json")).toBe(true);
    expect(manifest.files.some((file: { path: string }) => file.path === "napcat/config-full/webui.json")).toBe(true);
    expect(manifest.moves).toContainEqual(expect.objectContaining({
      source: ".env",
      target: "secrets/runtime.env",
      type: "file",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sensitive: true
    }));
    expect((await fs.stat(first.backup!.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(first.backup!.directory, ".env"))).mode & 0o777).toBe(0o600);
    expect(first.marker.backupManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.readFile(path.join(first.backup!.directory, "manifest.sha256"), "utf8"))
      .resolves.toContain(first.marker.backupManifestSha256);

    const second = await migrateWorkspaceLayout({ workspace, skipServiceCheck: true });
    expect(second.migrated).toBe(false);
    expect(second.backup).toBeUndefined();
  });

  it("refuses divergent destination data instead of overwriting it", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-conflict-"));
    temporaryDirectories.push(workspace);
    await write(path.join(workspace, ".env"), "OLD=value\n");
    await write(path.join(workspace, "secrets/runtime.env"), "NEW=value\n");

    await expect(migrateWorkspaceLayout({ workspace, skipServiceCheck: true }))
      .rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_CONFLICT" });
    await expect(fs.readFile(path.join(workspace, ".env"), "utf8")).resolves.toBe("OLD=value\n");
    await expect(fs.readFile(path.join(workspace, "secrets/runtime.env"), "utf8")).resolves.toBe("NEW=value\n");
  });

  it("restores the complete legacy layout after an injected failure in staged publish or source removal", async () => {
    for (const failureStep of ["after-target-publish:.env", "after-source-remove:.env"]) {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-rollback-"));
      temporaryDirectories.push(workspace);
      await write(path.join(workspace, ".env"), "ONEBOT_ACCESS_TOKEN=rollback-test\n");
      await write(path.join(workspace, "config/sunabot.json"), JSON.stringify({
        persona: { agentWorkspace: "workspace/agents/plana" },
        providers: { items: [{ envFile: "workspace/.env" }] }
      }));
      await write(path.join(workspace, "napcat/cache/qrcode.png"), "legacy-qr");

      await expect(migrateWorkspaceLayout({
        workspace,
        skipServiceCheck: true,
        faultInjector(step: string) {
          if (step === failureStep) throw Object.assign(new Error(`fault:${step}`), { code: "INJECTED_FAILURE" });
        }
      })).rejects.toMatchObject({ code: "INJECTED_FAILURE" });

      await expect(fs.readFile(path.join(workspace, ".env"), "utf8"))
        .resolves.toBe("ONEBOT_ACCESS_TOKEN=rollback-test\n");
      await expect(fs.readFile(path.join(workspace, "config/sunabot.json"), "utf8"))
        .resolves.toContain("workspace/agents/plana");
      await expect(fs.readFile(path.join(workspace, "napcat/cache/qrcode.png"), "utf8"))
        .resolves.toBe("legacy-qr");
      await expect(fs.access(path.join(workspace, "secrets/runtime.env"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(workspace, "runtime/napcat/qrcode.png"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects symbolic links before creating a recovery package", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-symlink-"));
    temporaryDirectories.push(workspace);
    await write(path.join(workspace, "outside.txt"), "outside\n");
    await fs.mkdir(path.join(workspace, "security", "codex"), { recursive: true });
    await fs.symlink(path.join(workspace, "outside.txt"), path.join(workspace, "security", "codex", "linked-secret"));

    await expect(migrateWorkspaceLayout({ workspace, skipServiceCheck: true }))
      .rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_PATH_INVALID" });
    await expect(fs.access(path.join(workspace, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a durable journal to recover a kill after source removal and clears a stale PID lock", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-kill-"));
    temporaryDirectories.push(workspace);
    await write(path.join(workspace, ".env"), "ONEBOT_ACCESS_TOKEN=kill-test\n");
    await write(path.join(workspace, "config/sunabot.json"), JSON.stringify({
      persona: { agentWorkspace: "workspace/agents/plana" },
      providers: { items: [{ envFile: "workspace/.env" }] }
    }));

    await expect(migrateWorkspaceLayout({
      workspace,
      skipServiceCheck: true,
      faultInjector(step: string) {
        if (step === "after-source-remove:.env") {
          throw Object.assign(new Error("simulated SIGKILL"), { code: "SIMULATED_KILL", preserveIntent: true });
        }
      }
    })).rejects.toMatchObject({ code: "SIMULATED_KILL" });
    await expect(fs.access(path.join(workspace, ".workspace-layout-v1.intent.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(workspace, ".workspace-layout-v1.lock"), JSON.stringify({ pid: 999_999 }));
    const resumed = await migrateWorkspaceLayout({ workspace, skipServiceCheck: true });
    expect(resumed.migrated).toBe(true);
    await expect(fs.readFile(path.join(workspace, "secrets/runtime.env"), "utf8"))
      .resolves.toBe("ONEBOT_ACCESS_TOKEN=kill-test\n");
    await expect(fs.access(path.join(workspace, ".workspace-layout-v1.intent.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["backups", "secrets"])("rejects a symbolic-link %s parent before writing outside workspace", async (segment) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-parent-symlink-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await write(path.join(workspace, ".env"), "ONEBOT_ACCESS_TOKEN=parent-symlink-test\n");
    await fs.symlink(outside, path.join(workspace, segment));

    await expect(migrateWorkspaceLayout({ workspace, skipServiceCheck: true }))
      .rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_PATH_INVALID" });
    expect(await fs.readdir(outside)).toEqual([]);
    await expect(fs.readFile(path.join(workspace, ".env"), "utf8"))
      .resolves.toBe("ONEBOT_ACCESS_TOKEN=parent-symlink-test\n");
  });

  it("preserves an unknown replacement instead of deleting it during ordinary rollback", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-unknown-target-"));
    temporaryDirectories.push(workspace);
    const destination = path.join(workspace, "secrets/runtime.env");
    await write(path.join(workspace, ".env"), "ONEBOT_ACCESS_TOKEN=known\n");

    await expect(migrateWorkspaceLayout({
      workspace,
      skipServiceCheck: true,
      async faultInjector(step: string) {
        if (step !== "after-target-publish:.env") return;
        await fs.writeFile(destination, "UNKNOWN=value\n", "utf8");
        throw Object.assign(new Error("unknown replacement"), { code: "INJECTED_FAILURE" });
      }
    })).rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_ROLLBACK_CONFLICT" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("UNKNOWN=value\n");
    await expect(fs.readFile(path.join(workspace, ".env"), "utf8"))
      .resolves.toBe("ONEBOT_ACCESS_TOKEN=known\n");
  });

  it("restores a pre-existing identical config target after rewrite and later failure", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-existing-config-"));
    temporaryDirectories.push(workspace);
    const legacyConfig = `${JSON.stringify({
      persona: { agentWorkspace: "workspace/agents/plana" },
      providers: { items: [{ envFile: "workspace/.env" }] }
    }, null, 2)}\n`;
    await write(path.join(workspace, "config/sunabot.json"), legacyConfig);
    await write(path.join(workspace, "business/config/sunabot.json"), legacyConfig);
    await write(path.join(workspace, "business/data/sunabot.sqlite"), "invalid database");

    await expect(migrateWorkspaceLayout({ workspace, skipServiceCheck: true })).rejects.toThrow();
    await expect(fs.readFile(path.join(workspace, "business/config/sunabot.json"), "utf8"))
      .resolves.toBe(legacyConfig);
    await expect(fs.readFile(path.join(workspace, "config/sunabot.json"), "utf8"))
      .resolves.toBe(legacyConfig);
  });

  it("fails closed while a legacy database has an active write transaction", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-layout-busy-"));
    temporaryDirectories.push(workspace);
    const databasePath = path.join(workspace, "artifacts/sunabot.sqlite");
    await createDatabase(databasePath);
    const writer = new DatabaseSync(databasePath, { timeout: 20 });
    writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO smoke(value) VALUES ('active-write');");
    try {
      await expect(migrateWorkspaceLayout({
        workspace,
        skipServiceCheck: true,
        databaseBusyTimeoutMs: 20
      })).rejects.toMatchObject({ code: "WORKSPACE_DATABASE_BUSY" });
      await expect(fs.access(databasePath)).resolves.toBeUndefined();
      await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function createDatabase(filePath: string) {
  return fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => {
    const database = new DatabaseSync(filePath);
    database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO smoke(value) VALUES ('ok');");
    database.close();
  });
}
