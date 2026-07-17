// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { AgentSkillRuntimeReader } from "../../adapters/filesystem/agentSkillRuntimeReader.js";
import { AgentExtensionService, SkillActivationService } from "../../services/extensions/public.js";
import { makeStoredZip, skillMarkdown } from "./agent-extension-fixtures.js";

const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/skill-resource";
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let workspace = "";

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_ROOT, 0o700);
  workspace = await fs.mkdtemp(path.join(TEST_ROOT, "run-"));
  await fs.mkdir(path.join(workspace, "business/agents/agent-a"), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(workspace, "business/agents"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-a"), 0o700);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

describe("Skill runtime resources", () => {
  it("reads only an activated manifest resource through one pinned descriptor", async () => {
    const { activation, record } = await installedActivation();
    await activation.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, skills: [record]
    });
    await expect(activation.readResource({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: record.id,
      path: "references/guide.md"
    })).resolves.toEqual({
      ok: true,
      skillId: "test-skill",
      path: "references/guide.md",
      sha256: sha256("Guide text.\n"),
      byteLength: 12,
      encoding: "utf8",
      content: "Guide text.\n"
    });
    await expect(activation.readResource({
      agentId: "agent-a",
      conversationId: "private:2",
      skillId: record.id,
      path: "references/guide.md"
    })).rejects.toThrow("SKILL_NOT_ACTIVATED");
    await expect(activation.readResource({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: record.id,
      path: "../outside.txt"
    })).rejects.toThrow("SKILL_RESOURCE_UNAVAILABLE");
  }, 20_000);

  it("returns binary resources as bounded base64 without guessing text", async () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    const { activation, record } = await installedActivation(binary);
    await activation.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, skills: [record]
    });
    await expect(activation.readResource({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, path: "assets/pixel.png"
    })).resolves.toMatchObject({ encoding: "base64", content: binary.toString("base64"), byteLength: 4 });
  }, 20_000);

  it("fails closed when the resource leaf is swapped to a symlink between lstat and descriptor open", async () => {
    const store = await installedStore();
    const service = new AgentExtensionService(store);
    const record = await approvedRecord(service);
    const target = path.join(skillRoot(), "references/guide.md");
    const outside = path.join(workspace, "outside-secret.txt");
    await fs.writeFile(outside, "outside-secret", { mode: 0o600 });
    let swapped = false;
    const reader = new AgentSkillRuntimeReader({
      workspaceRoot: workspace,
      async beforeResourceOpen(filePath) {
        if (swapped || filePath !== target) return;
        swapped = true;
        await fs.rename(target, `${target}.original`);
        await fs.symlink(outside, target);
      }
    });
    const activation = new SkillActivationService(reader);
    await activation.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, skills: [record]
    });
    const error = await activation.readResource({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, path: "references/guide.md"
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("outside-secret");
  });
});

async function installedActivation(binary?: Buffer) {
  const store = await installedStore(binary);
  const service = new AgentExtensionService(store);
  const record = await approvedRecord(service);
  return {
    record,
    activation: new SkillActivationService(new AgentSkillRuntimeReader({ workspaceRoot: workspace }))
  };
}

async function installedStore(binary?: Buffer) {
  const store = new AgentExtensionStore({ workspaceRoot: workspace });
  const archive = makeStoredZip([
    { name: "SKILL.md", content: skillMarkdown("test-skill", undefined, "Use references/guide.md when asked.") },
    { name: "references/guide.md", content: "Guide text.\n" },
    ...(binary ? [{ name: "assets/pixel.png", content: binary }] : [])
  ]);
  await new AgentExtensionService(store).installSkill({ agentId: "agent-a", archive });
  return store;
}

async function approvedRecord(service: AgentExtensionService) {
  await service.reviewSkill({ agentId: "agent-a", skillId: "test-skill", approve: true });
  return service.setSkillEnabled({ agentId: "agent-a", skillId: "test-skill", enabled: true });
}

function skillRoot() {
  return path.join(workspace, "business/agents/agent-a/extensions/skills/test-skill");
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
