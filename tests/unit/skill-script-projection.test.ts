// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSkillScriptProjectionBuilder } from "../../adapters/filesystem/agentSkillScriptProjection.js";
import { inspectSkillDirectory } from "../../adapters/filesystem/skillArchive.js";
import { skillMarkdown } from "./agent-extension-fixtures.js";

const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/skill-script-projection";
let workspace = "";
let temporaryRoot = "";

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_ROOT, 0o700);
  workspace = await fs.mkdtemp(path.join(TEST_ROOT, "workspace-"));
  temporaryRoot = await fs.mkdtemp(path.join(TEST_ROOT, "temporary-"));
  await fs.chmod(workspace, 0o700);
  await fs.chmod(temporaryRoot, 0o700);
  const agent = path.join(workspace, "business/agents/agent-a");
  const skill = path.join(agent, "extensions/skills/test-skill");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(agent, "workbench"), { recursive: true, mode: 0o700 });
  for (const directory of [
    path.join(workspace, "business"), path.join(workspace, "business/agents"), agent,
    path.join(agent, "extensions"), path.join(agent, "extensions/skills"), skill,
    path.join(skill, "scripts"), path.join(agent, "workbench")
  ]) await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(skill, "SKILL.md"), skillMarkdown("test-skill"), { mode: 0o600 });
  await fs.writeFile(path.join(skill, "scripts/run.sh"), "#!/bin/bash\nprintf ok\n", { mode: 0o600 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await forceRemove(workspace);
  await forceRemove(temporaryRoot);
});

describe("Skill script projection", () => {
  it("copies one digest-pinned package into a private read-only projection with only current workbench RW", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const projection = await new AgentSkillScriptProjectionBuilder({ workspaceRoot: workspace, temporaryRoot }).build({
      agentId: "agent-a",
      skillId: "test-skill",
      expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path,
      expectedResourceSha256: resource.sha256,
      expectedResourceBytes: resource.bytes
    });
    expect(projection.workbench).toBe(await fs.realpath(path.join(workspace, "business/agents/agent-a/workbench")));
    expect(projection.virtualScript).toBe("/skills/test-skill/scripts/run.sh");
    expect(projection.digestSha256).toBe(evidence.digestSha256);
    expect((await fs.lstat(projection.root)).mode & 0o777).toBe(0o500);
    expect((await fs.lstat(projection.skills)).mode & 0o777).toBe(0o500);
    expect((await fs.lstat(projection.scriptFile)).mode & 0o777).toBe(0o400);
    expect((await fs.lstat(projection.manifestFile)).mode & 0o777).toBe(0o400);
    expect(JSON.parse(await fs.readFile(projection.manifestFile, "utf8"))).toMatchObject({
      skillId: "test-skill",
      digestSha256: evidence.digestSha256,
      resource: { path: resource.path, bytes: resource.bytes, sha256: resource.sha256 }
    });
    expect(await fs.readdir(projection.root)).toEqual(["skills"]);
    const root = projection.root;
    await projection.dispose();
    await projection.dispose();
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and reuses a private 0700 parent below a sticky system temp directory", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const projection = await new AgentSkillScriptProjectionBuilder({ workspaceRoot: workspace }).build({
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    });
    expect((await fs.lstat(path.dirname(projection.root))).mode & 0o777).toBe(0o700);
    await projection.dispose();
  });

  it("fails with stable errors for a missing configured parent and for non-recoverable cleanup", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const request = {
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    };
    await expect(new AgentSkillScriptProjectionBuilder({
      workspaceRoot: workspace,
      temporaryRoot: path.join(temporaryRoot, "missing")
    }).build(request)).rejects.toThrow("SKILL_SCRIPT_PROJECTION_INVALID");

    const cleanup = vi.fn(async () => { throw new Error("rm failed /private/path"); });
    await expect(new AgentSkillScriptProjectionBuilder({
      workspaceRoot: workspace,
      temporaryRoot,
      removeProjection: cleanup
    }).build({ ...request, expectedResourceSha256: createHash("sha256").update("wrong").digest("hex") }))
      .rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps dispose retryable after a cleanup failure", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockImplementationOnce(forceRemove);
    const projection = await new AgentSkillScriptProjectionBuilder({
      workspaceRoot: workspace,
      temporaryRoot,
      removeProjection: cleanup
    }).build({
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    });
    await expect(projection.dispose()).rejects.toThrow("first cleanup failed");
    await expect(projection.dispose()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("cleans a partially created root after chmod failure", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const chmod = vi.spyOn(fs, "chmod");
    let failed = false;
    chmod.mockImplementation(async (target, mode) => {
      if (!failed && String(target).includes("sunabot-skill-script-") && mode === 0o700) {
        failed = true;
        throw new Error("chmod failed");
      }
      return await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
        .then((actual) => actual.chmod(target, mode));
    });
    await expect(new AgentSkillScriptProjectionBuilder({ workspaceRoot: workspace, temporaryRoot }).build({
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    })).rejects.toThrow("SKILL_SCRIPT_PROJECTION_INVALID");
    expect((await fs.readdir(temporaryRoot)).filter((name) => name.startsWith("sunabot-skill-script-"))).toEqual([]);
  });

  it("refuses a swapped projection root and leaves the replacement target untouched", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const projection = await new AgentSkillScriptProjectionBuilder({ workspaceRoot: workspace, temporaryRoot }).build({
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    });
    const original = `${projection.root}.original`;
    const outside = path.join(temporaryRoot, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "keep.txt"), "keep", { mode: 0o600 });
    await fs.rename(projection.root, original);
    await fs.symlink(outside, projection.root);
    await expect(projection.dispose()).rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    await expect(fs.readFile(path.join(outside, "keep.txt"), "utf8")).resolves.toBe("keep");
    await fs.unlink(projection.root);
    await fs.rename(original, projection.root);
    await expect(projection.dispose()).resolves.toBeUndefined();
  });

  it("quarantines the exact frozen root before recursive cleanup and retries the same inode", async () => {
    const evidence = await sourceEvidence();
    const resource = evidence.files.find((file) => file.path === "scripts/run.sh")!;
    const projection = await new AgentSkillScriptProjectionBuilder({ workspaceRoot: workspace, temporaryRoot }).build({
      agentId: "agent-a", skillId: "test-skill", expectedDigestSha256: evidence.digestSha256,
      resourcePath: resource.path, expectedResourceSha256: resource.sha256, expectedResourceBytes: resource.bytes
    });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (!failed && String(target).includes(".cleanup-")) {
        failed = true;
        throw new Error("simulated recursive cleanup failure /private/path");
      }
      return actual.rm(target, options);
    });
    await expect(projection.dispose()).rejects.toThrow("SKILL_SCRIPT_CLEANUP_FAILED");
    await expect(fs.lstat(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(temporaryRoot)).some((name) => name.includes(".cleanup-"))).toBe(true);
    await expect(projection.dispose()).resolves.toBeUndefined();
    expect((await fs.readdir(temporaryRoot)).filter((name) => name.includes(".cleanup-"))).toEqual([]);
  });
});

function sourceEvidence() {
  return inspectSkillDirectory(path.join(
    workspace,
    "business/agents/agent-a/extensions/skills/test-skill"
  ));
}

async function forceRemove(root: string) {
  if (!root) return;
  await fs.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await forceRemove(target);
    else await fs.chmod(target, 0o600).catch(() => undefined);
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
