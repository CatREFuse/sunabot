// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSkillScriptExecutor } from "../../adapters/filesystem/agentSkillScriptExecutor.js";
import type { SkillScriptIndependentAuditInput } from "../../adapters/filesystem/agentSkillScriptAudit.js";
import {
  captureSkillScriptMountIdentity,
  type AgentSkillScriptProjection
} from "../../adapters/filesystem/agentSkillScriptProjection.js";

const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/skill-script-executor";
const digest = "a".repeat(64);
const source = "#!/bin/bash\nprintf 'done\\n'\n";
const resource = {
  path: "scripts/run.sh",
  bytes: Buffer.byteLength(source),
  sha256: createHash("sha256").update(source).digest("hex")
};
let runRoot = "";

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_ROOT, 0o700);
  runRoot = await fs.mkdtemp(path.join(TEST_ROOT, "run-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (runRoot) await fs.rm(runRoot, { recursive: true, force: true });
});

describe("AgentSkillScriptExecutor", () => {
  it("revalidates the current double-approved package around projection and binds the audit to the launch", async () => {
    const projection = await createProjection();
    const reader = { read: vi.fn(async () => approvedRead()) };
    const projectionPort = { build: vi.fn(async () => projection) };
    const sandbox = { run: vi.fn(async () => ({
      ok: true, exitCode: 0, stdout: "done\n", stderr: "", stdoutTruncated: false, stderrTruncated: false
    })) };
    const auditedBytes: Buffer[] = [];
    const auditRunner = readOnlyAuditRunner(auditedBytes);
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader,
      projection: projectionPort,
      auditRunner,
      sandbox
    });
    const result = await executor.run({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: "test-skill",
      expectedDigestSha256: digest,
      resource,
      args: ["safe"],
      outputBudgetBytes: 2_048
    });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      skillId: "test-skill",
      path: resource.path,
      digestSha256: digest,
      auditFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(projectionPort.build).toHaveBeenCalledWith(expect.objectContaining({
      expectedDigestSha256: digest,
      expectedResourceSha256: resource.sha256,
      expectedResourceBytes: resource.bytes
    }));
    expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      conversationId: "private:1",
      expectedDigestSha256: digest,
      resourceSha256: resource.sha256,
      outputBudgetBytes: 2_048,
      interpreter: "/bin/bash",
      preflightFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      auditFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    }));
    expect(auditRunner.audit).toHaveBeenCalledOnce();
    expect(auditRunner.audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: "test-skill",
      expectedDigestSha256: digest,
      resource,
      args: ["safe"],
      source,
      interpreter: "/bin/bash",
      scriptSha256: resource.sha256,
      preflightFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    }));
    expect(auditedBytes).toEqual([Buffer.from(source)]);
    expect(projection.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a malicious projection with another Skill digest before sandbox execution", async () => {
    const projection = await createProjection("c".repeat(64));
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => projection) },
      auditRunner: readOnlyAuditRunner(),
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow("SKILL_SCRIPT_PROJECTION_INVALID");
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(projection.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when approval or package state changes after audit and before execution", async () => {
    const projection = await createProjection();
    const reader = { read: vi.fn()
      .mockResolvedValueOnce(approvedRead())
      .mockRejectedValueOnce(new Error("SKILL_RUNTIME_INVALID")) };
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader,
      projection: { build: vi.fn(async () => projection) },
      auditRunner: readOnlyAuditRunner(),
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow("SKILL_SCRIPT_RUNTIME_INVALID");
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(projection.dispose).toHaveBeenCalledTimes(1);
  });

  it("requires the independent audit runner and redacts an unavailable runner before sandbox execution", async () => {
    const projection = await createProjection();
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => projection) },
      auditRunner: { audit: vi.fn(async () => { throw new Error("runner failed /Users/admin/secret"); }) },
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow("SKILL_SCRIPT_AUDIT_UNAVAILABLE");
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(projection.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed before reading or projecting when no independent audit runner is configured", async () => {
    const reader = { read: vi.fn() };
    const projection = { build: vi.fn() };
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({ workspaceRoot: runRoot, reader, projection, sandbox });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow("SKILL_SCRIPT_AUDIT_UNAVAILABLE");
    expect(reader.read).not.toHaveBeenCalled();
    expect(projection.build).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it.each([
    ["confirm", [], "SKILL_SCRIPT_APPROVAL_REQUIRED"],
    ["allow", [{ path: "/workbench/result.txt", access: "write" }], "SKILL_SCRIPT_APPROVAL_REQUIRED"],
    ["allow", [{ path: "/workbench/result.txt", access: "delete" }], "SKILL_SCRIPT_APPROVAL_REQUIRED"]
  ] as const)("executes nothing for %s audit with persistent effects %#", async (decision, accesses, code) => {
    const projection = await createProjection();
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => projection) },
      auditRunner: {
        audit: vi.fn(async () => ({
          decision,
          risk: "low",
          accesses: accesses.map((access) => ({ ...access })),
          violations: [],
          summary: "Persistent workbench mutation."
        }))
      },
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow(code);
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("runs the independent full-content audit again for every execution", async () => {
    const auditRunner = readOnlyAuditRunner();
    const sandbox = { run: vi.fn(async () => ({
      ok: true, exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false
    })) };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => createProjection()) },
      auditRunner,
      sandbox
    });
    const input = {
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: ["same"]
    };
    await executor.run(input);
    await executor.run(input);
    expect(auditRunner.audit).toHaveBeenCalledTimes(2);
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });

  it("surfaces strict projection cleanup failure after one execution", async () => {
    const projection = await createProjection();
    vi.mocked(projection.dispose).mockRejectedValueOnce(new Error("rm failed /private/path"));
    const sandbox = { run: vi.fn(async () => ({
      ok: true, exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false
    })) };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => projection) },
      auditRunner: readOnlyAuditRunner(),
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: []
    })).rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    expect(sandbox.run).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed large-output execution successful while fitting the full result budget", async () => {
    const projection = await createProjection();
    const sandbox = { run: vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: `${"line\\n\"quoted\"".repeat(2_000)}`,
      stderr: "warning\n".repeat(2_000),
      stdoutTruncated: true,
      stderrTruncated: true
    })) };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader: { read: vi.fn(async () => approvedRead()) },
      projection: { build: vi.fn(async () => projection) },
      auditRunner: readOnlyAuditRunner(),
      sandbox
    });
    const result = await executor.run({
      agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
      expectedDigestSha256: digest, resource, args: [], outputBudgetBytes: 512
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(512);
    expect(sandbox.run).toHaveBeenCalledTimes(1);
  });

  it("rejects an undersized final-result budget before reading approval state or creating a projection", async () => {
    const reader = { read: vi.fn() };
    const projection = { build: vi.fn() };
    const sandbox = { run: vi.fn() };
    const executor = new AgentSkillScriptExecutor({
      workspaceRoot: runRoot,
      reader,
      projection,
      sandbox
    });
    await expect(executor.run({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: "test-skill",
      expectedDigestSha256: digest,
      resource,
      args: [],
      outputBudgetBytes: 1
    })).rejects.toThrow("SKILL_SCRIPT_LIMIT_INVALID");
    expect(reader.read).not.toHaveBeenCalled();
    expect(projection.build).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it.each(["SKILL_SCRIPT_ABORTED", "SKILL_SCRIPT_TIMEOUT"])(
    "strictly disposes the projection after %s",
    async (code) => {
      const projection = await createProjection();
      const sandbox = { run: vi.fn(async () => { throw new Error(code); }) };
      const executor = new AgentSkillScriptExecutor({
        workspaceRoot: runRoot,
        reader: { read: vi.fn(async () => approvedRead()) },
        projection: { build: vi.fn(async () => projection) },
        auditRunner: readOnlyAuditRunner(),
        sandbox
      });
      await expect(executor.run({
        agentId: "agent-a", conversationId: "private:1", skillId: "test-skill",
        expectedDigestSha256: digest, resource, args: []
      })).rejects.toThrow(code);
      expect(projection.dispose).toHaveBeenCalledTimes(1);
    }
  );
});

function approvedRead() {
  return {
    digestSha256: digest,
    instructions: "Run the reviewed helper.",
    resources: [resource]
  };
}

function readOnlyAuditRunner(auditedBytes?: Buffer[]) {
  return {
    audit: vi.fn(async (input: SkillScriptIndependentAuditInput) => {
      auditedBytes?.push(Buffer.from(input.bytes));
      return {
        decision: "allow" as const,
        risk: "low" as const,
        accesses: [],
        violations: [],
        summary: "Read-only Skill script execution."
      };
    })
  };
}

async function createProjection(projectionDigest = digest): Promise<AgentSkillScriptProjection> {
  const root = path.join(runRoot, `projection-${Math.random().toString(16).slice(2)}`);
  const workbench = path.join(runRoot, "workbench");
  const skills = path.join(root, "skills");
  const skillDirectory = path.join(skills, "test-skill");
  const scriptFile = path.join(skillDirectory, "scripts/run.sh");
  const manifestFile = path.join(skills, ".sunabot-skill-script-manifest.json");
  await fs.mkdir(path.dirname(scriptFile), { recursive: true, mode: 0o700 });
  await fs.mkdir(workbench, { recursive: true, mode: 0o700 });
  await fs.writeFile(scriptFile, source, { mode: 0o400 });
  await fs.writeFile(manifestFile, "{}\n", { mode: 0o400 });
  return {
    root,
    workbench,
    skills,
    manifestFile,
    skillDirectory,
    scriptFile,
    virtualScript: "/skills/test-skill/scripts/run.sh",
    digestSha256: projectionDigest,
    rootMountIdentity: await captureSkillScriptMountIdentity(root, "directory"),
    workbenchMountIdentity: await captureSkillScriptMountIdentity(workbench, "directory"),
    skillsMountIdentity: await captureSkillScriptMountIdentity(skills, "directory"),
    scriptMountIdentity: await captureSkillScriptMountIdentity(scriptFile, "file"),
    manifestMountIdentity: await captureSkillScriptMountIdentity(manifestFile, "file"),
    dispose: vi.fn(async () => undefined)
  };
}
