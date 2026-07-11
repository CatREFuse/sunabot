// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateRuntimeSnapshot } from "../../tooling/runtime/doctor/core.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("runtime doctor fixtures", () => {
  it("accepts the healthy single-runtime fixture", () => {
    const report = evaluateRuntimeSnapshot(healthyFixture());

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.release).toMatchObject({
      runtimeId: "sunabot-qq-runtime",
      contractVersion: "0.1.0",
      packageVersion: "0.1.0",
      expectedNodeVersion: "24.18.0",
      actualNodeVersion: "24.18.0"
    });
    expect(report.listener.owners).toEqual([
      expect.objectContaining({ pid: 410, source: "current-release", workspaceRealPath: "/srv/sunabot/workspace" })
    ]);
    expect(report.databases).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "main", canonical: true, device: 8, inode: 101 }),
      expect.objectContaining({ role: "queue", canonical: true, device: 8, inode: 102 })
    ]));
    expect(report.onebot.connections).toEqual([
      expect.objectContaining({ state: "established", owner: expect.objectContaining({ pid: 510 }) })
    ]);
  });

  it("rejects duplicate API listeners from different runtime domains", () => {
    const fixture = healthyFixture();
    fixture.listener.owners.push(processFixture({
      pid: 411,
      name: "node.exe",
      domain: "windows",
      source: "foreign-domain",
      releaseRoot: "C:\\old-sunabot",
      releaseVersion: "0.0.9",
      workspace: "C:\\old-workspace",
      workspaceRealPath: "C:\\old-workspace"
    }));

    const report = evaluateRuntimeSnapshot(fixture);

    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toEqual(expect.arrayContaining([
      "LISTENER_DUPLICATE",
      "LISTENER_FOREIGN_DOMAIN",
      "LISTENER_RELEASE_MISMATCH",
      "LISTENER_VERSION_MISMATCH"
    ]));
  });

  it("rejects listener and OneBot owners attached to the wrong workspace", () => {
    const fixture = healthyFixture();
    fixture.workspace.identity = directoryIdentity("/srv/sunabot/other-workspace", 22);
    fixture.listener.owners[0]!.workspace = "/srv/sunabot/other-workspace";
    fixture.listener.owners[0]!.workspaceRealPath = "/srv/sunabot/other-workspace";
    fixture.onebot.candidates[0]!.workspace = "/srv/sunabot/other-workspace";
    fixture.onebot.candidates[0]!.workspaceRealPath = "/srv/sunabot/other-workspace";
    fixture.onebot.connections[0]!.owner = fixture.onebot.candidates[0];

    const report = evaluateRuntimeSnapshot(fixture);

    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toEqual(expect.arrayContaining([
      "WORKSPACE_EXPECTATION_MISMATCH",
      "LISTENER_WORKSPACE_MISMATCH",
      "ONEBOT_WORKSPACE_MISMATCH"
    ]));
  });

  it("rejects a second database and a legacy alias to the queue DB", () => {
    const fixture = healthyFixture();
    fixture.databases.push(
      databaseFixture("main", false, "/srv/sunabot/workspace/artifacts/sunabot.sqlite", 201),
      databaseFixture("queue", false, "/srv/sunabot/workspace/artifacts/session-queue.sqlite", 102)
    );

    const report = evaluateRuntimeSnapshot(fixture);

    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toEqual(expect.arrayContaining(["DATABASE_SECONDARY", "DATABASE_ALIAS"]));
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DATABASE_SECONDARY", details: expect.objectContaining({ role: "main" }) }),
      expect.objectContaining({ code: "DATABASE_ALIAS", details: expect.objectContaining({ role: "queue" }) })
    ]));
  });

  it("rejects a zombie OneBot connection and owner process", () => {
    const fixture = healthyFixture();
    fixture.onebot.candidates[0]!.alive = false;
    fixture.onebot.connections[0]!.owner = null;

    const report = evaluateRuntimeSnapshot(fixture);

    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toEqual(expect.arrayContaining([
      "ONEBOT_ZOMBIE_CONNECTION",
      "ONEBOT_ZOMBIE_PROCESS"
    ]));
  });

  it("projects only allow-listed facts and never emits command lines or environment secrets", () => {
    const fixture = healthyFixture();
    Object.assign(fixture.listener.owners[0]!, {
      commandLine: "node main.js --token=DO_NOT_PRINT_THIS",
      environment: { ONEBOT_ACCESS_TOKEN: "DO_NOT_PRINT_THIS" },
      password: "DO_NOT_PRINT_THIS"
    });
    Object.assign(fixture.onebot.candidates[0]!, {
      commandLine: "qq --access-token=DO_NOT_PRINT_THIS",
      environment: { OPENAI_API_KEY: "DO_NOT_PRINT_THIS" }
    });
    fixture.onebot.connections[0]!.owner = fixture.onebot.candidates[0];

    const serialized = JSON.stringify(evaluateRuntimeSnapshot(fixture));

    expect(serialized).not.toContain("DO_NOT_PRINT_THIS");
    expect(serialized).not.toContain("commandLine");
    expect(serialized).not.toContain("environment");
    expect(serialized).not.toContain("password");
  });
});

describe("runtime doctor live collector", () => {
  it("resolves release and workspace from the script location when launched from an arbitrary cwd", async () => {
    const workspace = await temporaryWorkspace();
    const port = await freePort();
    const result = await runDoctor(workspace, port, os.tmpdir());
    const report = JSON.parse(result.stdout);

    expect(report.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DOCTOR_COLLECTION_FAILED" })
    ]));
    expect(report.release.root.realPath).toBe(await fs.realpath(path.resolve(".")));
    expect(report.workspace.identity.realPath).toBe(await fs.realpath(workspace));
    expect(report.listener).toMatchObject({ host: "127.0.0.1", port, listening: false, owners: [] });
  });

  it("reports an occupied port even when process-owner collection is unavailable", async () => {
    const workspace = await temporaryWorkspace();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener did not bind");
    try {
      const result = await runDoctor(workspace, address.port, os.tmpdir());
      const report = JSON.parse(result.stdout);
      expect(result.code).toBe(1);
      expect(report.listener).toMatchObject({ listening: true });
      expect(errorCodes(report)).toContain("RUNTIME_ALREADY_LISTENING");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);
});

function healthyFixture() {
  const apiOwner = processFixture({ pid: 410, name: "node" });
  const onebotOwner = processFixture({ pid: 510, name: "qq", source: "component" });
  return {
    expectation: "running" as const,
    platform: "linux",
    domain: "wsl",
    release: {
      runtimeId: "sunabot-qq-runtime",
      root: directoryIdentity("/opt/sunabot/current", 11),
      contractVersion: "0.1.0",
      packageVersion: "0.1.0",
      expectedNodeVersion: "24.18.0",
      actualNodeVersion: "24.18.0"
    },
    workspace: {
      explicit: true,
      absoluteConfigured: true,
      production: true,
      identity: directoryIdentity("/srv/sunabot/workspace", 21),
      expected: directoryIdentity("/srv/sunabot/workspace", 21)
    },
    databases: [
      databaseFixture("main", true, "/srv/sunabot/workspace/business/data/sunabot.sqlite", 101),
      databaseFixture("queue", true, "/srv/sunabot/workspace/business/data/session-queue.sqlite", 102)
    ],
    listener: {
      host: "127.0.0.1",
      port: 8787,
      listening: true,
      owners: [apiOwner]
    },
    onebot: {
      candidates: [onebotOwner],
      connections: [{
        id: "wsl:onebot:1",
        state: "established",
        localAddress: "127.0.0.1",
        localPort: 43120,
        remoteAddress: "127.0.0.1",
        remotePort: 8787,
        owner: onebotOwner
      }]
    }
  };
}

function processFixture(overrides: Record<string, unknown> = {}) {
  return {
    pid: 1,
    name: "node",
    user: "sunabot",
    executable: "/usr/bin/node",
    domain: "wsl",
    source: "current-release",
    releaseRoot: "/opt/sunabot/current",
    releaseVersion: "0.1.0",
    runtimeId: "sunabot-qq-runtime",
    workspace: "/srv/sunabot/workspace",
    workspaceRealPath: "/srv/sunabot/workspace",
    alive: true,
    ...overrides
  };
}

function directoryIdentity(targetPath: string, inode: number) {
  return { path: targetPath, realPath: targetPath, exists: true, kind: "directory", device: 8, inode };
}

function databaseFixture(role: "main" | "queue", canonical: boolean, targetPath: string, inode: number) {
  return {
    role,
    canonical,
    source: canonical ? "runtime" : "legacy",
    path: targetPath,
    realPath: targetPath,
    exists: true,
    kind: "file",
    device: 8,
    inode
  };
}

function errorCodes(report: { errors?: Array<{ code?: string }> }) {
  return (report.errors ?? []).map((error) => error.code);
}

async function temporaryWorkspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener did not bind");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function runDoctor(workspace: string, port: number, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve("tooling/runtime/doctor.mjs"),
      `--port=${port}`
    ], {
      cwd,
      env: { ...process.env, SUNABOT_WORKSPACE: workspace },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
