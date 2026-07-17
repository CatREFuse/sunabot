// @vitest-environment node
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditAgentSkillScript } from "../../adapters/filesystem/agentSkillScriptAudit.js";
import {
  captureSkillScriptMountIdentity,
  type AgentSkillScriptProjection
} from "../../adapters/filesystem/agentSkillScriptProjection.js";
import {
  StrongIsolatedAgentSkillScriptSandbox,
  buildSkillScriptBubblewrapInvocation,
  buildSkillScriptDockerInvocation,
  type AgentSkillScriptSandboxInput,
  type SkillScriptChild,
  type SkillScriptSpawn
} from "../../adapters/filesystem/agentSkillScriptSandbox.js";

const digest = "a".repeat(64);
const source = "#!/bin/bash\nprintf '%s\\n' \"$1\"\n";
const resourceSha = createHash("sha256").update(source).digest("hex");
const image = `sha256:${"d".repeat(64)}`;
const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2-skill-script-sandbox";
let runRoot = "";
let sandboxInput: AgentSkillScriptSandboxInput;

beforeAll(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_ROOT, 0o700);
});

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_ROOT, 0o700);
  runRoot = await fs.mkdtemp(path.join(TEST_ROOT, "run-"));
  sandboxInput = await createInput();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (runRoot) await forceRemove(runRoot);
});

describe("Skill script sandbox", () => {
  it("builds a fixed no-network bubblewrap invocation with workbench and skills read-only", () => {
    const invocation = buildSkillScriptBubblewrapInvocation(input(), {
      platform: "linux",
      bwrapExecutable: "/fixture/bwrap",
      prlimitExecutable: "/fixture/prlimit"
    });
    expect(invocation).toMatchObject({ kind: "bubblewrap", file: "/fixture/prlimit", env: {} });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--unshare-net", "--unshare-user", "--unshare-pid", "--unshare-cgroup",
      "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", input().projection.workbench, "/workbench",
      "--ro-bind", input().projection.skills, "/skills",
      "/bin/bash", "/skills/test-skill/scripts/run.sh", "safe"
    ]));
    expect(invocation.args.join(" ")).not.toContain("docker.sock");
    expect(invocation.args.join(" ")).not.toContain("MCP_");
    expect(invocation.args.join(" ")).not.toContain("/host/agent/AGENTS.md");
    expect(() => buildSkillScriptBubblewrapInvocation(input(), { platform: "darwin" }))
      .toThrow("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  });

  it("builds an immutable short-lived Docker invocation without network, socket, or inherited environment", () => {
    const invocation = buildSkillScriptDockerInvocation(input(), {
      dockerExecutable: "/fixture/docker",
      image,
      uid: 1_000,
      gid: 1_001,
      containerName: `sunabot-skill-script-${"e".repeat(32)}`,
      dockerEnvironment: { DOCKER_HOST: "unix:///fixture/docker.sock" }
    });
    expect(invocation.kind).toBe("docker");
    expect(invocation.env).toEqual({ DOCKER_HOST: "unix:///fixture/docker.sock" });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--mount", `type=bind,src=${input().projection.workbench},dst=/workbench,readonly`,
      "--mount", `type=bind,src=${input().projection.skills},dst=/skills,readonly`,
      "--entrypoint", "/usr/local/libexec/sunabot-skill-script-entrypoint", image,
      "--digest", digest, "--resource-sha256", resourceSha,
      "--audit", input().auditFingerprintSha256
    ]));
    expect(invocation.args).not.toContain("--env");
    expect(invocation.args.join(" ")).not.toContain("docker.sock,dst");
    expect(invocation.args.join(" ")).not.toContain("MCP_TOKEN");
    expect(invocation.cleanup?.args).toEqual(["rm", "-f", `sunabot-skill-script-${"e".repeat(32)}`]);
    expect(() => buildSkillScriptDockerInvocation(input(), {
      image: "sunabot-skill-script:latest", uid: 1_000, gid: 1_000
    })).toThrow("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  });

  it("drains one large execution, truncates to the caller budget, and preserves its success", async () => {
    const runInput = await createInput("large-output");
    const child = new FakeChild();
    const spawnProcess: SkillScriptSpawn = () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.alloc(9_000, 0x61));
        child.stderr.emit("data", Buffer.alloc(9_000, 0x62));
        child.emitExit(0, null);
      });
      return child;
    };
    const sandbox = dockerSandbox({ spawnProcess });
    const result = await sandbox.run({ ...runInput, outputBudgetBytes: 4_096 });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_096);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeGreaterThan(3_800);
    expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
    expect(child.kills).toEqual([]);
  });

  it("preserves a real non-zero exit while truncating output without re-execution", async () => {
    const runInput = await createInput("non-zero-exit");
    const child = new FakeChild();
    const spawnProcess = vi.fn<SkillScriptSpawn>(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.alloc(8_000, 0x61));
        child.emitExit(7, null);
      });
      return child;
    });
    const result = await dockerSandbox({ spawnProcess }).run({ ...runInput, outputBudgetBytes: 512 });
    expect(result).toMatchObject({ ok: false, exitCode: 7, stdoutTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(512);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("uses the exact container cleanup on abort and surfaces cleanup failure", async () => {
    const abortInput = await createInput("abort");
    const controller = new AbortController();
    const child = new FakeChild();
    const cleanup = vi.fn(async () => undefined);
    const sandbox = dockerSandbox({
      spawnProcess: () => {
        queueMicrotask(() => controller.abort());
        return child;
      },
      cleanupRunner: cleanup
    });
    await expect(sandbox.run({ ...abortInput, signal: controller.signal })).rejects.toThrow("SKILL_SCRIPT_ABORTED");
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({
      args: ["rm", "-f", `sunabot-skill-script-${"e".repeat(32)}`]
    }));

    const failedAbortInput = await createInput("abort-cleanup-failure");
    const failedChild = new FakeChild();
    const failed = dockerSandbox({
      spawnProcess: () => {
        queueMicrotask(() => controller2.abort());
        return failedChild;
      },
      cleanupRunner: async () => { throw new Error("cleanup failed /host/path"); }
    });
    const controller2 = new AbortController();
    await expect(failed.run({ ...failedAbortInput, signal: controller2.signal }))
      .rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
  });

  it("uses the exact container cleanup on timeout and process error", async () => {
    const timeoutInput = await createInput("timeout");
    const timedOutChild = new FakeChild();
    const timeoutCleanup = vi.fn(async () => undefined);
    const timedOut = dockerSandbox({ spawnProcess: () => timedOutChild, cleanupRunner: timeoutCleanup });
    await expect(timedOut.run({ ...timeoutInput, timeoutMs: 1 })).rejects.toThrow("SKILL_SCRIPT_TIMEOUT");
    expect(timedOutChild.kills).toEqual(["SIGKILL"]);
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);

    const processErrorInput = await createInput("process-error");
    const errorChild = new FakeChild();
    const errorCleanup = vi.fn(async () => undefined);
    const failed = dockerSandbox({
      spawnProcess: () => {
        queueMicrotask(() => errorChild.emit("error", new Error("host /private/path")));
        return errorChild;
      },
      cleanupRunner: errorCleanup
    });
    await expect(failed.run(processErrorInput)).rejects.toThrow("SKILL_SCRIPT_PROCESS_ERROR");
    expect(errorCleanup).toHaveBeenCalledTimes(1);
  });

  it("recomputes the deterministic preflight inside the sandbox and never spawns a forged decision", async () => {
    const forgedInput = await createInput("forged-preflight");
    const spawnProcess = vi.fn<SkillScriptSpawn>();
    const sandbox = dockerSandbox({ spawnProcess });
    await expect(sandbox.run({ ...forgedInput, preflightFingerprintSha256: "f".repeat(64) }))
      .rejects.toThrow("SKILL_SCRIPT_AUDIT_MISMATCH");
    expect(spawnProcess).not.toHaveBeenCalled();
    const invalidPathInput = await createInput("invalid-path");
    await expect(sandbox.run({
      ...invalidPathInput,
      resourcePath: "scripts/../run.sh",
      projection: { ...invalidPathInput.projection, virtualScript: "/skills/test-skill/scripts/../run.sh" }
    })).rejects.toThrow("SKILL_SCRIPT_SANDBOX_INPUT_INVALID");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rechecks every frozen mount identity immediately before spawn, including swap-back", async () => {
    const runInput = await createInput("swap-back");
    const spawnProcess = vi.fn<SkillScriptSpawn>();
    const root = runInput.projection.root;
    const moved = `${root}.moved`;
    const sandbox = dockerSandbox({
      spawnProcess,
      beforeSpawn: async () => {
        await fs.rename(root, moved);
        await fs.rename(moved, root);
      }
    });
    await expect(sandbox.run(runInput)).rejects.toThrow("SKILL_SCRIPT_PROJECTION_INVALID");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("decodes across chunks with fatal UTF-8 and removes controls and host paths", async () => {
    const runInput = await createInput("decode-output");
    const child = new FakeChild();
    const sandbox = dockerSandbox({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from([0xe4, 0xb8]));
          child.stdout.emit("data", Buffer.concat([
            Buffer.from([0xad]),
            Buffer.from(" /Users/admin/secret\u001b file:///private/key C:\\Users\\admin\\token")
          ]));
          child.stderr.emit("data", Buffer.from([0xc3, 0x28]));
          child.emitExit(0, null);
        });
        return child;
      }
    });
    const result = await sandbox.run(runInput);
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
    expect(result.stdout).toContain("中");
    expect(result.stdout).toContain("[HOST_PATH]");
    expect(result.stdout).not.toMatch(/Users|private\/key|\\token|\u001b/u);
    expect(result.stderr).toMatch(/^\[INVALID_UTF8/u);
    expect(result.stderr).not.toContain("�");
  });

  it("rejects an output budget that cannot encode the result before projection or spawn", async () => {
    const runInput = await createInput("invalid-budget");
    const spawnProcess = vi.fn<SkillScriptSpawn>();
    const sandbox = dockerSandbox({ spawnProcess });
    await expect(sandbox.run({ ...runInput, outputBudgetBytes: 1 }))
      .rejects.toThrow("SKILL_SCRIPT_LIMIT_INVALID");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails closed for a root runtime before mounting any Agent data", async () => {
    const runInput = await createInput("root-runtime");
    const spawnProcess = vi.fn<SkillScriptSpawn>();
    const sandbox = new StrongIsolatedAgentSkillScriptSandbox({
      backend: "docker",
      platform: "darwin",
      dockerExecutable: "/usr/bin/true",
      dockerImage: image,
      effectiveUid: 0,
      effectiveGid: 0,
      spawnProcess
    });
    await expect(sandbox.run(runInput)).rejects.toThrow("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("bounds abort cleanup from the moment of cancellation when the child never exits", async () => {
    const runInput = await createInput("hanging-abort");
    const controller = new AbortController();
    const child = new HangingChild();
    const sandbox = dockerSandbox({
      spawnProcess: () => {
        queueMicrotask(() => controller.abort());
        return child;
      },
      cleanupRunner: async () => undefined,
      cleanupTimeoutMs: 5
    });
    await expect(sandbox.run({ ...runInput, signal: controller.signal }))
      .rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("applies the same bounded never-exit guard to bubblewrap process groups", async () => {
    const runInput = await createInput("hanging-bubblewrap");
    const child = new HangingChild();
    const killProcessGroup = vi.fn();
    const sandbox = new StrongIsolatedAgentSkillScriptSandbox({
      backend: "bubblewrap",
      platform: "linux",
      bwrapExecutable: "/usr/bin/true",
      prlimitExecutable: "/usr/bin/true",
      cleanupTimeoutMs: 5,
      spawnProcess: () => child,
      killProcessGroup
    });
    await expect(sandbox.run({ ...runInput, timeoutMs: 1 }))
      .rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    expect(killProcessGroup).toHaveBeenCalledWith(child.pid, "SIGKILL");
  });
});

class FakeChild extends EventEmitter implements SkillScriptChild {
  readonly pid = 424_242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    queueMicrotask(() => this.emitExit(null, signal));
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null) {
    this.emit("exit", code, signal);
  }
}

class HangingChild extends FakeChild {
  override kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    return true;
  }
}

function input(): AgentSkillScriptSandboxInput {
  return sandboxInput;
}

async function createInput(suffix = "default"): Promise<AgentSkillScriptSandboxInput> {
  const root = path.join(runRoot, `projection-${suffix}`);
  const workbench = path.join(runRoot, `workbench-${suffix}`);
  const skills = path.join(root, "skills");
  const skillDirectory = path.join(skills, "test-skill");
  const scriptFile = path.join(skillDirectory, "scripts/run.sh");
  const manifestFile = path.join(skills, ".sunabot-skill-script-manifest.json");
  await fs.mkdir(path.dirname(scriptFile), { recursive: true, mode: 0o700 });
  await fs.mkdir(workbench, { mode: 0o700 });
  await fs.writeFile(scriptFile, source, { mode: 0o400 });
  await fs.writeFile(manifestFile, "{}\n", { mode: 0o400 });
  for (const directory of [root, workbench, skills, skillDirectory, path.dirname(scriptFile)]) {
    await fs.chmod(directory, 0o500);
  }
  const projection: AgentSkillScriptProjection = {
    root,
    workbench,
    skills,
    manifestFile,
    skillDirectory,
    scriptFile,
    virtualScript: "/skills/test-skill/scripts/run.sh",
    digestSha256: digest,
    rootMountIdentity: await captureSkillScriptMountIdentity(root, "directory"),
    workbenchMountIdentity: await captureSkillScriptMountIdentity(workbench, "directory"),
    skillsMountIdentity: await captureSkillScriptMountIdentity(skills, "directory"),
    scriptMountIdentity: await captureSkillScriptMountIdentity(scriptFile, "file"),
    manifestMountIdentity: await captureSkillScriptMountIdentity(manifestFile, "file"),
    async dispose() {}
  };
  const base = {
    agentId: "agent-a",
    conversationId: "private:1",
    skillId: "test-skill",
    expectedDigestSha256: digest,
    resourcePath: "scripts/run.sh",
    resourceSha256: resourceSha,
    resourceBytes: Buffer.byteLength(source),
    interpreter: "/bin/bash" as const,
    args: ["safe"],
    projection
  };
  const decision = auditAgentSkillScript({
    agentId: base.agentId,
    conversationId: base.conversationId,
    skillId: base.skillId,
    expectedDigestSha256: base.expectedDigestSha256,
    resource: { path: base.resourcePath, bytes: base.resourceBytes, sha256: base.resourceSha256 },
    args: base.args,
    bytes: Buffer.from(source)
  });
  return {
    ...base,
    preflightFingerprintSha256: decision.fingerprintSha256,
    auditFingerprintSha256: "b".repeat(64)
  };
}

function dockerSandbox(options: {
  spawnProcess: SkillScriptSpawn;
  cleanupRunner?: (input: { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; timeoutMs: number }) => Promise<void>;
  cleanupTimeoutMs?: number;
  beforeSpawn?: () => Promise<void> | void;
}) {
  return new StrongIsolatedAgentSkillScriptSandbox({
    backend: "docker",
    platform: "darwin",
    dockerExecutable: "/usr/bin/true",
    dockerImage: image,
    dockerEnvironment: {},
    effectiveUid: 1_000,
    effectiveGid: 1_001,
    containerNameFactory: () => `sunabot-skill-script-${"e".repeat(32)}`,
    spawnProcess: options.spawnProcess,
    cleanupRunner: options.cleanupRunner,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    beforeSpawn: options.beforeSpawn
  });
}

async function forceRemove(root: string) {
  if (!root) return;
  await makeWritable(root);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function makeWritable(root: string) {
  const stat = await fs.lstat(root).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(root).catch(() => [])) await makeWritable(path.join(root, entry));
  } else {
    await fs.chmod(root, 0o600).catch(() => undefined);
  }
}
