import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import { beginFirstRunBootstrap } from "../../tooling/runtime/first-run-state.mjs";

const workspace = process.argv[2];
const boundary = process.argv[3];
const boundaries = ["marker", "main", "queue", "manifest", "registration", "account-runtime"];
if (!path.isAbsolute(workspace) || !boundaries.includes(boundary)) {
  throw new Error("first-run crash fixture requires an absolute workspace and a valid boundary");
}

await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));
const reached = (name: string) => boundaries.indexOf(boundary) >= boundaries.indexOf(name);
if (reached("main")) ensureMainDatabase(workspace, reached("registration"));
if (reached("queue")) ensureQueueDatabase(workspace);
if (reached("manifest")) await ensureManifest(workspace);
if (reached("account-runtime")) await ensureAccountRuntime(workspace);
await fs.writeFile(path.join(workspace, "business/user-note.txt"), "preserve\n");
await new Promise<void>((resolve, reject) => {
  process.stdout.write(`SUNABOT_FIRST_RUN_BOUNDARY_DURABLE=${boundary}\n`, (error) => error ? reject(error) : resolve());
});
await new Promise(() => undefined);

function ensureMainDatabase(workspaceRoot: string, registered: boolean) {
  const databasePath = path.join(workspaceRoot, "business/data/sunabot.sqlite");
  const store = new ApplicationDataStore(databasePath);
  store.checkpoint();
  store.close();
  if (!registered) return;
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
}

function ensureQueueDatabase(workspaceRoot: string) {
  const store = new SessionStore({
    databasePath: path.join(workspaceRoot, "business/data/session-queue.sqlite")
  });
  store.close();
}

async function ensureManifest(workspaceRoot: string) {
  const directory = path.join(workspaceRoot, "business/agents/plana");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "agent.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "plana",
    name: "普拉娜",
    enabled: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    prompts: { overrideSystem: false },
    bot: {},
    onebot: {}
  }, null, 2)}\n`);
}

async function ensureAccountRuntime(workspaceRoot: string) {
  for (const segment of ["config-full", "qq", "plugins"]) {
    await fs.mkdir(path.join(workspaceRoot, "runtime/napcat/accounts/primary", segment), { recursive: true });
  }
}
