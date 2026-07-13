// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MULTI_AGENT_MIGRATION_MARKER } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { initializeWorkspace } from "../../tooling/workspace/init-workspace.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("workspace initialization", () => {
  it("creates the current layout with private directory and secret permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "ONEBOT_ACCESS_TOKEN=\n", "utf8");

    const result = await initializeWorkspace({ root, workspace });

    expect(result.workspace).toBe(workspace);
    await expect(fs.access(path.join(workspace, "business/agents/plana/selfie"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, "runtime/napcat/accounts"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, "runtime/napcat/config-full"))).rejects.toMatchObject({ code: "ENOENT" });
    const marker = JSON.parse(await fs.readFile(path.join(workspace, MULTI_AGENT_MIGRATION_MARKER), "utf8"));
    expect(marker).toMatchObject({ schemaVersion: 1, kind: "fresh-install", initialWorkspaceState: "empty" });
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "business"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "runtime"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(result.runtimeEnv)).mode & 0o777).toBe(0o600);
  });

  it("preserves existing runtime secrets while repairing their permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-existing-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const runtimeEnv = path.join(workspace, "secrets/runtime.env");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "EXAMPLE=1\n", "utf8");
    await initializeWorkspace({ root, workspace });
    await fs.writeFile(runtimeEnv, "PRIVATE=value\n", { mode: 0o644 });

    await initializeWorkspace({ root, workspace });

    await expect(fs.readFile(runtimeEnv, "utf8")).resolves.toBe("PRIVATE=value\n");
    expect((await fs.stat(runtimeEnv)).mode & 0o777).toBe(0o600);
  });

  it("rejects an unmarked existing workspace before writing current layout files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-legacy-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "EXAMPLE=1\n", "utf8");
    await fs.mkdir(path.join(workspace, "runtime/napcat/config-full"), { recursive: true });
    await fs.writeFile(path.join(workspace, "runtime/napcat/config-full/onebot11.json"), "{}\n", "utf8");

    await expect(initializeWorkspace({ root, workspace })).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_REQUIRED"
    });
    await expect(fs.access(path.join(workspace, MULTI_AGENT_MIGRATION_MARKER)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(workspace, "secrets/runtime.env")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(
      workspace,
      "runtime/napcat/config-full/onebot11.json"
    ), "utf8")).resolves.toBe("{}\n");
  });

  it("rejects a modified migration marker before changing workspace files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-marker-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "EXAMPLE=1\n", "utf8");
    await initializeWorkspace({ root, workspace, now: new Date("2026-07-14T00:00:00.000Z") });
    const markerPath = path.join(workspace, MULTI_AGENT_MIGRATION_MARKER);
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    marker.createdAt = "2026-07-14T01:00:00.000Z";
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    const runtimeEnv = path.join(workspace, "secrets/runtime.env");

    await expect(initializeWorkspace({ root, workspace })).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_MARKER_INVALID"
    });
    await expect(fs.readFile(runtimeEnv, "utf8")).resolves.toBe("EXAMPLE=1\n");
  });

  it("recovers an interrupted first marker write without misclassifying a fresh workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-interrupted-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const migrations = path.join(workspace, "business/migrations");
    const interrupted = path.join(migrations, "multi-agent-v1.json.123.456.tmp");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "EXAMPLE=1\n", "utf8");
    await fs.mkdir(migrations, { recursive: true });
    await fs.writeFile(interrupted, "partial", "utf8");

    await initializeWorkspace({ root, workspace, now: new Date("2026-07-14T00:00:00.000Z") });

    await expect(fs.access(interrupted)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(workspace, MULTI_AGENT_MIGRATION_MARKER), "utf8"))
      .resolves.toContain('"kind": "fresh-install"');
  });

  it("rejects direct API startup before config or SQLite writes in an unmarked workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-api-migration-gate-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const sentinel = path.join(workspace, "legacy/sentinel.txt");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "preserve\n", "utf8");
    const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(projectRoot, "apps/api/main.ts")
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SUNABOT_WORKSPACE: workspace,
        SUNABOT_CONFIG: path.join(workspace, "business/config/sunabot.json")
      }
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("MULTI_AGENT_MIGRATION_REQUIRED");
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    await expect(fs.access(path.join(workspace, "business/config/sunabot.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(workspace, "business/agents/plana/agent.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an explicit API config before writes when the workspace is unmarked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-explicit-api-gate-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const sentinel = path.join(workspace, "legacy/sentinel.txt");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "preserve\n", "utf8");

    const result = runExplicitBuildApp(workspace, path.join(root, "external-agent"));

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("MULTI_AGENT_MIGRATION_REQUIRED");
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a noncanonical Plana database path before creating SQLite", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-explicit-api-database-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "ONEBOT_ACCESS_TOKEN=\n", "utf8");
    await initializeWorkspace({ root, workspace });
    const externalAgent = path.join(root, "external-agent");

    const result = runExplicitBuildApp(workspace, externalAgent);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("AGENT_WORKSPACE_UNSUPPORTED");
    await expect(fs.access(path.join(workspace, "business/data/sunabot.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "data/sunabot.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

function runExplicitBuildApp(workspace: string, agentWorkspace: string) {
  const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
  const serverUrl = pathToFileURL(path.join(projectRoot, "apps/api/server.ts")).href;
  const configUrl = pathToFileURL(path.join(projectRoot, "src/config.ts")).href;
  const source = [
    `const { buildApp } = await import(${JSON.stringify(serverUrl)});`,
    `const { defaultConfig } = await import(${JSON.stringify(configUrl)});`,
    "const config = defaultConfig();",
    `config.persona.agentWorkspace = ${JSON.stringify(agentWorkspace)};`,
    "try {",
    "  await buildApp({ config, initializeRuntime: false });",
    "} catch (error) {",
    "  console.error(error?.code || error?.message || String(error));",
    "  process.exitCode = 1;",
    "}"
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SUNABOT_WORKSPACE: workspace,
      SUNABOT_CONFIG: path.join(workspace, "business/config/sunabot.json")
    }
  });
}
