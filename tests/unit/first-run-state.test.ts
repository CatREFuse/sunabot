// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { prepareFreshInstallMarker } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  beginFirstRunBootstrap,
  completeFirstRunBootstrap,
  FIRST_RUN_JOURNAL,
  inspectFirstRunBootstrap,
  rollbackFirstRunBootstrap
} from "../../tooling/runtime/first-run-state.mjs";

const temporaryDirectories: string[] = [];
const crashFixture = fileURLToPath(new URL("../fixtures/first-run-boundary-crash.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("first-run bootstrap journal", () => {
  it("resumes from every persisted boundary until the canonical state is complete", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));

    await writeMainDatabase(workspace, false);
    await expect(completeFirstRunBootstrap(workspace)).resolves.toMatchObject({
      state: "pending",
      missing: expect.arrayContaining(["queue", "manifest", "registration", "account-runtime"])
    });
    writeQueueDatabase(workspace);
    await expect(completeFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "pending" });
    await fs.mkdir(path.join(workspace, "business/agents/plana"), { recursive: true });
    await fs.writeFile(path.join(workspace, "business/agents/plana/agent.json"), `${JSON.stringify(validManifest(), null, 2)}\n`);
    await expect(completeFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "pending" });
    await writeMainDatabase(workspace, true);
    for (const segment of ["config-full", "qq", "plugins"]) {
      await fs.mkdir(path.join(workspace, "runtime/napcat/accounts/primary", segment), { recursive: true });
    }

    await expect(completeFirstRunBootstrap(workspace, new Date("2026-07-14T01:00:00.000Z")))
      .resolves.toMatchObject({ state: "completed" });
    await expect(fs.access(path.join(workspace, FIRST_RUN_JOURNAL))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls a partial bootstrap into a private backup without deleting unknown files", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));
    await writeMainDatabase(workspace, false);
    const unknown = path.join(workspace, "business/agents/plana/files/user-note.txt");
    await fs.mkdir(path.dirname(unknown), { recursive: true });
    await fs.writeFile(unknown, "preserve\n");

    const result = await rollbackFirstRunBootstrap(workspace, new Date("2026-07-14T02:00:00.000Z"));

    expect(result).toMatchObject({ state: "rolled-back" });
    await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(result.backup!, "business/agents/plana/files/user-note.txt"), "utf8"))
      .resolves.toBe("preserve\n");
    await expect(inspectFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "inactive" });
    await expect(beginFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "active" });
  });

  it("resumes rollback after a rename completed before the journal was updated", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));
    const source = path.join(workspace, "business/agents/plana");
    const backup = path.join(workspace, "backups/first-run-rollback/20260714T000000000Z");
    const destination = path.join(backup, "business/agents/plana");
    await fs.mkdir(path.join(source, "files"), { recursive: true });
    await fs.writeFile(path.join(source, "files/user-note.txt"), "preserve\n");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);

    const result = await rollbackFirstRunBootstrap(workspace, new Date("2026-07-14T02:00:00.000Z"));

    expect(result).toMatchObject({ state: "rolled-back", backup });
    expect(result.moved).toContain("business/agents/plana");
    await expect(fs.readFile(path.join(destination, "files/user-note.txt"), "utf8")).resolves.toBe("preserve\n");
  });

  it.each(["marker", "main", "queue", "manifest", "registration", "account-runtime"])(
    "rolls back safely after the %s boundary",
    async (boundary) => {
      const workspace = await freshWorkspace();
      await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));
      await materializeBoundary(workspace, boundary);
      const unknown = path.join(workspace, "business/user-note.txt");
      await fs.writeFile(unknown, "preserve\n");

      await expect(inspectFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "active" });
      const result = await rollbackFirstRunBootstrap(workspace, new Date("2026-07-14T02:00:00.000Z"));

      expect(result).toMatchObject({ state: "rolled-back" });
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("preserve\n");
      await expect(inspectFirstRunBootstrap(workspace)).resolves.toMatchObject({ state: "inactive" });
    }
  );

  it("rejects a modified journal before using it as resume authority", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace);
    const journalPath = path.join(workspace, FIRST_RUN_JOURNAL);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.startedAt = "2026-07-14T03:00:00.000Z";
    await fs.writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    await expect(inspectFirstRunBootstrap(workspace)).rejects.toMatchObject({ code: "FIRST_RUN_JOURNAL_INVALID" });
  });

  it("reports malformed journal JSON as a journal integrity failure", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace);
    await fs.writeFile(path.join(workspace, FIRST_RUN_JOURNAL), "{\n");

    await expect(inspectFirstRunBootstrap(workspace)).rejects.toMatchObject({ code: "FIRST_RUN_JOURNAL_INVALID" });
  });

  it("rejects corrupt SQLite, invalid manifests, and escaping account paths before completion", async () => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace);
    await writeMainDatabase(workspace, true);
    await fs.writeFile(path.join(workspace, "business/data/session-queue.sqlite"), "not sqlite");
    await fs.mkdir(path.join(workspace, "business/agents/plana"), { recursive: true });
    await fs.writeFile(path.join(workspace, "business/agents/plana/agent.json"), "{}\n");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-first-run-outside-"));
    temporaryDirectories.push(outside);
    const accountRoot = path.join(workspace, "runtime/napcat/accounts/primary");
    await fs.mkdir(accountRoot, { recursive: true });
    for (const segment of ["config-full", "qq", "plugins"]) {
      const target = path.join(outside, segment);
      await fs.mkdir(target);
      await fs.symlink(target, path.join(accountRoot, segment), "dir");
    }

    await expect(completeFirstRunBootstrap(workspace)).rejects.toMatchObject({
      code: "FIRST_RUN_BOUNDARY_INVALID"
    });
  });

  it("rejects a workspace reached through a symlinked parent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-first-run-parent-"));
    temporaryDirectories.push(root);
    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    const realWorkspace = path.join(realParent, "workspace");
    await fs.mkdir(realWorkspace, { recursive: true });
    await fs.symlink(realParent, linkedParent, "dir");

    await expect(beginFirstRunBootstrap(path.join(linkedParent, "workspace"))).rejects.toMatchObject({
      code: "FIRST_RUN_PATH_INVALID"
    });
  });

  it.each([
    {
      label: "stale main schema version",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.prepare("UPDATE app_metadata SET value = '8' WHERE key = 'storage-schema-version'").run();
        database.close();
      }
    },
    {
      label: "future main schema version",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.prepare("UPDATE app_metadata SET value = '17' WHERE key = 'storage-schema-version'").run();
        database.close();
      }
    },
    {
      label: "missing main schema index",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP INDEX agent_accounts_agent");
        database.close();
      }
    },
    {
      label: "missing group thread state table",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP TABLE conversation_thread_states");
        database.close();
      }
    },
    {
      label: "missing emojis table",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP TABLE emojis");
        database.close();
      }
    },
    {
      label: "missing emoji versions table",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP TABLE emoji_versions");
        database.close();
      }
    },
    {
      label: "missing scheduled tasks table",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP TABLE scheduled_tasks");
        database.close();
      }
    },
    {
      label: "missing scheduled task runs index",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"));
        database.exec("DROP INDEX scheduled_task_runs_status");
        database.close();
      }
    },
    {
      label: "stale queue schema version",
      mutate(workspace: string) {
        const database = new DatabaseSync(path.join(workspace, "business/data/session-queue.sqlite"));
        database.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
        database.close();
      }
    },
    ...[
      "hold_state",
      "mutation_fingerprint",
      "hold_provenance_json",
      "release_provenance_json"
    ].map((column) => ({
      label: `missing queue v5 column ${column}`,
      mutate(workspace: string) {
        mutateQueueSchema(workspace, `ALTER TABLE outbox RENAME COLUMN ${column} TO missing_${column}`);
      }
    })),
    ...[
      "outbox_partition_claim_idx",
      "outbox_partition_sequence_idx",
      "outbox_hold_claim_idx"
    ].map((index) => ({
      label: `missing queue v5 index ${index}`,
      mutate(workspace: string) {
        mutateQueueSchema(workspace, `DROP INDEX ${index}`);
      }
    })),
    {
      label: "queue held claim index without hold state",
      mutate(workspace: string) {
        mutateQueueSchema(workspace, `
          DROP INDEX outbox_hold_claim_idx;
          CREATE INDEX outbox_hold_claim_idx
            ON outbox(delivery_state, available_at, session_id, sequence);
        `);
      }
    }
  ])("rejects $label before completing first-run", async ({ mutate }) => {
    const workspace = await freshWorkspace();
    await beginFirstRunBootstrap(workspace);
    await materializeBoundary(workspace, "account-runtime");
    mutate(workspace);

    await expect(completeFirstRunBootstrap(workspace)).rejects.toMatchObject({
      code: "FIRST_RUN_BOUNDARY_INVALID"
    });
  });

  it.each(["marker", "main", "queue", "manifest", "registration", "account-runtime"])(
    "resumes and rolls back after a real SIGKILL at the %s boundary",
    async (boundary) => {
      const resumeWorkspace = await freshWorkspace();
      await killBoundaryWriter(resumeWorkspace, boundary);
      await expect(inspectFirstRunBootstrap(resumeWorkspace)).resolves.toMatchObject({ state: "active" });
      await finishAllBoundaries(resumeWorkspace);
      await expect(completeFirstRunBootstrap(resumeWorkspace)).resolves.toMatchObject({ state: "completed" });

      const rollbackWorkspace = await freshWorkspace();
      await killBoundaryWriter(rollbackWorkspace, boundary);
      await expect(inspectFirstRunBootstrap(rollbackWorkspace)).resolves.toMatchObject({ state: "active" });
      await expect(rollbackFirstRunBootstrap(rollbackWorkspace)).resolves.toMatchObject({ state: "rolled-back" });
      await expect(fs.readFile(path.join(rollbackWorkspace, "business/user-note.txt"), "utf8"))
        .resolves.toBe("preserve\n");
    },
    30_000
  );
});

async function freshWorkspace() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-first-run-")));
  temporaryDirectories.push(workspace);
  await prepareFreshInstallMarker(workspace);
  await fs.mkdir(path.join(workspace, "business/data"), { recursive: true });
  return workspace;
}

async function writeMainDatabase(workspace: string, complete: boolean) {
  const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
  await fs.rm(databasePath, { force: true });
  const store = new ApplicationDataStore(databasePath);
  store.checkpoint();
  store.close();
  const database = new DatabaseSync(databasePath);
  try {
    if (complete) {
      database.exec(`
        INSERT INTO agents(id, name, enabled, workspace, created_at, updated_at)
        VALUES ('plana', '普拉娜', 1, 'workspace/business/agents/plana', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
        INSERT INTO agent_accounts(id, agent_id, label, enabled, webui_port, created_at, updated_at)
        VALUES ('primary', 'plana', '主账号', 1, 6099, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
      `);
    }
  } finally {
    database.close();
  }
}

async function materializeBoundary(workspace: string, boundary: string) {
  const order = ["marker", "main", "queue", "manifest", "registration", "account-runtime"];
  const reached = (name: string) => order.indexOf(boundary) >= order.indexOf(name);
  if (reached("main")) await writeMainDatabase(workspace, reached("registration"));
  if (reached("queue")) writeQueueDatabase(workspace);
  if (reached("manifest")) {
    await fs.mkdir(path.join(workspace, "business/agents/plana"), { recursive: true });
    await fs.writeFile(path.join(workspace, "business/agents/plana/agent.json"), `${JSON.stringify(validManifest(), null, 2)}\n`);
  }
  if (reached("account-runtime")) {
    for (const segment of ["config-full", "qq", "plugins"]) {
      await fs.mkdir(path.join(workspace, "runtime/napcat/accounts/primary", segment), { recursive: true });
    }
  }
}

async function finishAllBoundaries(workspace: string) {
  const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
  const store = new ApplicationDataStore(databasePath);
  store.checkpoint();
  store.close();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      INSERT OR IGNORE INTO agents(id, name, enabled, workspace, created_at, updated_at)
      VALUES ('plana', '普拉娜', 1, 'workspace/business/agents/plana', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
      INSERT OR IGNORE INTO agent_accounts(id, agent_id, label, enabled, webui_port, created_at, updated_at)
      VALUES ('primary', 'plana', '主账号', 1, 6099, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
    `);
  } finally {
    database.close();
  }
  writeQueueDatabase(workspace);
  await fs.mkdir(path.join(workspace, "business/agents/plana"), { recursive: true });
  await fs.writeFile(path.join(workspace, "business/agents/plana/agent.json"), `${JSON.stringify(validManifest(), null, 2)}\n`);
  for (const segment of ["config-full", "qq", "plugins"]) {
    await fs.mkdir(path.join(workspace, "runtime/napcat/accounts/primary", segment), { recursive: true });
  }
}

function killBoundaryWriter(workspace: string, boundary: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", crashFixture, workspace, boundary], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" }
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`first-run boundary fixture timed out: ${boundary}\n${stdout}\n${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!killed && stdout.includes(`SUNABOT_FIRST_RUN_BOUNDARY_DURABLE=${boundary}`)) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killed && code === null && signal === "SIGKILL") resolve();
      else reject(new Error(`first-run boundary fixture exited unexpectedly: ${boundary} code=${code} signal=${signal}\n${stdout}\n${stderr}`));
    });
  });
}

function writeQueueDatabase(workspace: string) {
  const store = new SessionStore({
    databasePath: path.join(workspace, "business/data/session-queue.sqlite")
  });
  store.close();
}

function mutateQueueSchema(workspace: string, sql: string) {
  const database = new DatabaseSync(path.join(workspace, "business/data/session-queue.sqlite"));
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function validManifest() {
  return {
    schemaVersion: 1,
    id: "plana",
    name: "普拉娜",
    enabled: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    prompts: { overrideSystem: false },
    bot: {},
    onebot: {}
  };
}
