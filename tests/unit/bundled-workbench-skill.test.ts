// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import {
  BundledAgentSkillInstaller,
  WORKBENCH_CONFIG_SKILL_ID
} from "../../apps/api/bundledAgentSkills.js";
import { getRootDir } from "../../packages/platform/projectPaths.js";
import { buildSkillCatalog } from "../../services/extensions/public.js";
import { testTempRoot } from "./test-temp-root.js";

const TEST_DATA_ROOT = testTempRoot("bundled-workbench-skill");
let workspace = "";

beforeEach(async () => {
  await fs.mkdir(TEST_DATA_ROOT, { recursive: true, mode: 0o700 });
  workspace = await fs.mkdtemp(path.join(TEST_DATA_ROOT, "workspace-"));
  await fs.mkdir(path.join(workspace, "business/agents/plana"), {
    recursive: true,
    mode: 0o700
  });
  await fs.chmod(path.join(workspace, "business/agents"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/plana"), 0o700);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("bundled Workbench configuration Skill", () => {
  it("installs, reviews, enables, and preserves one content-addressed package", async () => {
    const store = new AgentExtensionStore({
      workspaceRoot: workspace,
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });
    const installer = new BundledAgentSkillInstaller(
      store,
      path.join(getRootDir(), "codex-skills", WORKBENCH_CONFIG_SKILL_ID)
    );

    const first = await installer.ensure("plana");
    const second = await installer.ensure("plana");
    const index = await store.readSkillIndex("plana");

    expect(second).toEqual(first);
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toMatchObject({
      id: WORKBENCH_CONFIG_SKILL_ID,
      enabled: true,
      source: { kind: "bundled", bundleId: WORKBENCH_CONFIG_SKILL_ID },
      riskEvidence: {
        reviewStatus: "approved",
        reviewedDigestSha256: first.digestSha256,
        classification: "instruction-only",
        allowImplicitInvocation: true
      },
      approval: {
        status: "approved",
        digestSha256: first.digestSha256
      }
    });
    expect(buildSkillCatalog({ skills: index.skills }).systemText)
      .toContain("add or inspect emoji assets");
    const addressing = fs.readFile(path.join(
      workspace,
      "business/agents/plana/workbench/skills/workbench-config/references/workbench-addressing.md"
    ), "utf8");
    const skill = fs.readFile(path.join(
      workspace,
      "business/agents/plana/workbench/skills/workbench-config/SKILL.md"
    ), "utf8");
    const bashOperations = fs.readFile(path.join(
      workspace,
      "business/agents/plana/workbench/skills/workbench-config/references/bash-resource-operations.md"
    ), "utf8");
    await expect(addressing).resolves.toContain("one canonical Workbench tree");
    await expect(addressing).resolves.not.toContain("docker-workbench");
    await expect(addressing).resolves.not.toContain("native-workbench");
    await expect(skill).resolves.toContain("Use `native_bash`");
    await expect(skill).resolves.not.toContain(
      "Do not edit Skills, emoji, selfie, knowledge, or MCP manifests with Bash"
    );
    await expect(bashOperations).resolves.toContain("Compare and atomically replace");
    await expect(bashOperations).resolves.toContain("Manage knowledge");
    await expect(bashOperations).resolves.toContain("Manage selfie references");
    await expect(bashOperations).resolves.toContain("Manage emoji");
    await expect(bashOperations).resolves.toContain("Maintain Skill source packages");
    await expect(bashOperations).resolves.toContain("mv -f -- \"$temporary\" \"$target\"");
    await expect(bashOperations).resolves.toContain(
      "Use `import_chat_emoji` when the source is a current chat media handle"
    );
    await expect(bashOperations).resolves.toContain(
      "The 2 MiB limit applies only to `emojis.jsonl` itself"
    );
    await expect(bashOperations).resolves.toContain(
      "Do not add the byte sizes of referenced emoji images together"
    );
    await expect(skill).resolves.toContain("`import_chat_selfie`");
  }, 15_000);
});
