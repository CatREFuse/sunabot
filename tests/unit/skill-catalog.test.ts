// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSkillCatalog } from "../../services/extensions/skillCatalog.js";
import type { AgentSkillRecord } from "../../packages/contracts/extensions/agentExtensions.js";
import {
  createActivateSkillTool,
  createReadSkillResourceTool,
  createRunSkillScriptTool
} from "../../services/tools/public.js";

describe("Skill runtime catalog", () => {
  it("hides disabled, unreviewed and explicit-only Skills from implicit metadata", () => {
    const result = buildSkillCatalog({ skills: [
      skill("enabled"),
      skill("explicit-only", { implicit: false }),
      skill("unreviewed", { reviewed: false }),
      skill("disabled", { enabled: false })
    ] });
    expect(result.entries.map((entry) => entry.id)).toEqual(["enabled"]);
    expect(result.explicitSkillIds).toEqual(["enabled"]);
    expect(result.systemText).toContain("/skills/enabled/SKILL.md");
    expect(result.systemText).not.toContain("explicit-only");
    expect(result.systemText).not.toContain("unreviewed");

    const selected = buildSkillCatalog({
      skills: [skill("enabled"), skill("explicit-only", { implicit: false })],
      selectedSkillIds: ["explicit-only"]
    });
    expect(selected.explicitSkillIds).toEqual(["explicit-only", "enabled"]);
    expect(selected.entries.map((entry) => entry.id)).toEqual(["enabled"]);
    expect(selected.systemText).not.toContain("explicit-only");
  });

  it("does not inject an empty catalog and truncates descriptions before omitting entries", () => {
    expect(buildSkillCatalog({ skills: [skill("hidden", { reviewed: false })] })).toEqual({
      entries: [], explicitSkillIds: []
    });
    const result = buildSkillCatalog({
      contextWindowCharacters: 100_000,
      skills: Array.from({ length: 12 }, (_, index) => skill(`skill-${index}`, {
        description: `When requested ${"x".repeat(500)} ${index}`
      }))
    });
    const combinedBytes = Buffer.byteLength(result.systemText ?? "", "utf8") +
      Buffer.byteLength(JSON.stringify([
        createActivateSkillTool(result.explicitSkillIds),
        createReadSkillResourceTool(result.explicitSkillIds),
        createRunSkillScriptTool(result.explicitSkillIds)
      ]), "utf8");
    expect(combinedBytes).toBeLessThanOrEqual(2_000);
    expect(result.warning).toEqual(expect.objectContaining({ code: "SKILL_CATALOG_TRUNCATED" }));
    expect(result.entries.every((entry) => entry.description.length <= 192)).toBe(true);
  });

  it("never exceeds two percent for a known tiny context or leaks omitted IDs through tool enums", () => {
    const skills = Array.from({ length: 100 }, (_, index) => skill(`skill-${index}`));
    const tiny = buildSkillCatalog({ contextWindowCharacters: 1_000, skills });
    expect(tiny).toMatchObject({ entries: [], explicitSkillIds: [] });
    expect(tiny.warning).toEqual({ code: "SKILL_CATALOG_TRUNCATED", omittedCount: 100 });

    const bounded = buildSkillCatalog({ skills });
    expect(bounded.explicitSkillIds.length).toBeLessThanOrEqual(64);
    expect(bounded.warning?.omittedCount).toBe(100 - bounded.explicitSkillIds.length);
  });
});

function skill(id: string, options: {
  reviewed?: boolean;
  enabled?: boolean;
  implicit?: boolean;
  description?: string;
} = {}): AgentSkillRecord {
  const digest = id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/gu, "a");
  const reviewed = options.reviewed ?? true;
  return {
    id,
    name: id,
    description: options.description ?? `Use ${id} when requested.`,
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: [],
    riskEvidence: {
      reviewVersion: 1,
      reviewStatus: reviewed ? "approved" : "unreviewed",
      reviewedDigestSha256: reviewed ? digest : null,
      classification: "instruction-only",
      hasScripts: false,
      hasExternalUrls: false,
      mcpDependencies: [],
      declaredFileAccess: [],
      allowImplicitInvocation: options.implicit ?? true
    },
    enabled: options.enabled ?? true,
    entry: "SKILL.md",
    digestSha256: digest,
    fileCount: 1,
    unpackedBytes: 1,
    installedAt: "2026-07-17T00:00:00.000Z",
    source: { kind: "upload" },
    approval: {
      status: reviewed ? "approved" : "unapproved",
      digestSha256: reviewed ? digest : null,
      approvedAt: reviewed ? "2026-07-17T00:01:00.000Z" : null
    }
  };
}
