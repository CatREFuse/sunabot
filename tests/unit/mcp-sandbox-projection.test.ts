// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import {
  McpSandboxProjectionBuilder,
  garbageCollectMcpSandboxProjections
} from "../../adapters/mcp/sandboxProjection.js";
import {
  BubblewrapMcpStdioLauncher,
  buildMcpBubblewrapInvocation
} from "../../adapters/mcp/stdioSandboxLauncher.js";
import { createMcpStdioLaunchProjection } from "../../adapters/mcp/stdioLaunchProjection.js";
import { AgentExtensionService } from "../../services/extensions/public.js";
import { makeStoredZip, skillMarkdown } from "./agent-extension-fixtures.js";

const temporaryPaths: string[] = [];
let workspace = "";
const testDataRoot = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/projections";

beforeEach(async () => {
  await makeTestTreeWritable(testDataRoot);
  await fs.rm(testDataRoot, { recursive: true, force: true });
  await fs.mkdir(testDataRoot, { recursive: true });
  workspace = await fs.mkdtemp(path.join(testDataRoot, "workspace-"));
  temporaryPaths.push(workspace);
  await fs.mkdir(path.join(workspace, "business/agents/agent-a"), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(workspace, "business/agents"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-a"), 0o700);
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((candidate) => fs.rm(candidate, {
    recursive: true,
    force: true
  })));
});

describe("MCP sandbox projection", () => {
  it("binds a Docker projection to the explicitly configured custom executable manifest digest", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    const server = stdioServer();
    const preview = await service.previewMcpServer({ agentId: "agent-a", server });
    await service.putMcpServer({
      agentId: "agent-a",
      server,
      previewRevision: preview.previewRevision,
      approveCommand: true
    });
    const executableManifestSha256 = "c".repeat(64);
    const projection = await new McpSandboxProjectionBuilder({
      workspaceRoot: workspace,
      repository: store,
      temporaryRoot: testDataRoot,
      executableManifestSha256
    }).build({ agentId: "agent-a", server });
    temporaryPaths.push(projection.root);

    expect(await fs.readFile(projection.config, "utf8")).toContain(
      `"executableManifestSha256":"${executableManifestSha256}"`
    );
    expect(projection.executableManifest).toBeUndefined();
    await projection.dispose();

    await expect(new McpSandboxProjectionBuilder({
      workspaceRoot: workspace,
      repository: store,
      temporaryRoot: testDataRoot,
      executableManifestSha256: "invalid"
    }).build({ agentId: "agent-a", server })).rejects.toThrow("MCP_SANDBOX_PROJECTION_INVALID");
  });

  it("copies only approved Skills into a digest-pinned read-only snapshot without shared inodes", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    await service.installSkill({
      agentId: "agent-a",
      archive: makeStoredZip([{ name: "SKILL.md", content: skillMarkdown("test-skill") }])
    });
    await service.reviewSkill({ agentId: "agent-a", skillId: "test-skill", approve: true });
    await service.setSkillEnabled({ agentId: "agent-a", skillId: "test-skill", enabled: true });
    const server = stdioServer();
    const serverPreview = await service.previewMcpServer({ agentId: "agent-a", server });
    await service.putMcpServer({
      agentId: "agent-a",
      server,
      previewRevision: serverPreview.previewRevision,
      approveCommand: true
    });
    const serverB = {
      ...server,
      id: "server-b",
      command: "/usr/bin/private-server-b",
      envKeys: ["SERVER_B_TOKEN"]
    };
    const serverBPreview = await service.previewMcpServer({ agentId: "agent-a", server: serverB });
    await service.putMcpServer({
      agentId: "agent-a",
      server: serverB,
      previewRevision: serverBPreview.previewRevision,
      approveCommand: true
    });

    const executable = "/usr/bin/true";
    const executableManifestPath = path.join(testDataRoot, "approved-executables.json");
    const executableDigest = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
    const executableManifest = `${JSON.stringify({
      schemaVersion: 1,
      executables: [{ path: executable, sha256: executableDigest }]
    })}\n`;
    await fs.writeFile(executableManifestPath, executableManifest, { mode: 0o444 });
    await fs.chmod(executableManifestPath, 0o444);

    const projection = await new McpSandboxProjectionBuilder({
      workspaceRoot: workspace,
      repository: store,
      temporaryRoot: testDataRoot,
      executableManifestPath,
      executableManifestUid: typeof process.getuid === "function" ? process.getuid() : 0
    }).build({ agentId: "agent-a", server });
    temporaryPaths.push(projection.root);
    const copied = path.join(projection.skills, "test-skill/SKILL.md");
    const source = path.join(workspace, "business/agents/agent-a/extensions/skills/test-skill/SKILL.md");
    expect(await fs.readFile(copied, "utf8")).toContain("name: test-skill");
    expect((await fs.stat(copied)).ino).not.toBe((await fs.stat(source)).ino);
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o400);
    expect((await fs.stat(projection.skills)).mode & 0o777).toBe(0o500);
    expect((await fs.stat(projection.launchSecrets!)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(projection.stdioEntrypoint!)).mode & 0o777).toBe(0o500);
    expect((await fs.stat(projection.executableManifest!)).mode & 0o777).toBe(0o444);
    expect(await fs.readFile(projection.executableManifest!, "utf8")).toBe(executableManifest);
    const config = await fs.readFile(projection.config, "utf8");
    expect(config).toContain('"workbench":"/workbench"');
    expect(config).toContain('"skills":"/skills"');
    expect(config).toContain(`"executableManifestSha256":"${createHash("sha256").update(executableManifest).digest("hex")}"`);
    expect(config).not.toContain(workspace);
    expect(config).not.toContain("credential-value");
    expect(config).not.toContain("server-b");
    expect(config).not.toContain("SERVER_B_TOKEN");
    expect(config).not.toContain("private-server-b");

    await fs.chmod(source, 0o600);
    await fs.writeFile(source, `${skillMarkdown("test-skill")}\nchanged\n`);
    expect(await fs.readFile(copied, "utf8")).not.toContain("changed");
    await projection.dispose();
    await expect(fs.access(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("builds a no-network bwrap invocation without putting secrets or commands in host argv", () => {
    const projection = {
      workbench: "/host/workbench",
      skills: "/host/projection/skills",
      config: "/host/projection/extensions/mcp.json",
      executableManifest: "/host/projection/runtime/mcp-executables.json"
    };
    const launchProjection = {
      hostDirectory: "/host/projection/launch-secrets/launch-a",
      hostEntrypoint: "/host/projection/runtime/mcp-stdio-entrypoint"
    };
    const invocation = buildMcpBubblewrapInvocation({
      command: "/usr/bin/mcp-server",
      args: ["--stdio"],
      cwd: "/workbench",
      env: { SERVER_TOKEN: "secret" },
      inheritEnv: false,
      stderr: "pipe",
      killScope: "process_group"
    }, projection, { launchProjection });
    expect(invocation.file).toBe("/usr/bin/prlimit");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--unshare-net",
      "--clearenv",
      "--ro-bind", projection.skills, "/skills",
      "--ro-bind", projection.config, "/run/sunabot/extensions/mcp.json",
      "--ro-bind", projection.executableManifest, "/opt/sunabot/mcp/executables.json",
      "--ro-bind", launchProjection.hostDirectory, "/run/sunabot/secrets",
      "--ro-bind", launchProjection.hostEntrypoint, "/run/sunabot/bin/mcp-stdio-entrypoint",
      "--bind", projection.workbench, "/workbench"
    ]));
    expect(invocation.args).not.toContain("secret");
    expect(invocation.args).not.toContain("SERVER_TOKEN");
    expect(invocation.args).not.toContain("/usr/bin/mcp-server");
    expect(invocation.args).not.toContain("--stdio");
    expect(invocation.args.slice(-2)).toEqual(["--", "/run/sunabot/bin/mcp-stdio-entrypoint"]);
    expect(invocation.args.join(" ")).not.toContain("docker.sock");
    expect(() => buildMcpBubblewrapInvocation({
      command: "/usr/bin/npx",
      args: ["server"],
      cwd: "/workbench",
      env: {},
      inheritEnv: false,
      stderr: "pipe",
      killScope: "process_group"
    }, projection, { launchProjection })).toThrow("MCP_STDIO_CONFIG_INVALID");
  });

  it("keeps per-server 0600 launch projections digest-bound and isolated", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    const serverA = stdioServer();
    const serverB = { ...serverA, id: "server-b", command: "/usr/bin/server-b", envKeys: ["SERVER_B_TOKEN"] };
    const [previewA, previewB] = await Promise.all([
      service.previewMcpServer({ agentId: "agent-a", server: serverA }),
      service.previewMcpServer({ agentId: "agent-a", server: serverB })
    ]);
    await service.putMcpServer({
      agentId: "agent-a",
      server: serverA,
      previewRevision: previewA.previewRevision,
      approveCommand: true
    });
    await service.putMcpServer({
      agentId: "agent-a",
      server: serverB,
      previewRevision: previewB.previewRevision,
      approveCommand: true
    });
    let activeSkillReads = 0;
    let maximumActiveSkillReads = 0;
    const builder = new McpSandboxProjectionBuilder({
      workspaceRoot: workspace,
      repository: {
        async readSkillIndex(agentId) {
          activeSkillReads += 1;
          maximumActiveSkillReads = Math.max(maximumActiveSkillReads, activeSkillReads);
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            return await store.readSkillIndex(agentId);
          } finally {
            activeSkillReads -= 1;
          }
        },
        readMcpServerIndex: (agentId) => store.readMcpServerIndex(agentId)
      },
      temporaryRoot: testDataRoot
    });
    const [projectionA, projectionB] = await Promise.all([
      builder.build({ agentId: "agent-a", server: serverA }),
      builder.build({ agentId: "agent-a", server: serverB })
    ]);
    expect(maximumActiveSkillReads).toBe(1);
    temporaryPaths.push(projectionA.root, projectionB.root);
    const specA = launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "server-a-secret" });
    const specB = launchSpec("/usr/bin/server-b", { SERVER_B_TOKEN: "server-b-secret" });
    const environmentA = specA.env;
    const environmentB = specB.env;
    const [launchA, launchB] = await Promise.all([
      createMcpStdioLaunchProjection({
        projection: projectionA,
        spec: specA
      }),
      createMcpStdioLaunchProjection({
        projection: projectionB,
        spec: specB
      })
    ]);
    const fileA = path.join(launchA.hostDirectory, (await fs.readdir(launchA.hostDirectory))[0]!);
    const fileB = path.join(launchB.hostDirectory, (await fs.readdir(launchB.hostDirectory))[0]!);
    const [encodedA, encodedB] = await Promise.all([fs.readFile(fileA, "utf8"), fs.readFile(fileB, "utf8")]);

    expect((await fs.stat(fileA)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(fileB)).mode & 0o777).toBe(0o600);
    expect(encodedA).toContain('"serverId":"server-a"');
    expect(encodedA).toContain("server-a-secret");
    expect(encodedA).not.toContain("server-b-secret");
    expect(encodedB).toContain('"serverId":"server-b"');
    expect(encodedB).toContain("server-b-secret");
    expect(encodedB).not.toContain("server-a-secret");
    expect(launchA.hostDirectory).not.toBe(launchB.hostDirectory);
    expect(environmentA).toEqual({});
    expect(environmentB).toEqual({});
    expect(JSON.stringify(specA)).not.toContain("server-a-secret");
    expect(JSON.stringify(specB)).not.toContain("server-b-secret");
    expect(await fs.readFile(projectionA.config, "utf8")).toContain("SERVER_TOKEN");
    expect(await fs.readFile(projectionB.config, "utf8")).toContain("SERVER_B_TOKEN");

    await Promise.all([launchA.dispose(), launchB.dispose()]);
    await expect(fs.access(launchA.hostDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(launchB.hostDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([projectionA.dispose(), projectionB.dispose()]);
  }, 15_000);

  it("wipes a launch secret file and allows cleanup retry when recursive removal fails", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    const server = stdioServer();
    const preview = await service.previewMcpServer({ agentId: "agent-a", server });
    await service.putMcpServer({
      agentId: "agent-a",
      server,
      previewRevision: preview.previewRevision,
      approveCommand: true
    });
    const projection = await new McpSandboxProjectionBuilder({
      workspaceRoot: workspace,
      repository: store,
      temporaryRoot: testDataRoot
    }).build({ agentId: "agent-a", server });
    temporaryPaths.push(projection.root);
    const launch = await createMcpStdioLaunchProjection({
      projection,
      spec: launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "must-be-wiped" })
    });
    const secretFile = path.join(launch.hostDirectory, (await fs.readdir(launch.hostDirectory))[0]!);
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    try {
      await expect(launch.dispose()).rejects.toThrow("MCP_STDIO_SECRET_CLEANUP_FAILED");
      await expect(fs.access(launch.hostDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantine = path.join(projection.launchSecrets!, (await fs.readdir(projection.launchSecrets!))
        .find((entry) => entry.startsWith(".launch-") && entry.includes(".cleanup-"))!);
      const quarantinedSecret = path.join(quarantine, path.basename(secretFile));
      expect((await fs.stat(quarantinedSecret)).size).toBe(0);
      expect(await fs.readFile(quarantinedSecret, "utf8")).not.toContain("must-be-wiped");
      await expect(launch.dispose()).resolves.toBeUndefined();
      await expect(fs.access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      remove.mockRestore();
      await projection.dispose();
    }
  });

  it("keeps an identity-bound launch quarantine when secret wiping fails, then retries the wipe", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    const server = stdioServer();
    const preview = await service.previewMcpServer({ agentId: "agent-a", server });
    await service.putMcpServer({
      agentId: "agent-a", server, previewRevision: preview.previewRevision, approveCommand: true
    });
    const projection = await new McpSandboxProjectionBuilder({
      workspaceRoot: workspace, repository: store, temporaryRoot: testDataRoot
    }).build({ agentId: "agent-a", server });
    temporaryPaths.push(projection.root);
    const launch = await createMcpStdioLaunchProjection({
      projection,
      spec: launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "wipe-must-retry" })
    });
    const fileName = (await fs.readdir(launch.hostDirectory))[0]!;
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    try {
      await expect(launch.dispose()).rejects.toThrow("MCP_STDIO_SECRET_CLEANUP_FAILED");
      await expect(fs.access(launch.hostDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantine = path.join(projection.launchSecrets!, (await fs.readdir(projection.launchSecrets!))
        .find((entry) => entry.startsWith(".launch-") && entry.includes(".cleanup-"))!);
      expect(await fs.readFile(path.join(quarantine, fileName), "utf8")).toContain("wipe-must-retry");
      open.mockRestore();
      const moved = `${quarantine}.moved`;
      await fs.rename(quarantine, moved);
      await fs.mkdir(quarantine, { mode: 0o700 });
      await expect(launch.dispose()).rejects.toThrow("MCP_STDIO_SECRET_CLEANUP_FAILED");
      await expect(fs.access(quarantine)).resolves.toBeUndefined();
      await fs.rm(quarantine, { recursive: true, force: true });
      await fs.rename(moved, quarantine);
      await expect(launch.dispose()).resolves.toBeUndefined();
      await expect(fs.access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      open.mockRestore();
      await projection.dispose();
    }
  });

  it("keeps an identity-bound root quarantine when launch-secret wiping fails", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    const server = stdioServer();
    const preview = await service.previewMcpServer({ agentId: "agent-a", server });
    await service.putMcpServer({
      agentId: "agent-a", server, previewRevision: preview.previewRevision, approveCommand: true
    });
    const projection = await new McpSandboxProjectionBuilder({
      workspaceRoot: workspace, repository: store, temporaryRoot: testDataRoot
    }).build({ agentId: "agent-a", server });
    const launch = await createMcpStdioLaunchProjection({
      projection,
      spec: launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "root-wipe-must-retry" })
    });
    const relativeSecret = path.relative(projection.root, path.join(
      launch.hostDirectory,
      (await fs.readdir(launch.hostDirectory))[0]!
    ));
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    try {
      await expect(projection.dispose()).rejects.toThrow("MCP_STDIO_SECRET_CLEANUP_FAILED");
      await expect(fs.access(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantine = path.join(testDataRoot, (await fs.readdir(testDataRoot))
        .find((entry) => entry.startsWith(".sunabot-mcp-") && entry.includes(".cleanup-"))!);
      expect(await fs.readFile(path.join(quarantine, relativeSecret), "utf8")).toContain("root-wipe-must-retry");
      open.mockRestore();
      await expect(projection.dispose()).resolves.toBeUndefined();
      await expect(fs.access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      open.mockRestore();
    }
  });

  it("fails closed on platforms without the strong launcher and disposes the projection", async () => {
    const dispose = vi.fn(async () => undefined);
    const launcher = new BubblewrapMcpStdioLauncher({
      root: "/tmp/projection",
      workbench: "/tmp/workbench",
      skills: "/tmp/projection/skills",
      config: "/tmp/projection/mcp.json",
      digestSha256: "a".repeat(64),
      dispose
    }, { platform: "darwin" });
    const rejectedSpec = launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "resolved-secret" });
    const resolvedEnvironment = rejectedSpec.env;
    await expect(launcher.launch(rejectedSpec, {
      stdout: vi.fn(), stderr: vi.fn(), exit: vi.fn(), error: vi.fn()
    }))
      .rejects.toThrow("MCP_STDIO_ISOLATION_UNAVAILABLE");
    expect(resolvedEnvironment).toEqual({});
    expect(JSON.stringify(rejectedSpec)).not.toContain("resolved-secret");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports a stable cleanup failure when a rejected native launch cannot remove its projection", async () => {
    const dispose = vi.fn(async () => { throw new Error("EIO /Users/admin/projection"); });
    const launcher = new BubblewrapMcpStdioLauncher({
      root: "/tmp/projection",
      workbench: "/tmp/workbench",
      skills: "/tmp/projection/skills",
      config: "/tmp/projection/mcp.json",
      digestSha256: "a".repeat(64),
      dispose
    }, { platform: "darwin" });
    await expect(launcher.launch(launchSpec("/usr/bin/mcp-server", { SERVER_TOKEN: "resolved-secret" }), {
      stdout: vi.fn(), stderr: vi.fn(), exit: vi.fn(), error: vi.fn()
    })).rejects.toThrow("MCP_STDIO_CLEANUP_FAILED");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes projections when isolation probes fail and garbage-collects dead-process roots on startup", async () => {
    const dispose = vi.fn(async () => undefined);
    const launcher = new BubblewrapMcpStdioLauncher({
      root: "/missing/projection",
      workbench: "/missing/workbench",
      skills: "/missing/skills",
      config: "/missing/mcp.json",
      digestSha256: "a".repeat(64),
      dispose
    }, { platform: "linux", bwrap: "/missing/bwrap", prlimit: "/missing/prlimit" });
    await expect(launcher.launch({
      command: "/usr/bin/mcp-server",
      args: [],
      cwd: "/workbench",
      env: {},
      inheritEnv: false,
      stderr: "pipe",
      killScope: "process_group"
    }, { stdout: vi.fn(), stderr: vi.fn(), exit: vi.fn(), error: vi.fn() }))
      .rejects.toThrow("MCP_STDIO_ISOLATION_UNAVAILABLE");
    expect(dispose).toHaveBeenCalledOnce();

    const stale = path.join(testDataRoot, "sunabot-mcp-999999-agent-a-server-a-stale");
    const recent = path.join(testDataRoot, "sunabot-mcp-2147483646-agent-a-server-a-recent");
    const active = path.join(testDataRoot, `sunabot-mcp-${process.pid}-agent-a-server-a-active`);
    temporaryPaths.push(stale, recent, active);
    await Promise.all([
      fs.mkdir(stale, { recursive: true }),
      fs.mkdir(recent, { recursive: true }),
      fs.mkdir(active, { recursive: true })
    ]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await Promise.all([fs.utimes(stale, old, old), fs.utimes(active, old, old)]);
    await garbageCollectMcpSandboxProjections(testDataRoot);
    await expect(fs.access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(recent)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(active)).resolves.toBeUndefined();
  });

  it.each(["EIO", "EACCES"])(
    "fails closed before projection creation when stale-root enumeration returns %s",
    async (code) => {
      const stale = path.join(testDataRoot, "sunabot-mcp-2147483644-agent-a-server-a-enumeration-error");
      temporaryPaths.push(stale);
      await fs.mkdir(stale, { recursive: true });
      const readSkillIndex = vi.fn(async () => { throw new Error("GC_BYPASSED"); });
      const readMcpServerIndex = vi.fn(async () => { throw new Error("GC_BYPASSED"); });
      const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(
        Object.assign(new Error(code), { code }) as never
      );
      try {
        await expect(new McpSandboxProjectionBuilder({
          workspaceRoot: workspace,
          repository: { readSkillIndex, readMcpServerIndex },
          temporaryRoot: testDataRoot
        }).build({ agentId: "agent-a", server: stdioServer() })).rejects.toMatchObject({ code });
        expect(readSkillIndex).not.toHaveBeenCalled();
        expect(readMcpServerIndex).not.toHaveBeenCalled();
        await expect(fs.access(stale)).resolves.toBeUndefined();
        expect((await fs.readdir(testDataRoot)).filter((entry) =>
          entry.startsWith(`sunabot-mcp-${process.pid}-`)
        )).toEqual([]);
      } finally {
        readdir.mockRestore();
      }
      await garbageCollectMcpSandboxProjections(testDataRoot);
      await expect(fs.access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["EIO", "EACCES"])(
    "fails closed and retains stale residue when candidate inspection returns %s",
    async (code) => {
      const stale = path.join(testDataRoot, "sunabot-mcp-2147483643-agent-a-server-a-inspection-error");
      temporaryPaths.push(stale);
      await fs.mkdir(stale, { recursive: true });
      const lstat = vi.spyOn(fs, "lstat").mockRejectedValueOnce(
        Object.assign(new Error(code), { code }) as never
      );
      try {
        await expect(garbageCollectMcpSandboxProjections(testDataRoot)).rejects.toMatchObject({ code });
        await expect(fs.access(stale)).resolves.toBeUndefined();
      } finally {
        lstat.mockRestore();
      }
      await garbageCollectMcpSandboxProjections(testDataRoot);
      await expect(fs.access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("treats only ENOENT as a missing stale root during garbage collection", async () => {
    const stale = path.join(testDataRoot, "sunabot-mcp-2147483642-agent-a-server-a-missing-race");
    temporaryPaths.push(stale);
    await fs.mkdir(stale, { recursive: true });
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never
    );
    try {
      await expect(garbageCollectMcpSandboxProjections(testDataRoot)).resolves.toBeUndefined();
      await expect(fs.access(stale)).resolves.toBeUndefined();
    } finally {
      readdir.mockRestore();
    }
    const lstat = vi.spyOn(fs, "lstat").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never
    );
    try {
      await expect(garbageCollectMcpSandboxProjections(testDataRoot)).resolves.toBeUndefined();
      await expect(fs.access(stale)).resolves.toBeUndefined();
    } finally {
      lstat.mockRestore();
    }
    await garbageCollectMcpSandboxProjections(testDataRoot);
    await expect(fs.access(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wipes crash-recovered launch secrets before surfacing a root cleanup failure", async () => {
    const root = path.join(testDataRoot, "sunabot-mcp-2147483645-agent-a-server-a-crashed");
    const launch = path.join(root, `launch-secrets/launch-${"a".repeat(32)}`);
    const secret = path.join(launch, `${"b".repeat(64)}.json`);
    temporaryPaths.push(root);
    await fs.mkdir(launch, { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(root, "launch-secrets"), 0o700);
    await fs.chmod(launch, 0o700);
    await fs.writeFile(secret, '{"environment":{"TOKEN":"crash-secret"}}\n', { mode: 0o600 });
    await fs.chmod(secret, 0o600);
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    try {
      await expect(garbageCollectMcpSandboxProjections(testDataRoot))
        .rejects.toThrow("MCP_STDIO_SECRET_CLEANUP_FAILED");
      await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantine = path.join(testDataRoot, (await fs.readdir(testDataRoot))
        .find((entry) => entry.startsWith(".sunabot-mcp-") && entry.includes(".cleanup-"))!);
      const quarantinedSecret = path.join(quarantine, path.relative(root, secret));
      expect((await fs.stat(quarantinedSecret)).size).toBe(0);
      expect(await fs.readFile(quarantinedSecret, "utf8")).not.toContain("crash-secret");
      await expect(garbageCollectMcpSandboxProjections(testDataRoot)).resolves.toBeUndefined();
      await expect(fs.access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      remove.mockRestore();
    }
  });
});

function stdioServer() {
  return {
    id: "server-a",
    name: "Server A",
    description: "Test server",
    enabled: true,
    required: false,
    enabledTools: [],
    disabledTools: [],
    approvalMode: "always" as const,
    transport: "stdio" as const,
    command: "/usr/bin/mcp-server",
    args: ["--stdio"],
    envKeys: ["SERVER_TOKEN"]
  };
}

async function makeTestTreeWritable(root: string): Promise<void> {
  await fs.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeTestTreeWritable(target);
      return;
    }
    if (!entry.isSymbolicLink()) await fs.chmod(target, 0o600).catch(() => undefined);
  }));
}

function launchSpec(command: string, env: Record<string, string>) {
  return {
    command,
    args: ["--stdio"],
    cwd: "/workbench" as const,
    env,
    inheritEnv: false as const,
    stderr: "pipe" as const,
    killScope: "process_group" as const
  };
}
