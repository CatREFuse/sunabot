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
    expect(manifest.files.some((file: { path: string }) => file.path === "artifacts/sunabot.sqlite")).toBe(true);

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
