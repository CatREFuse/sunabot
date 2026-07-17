import {
  SKILL_CATALOG_UNKNOWN_CONTEXT_BUDGET,
  isRuntimeApprovedSkill,
  type SkillCatalogEntry,
  type SkillCatalogResult
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import {
  compareBinaryText,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  createActivateSkillTool,
  createReadSkillResourceTool,
  createRunSkillScriptTool
} from "../tools/public.js";

const DESCRIPTION_SOFT_LIMIT = 192;
const SKILL_CATALOG_MAX_IDS = 64;
const CATALOG_HEADER = "Available Agent Skills. Activate only when the request matches:\n";

export function buildSkillCatalog(input: {
  skills: AgentSkillRecord[];
  contextWindowCharacters?: number;
  selectedSkillIds?: string[];
}): SkillCatalogResult {
  const approved = input.skills
    .filter(isRuntimeApprovedSkill)
    .sort((left, right) => compareBinaryText(left.name, right.name));
  const selectedIds = new Set((input.selectedSkillIds ?? []).slice(0, 8));
  const explicitSelected = approved.filter((skill) =>
    skill.riskEvidence.allowImplicitInvocation === false && selectedIds.has(skill.id));
  const implicit = approved.filter((skill) => skill.riskEvidence.allowImplicitInvocation !== false);
  const budget = catalogBudget(input.contextWindowCharacters);
  const selected = [...explicitSelected, ...implicit]
    .filter((skill, index, values) => values.findIndex((candidate) => candidate.id === skill.id) === index)
    .slice(0, SKILL_CATALOG_MAX_IDS);
  const protectedIds = new Set(explicitSelected.map((skill) => skill.id));
  const explicitSkillIds = selected.map((skill) => skill.id);
  const entries = selected.filter((skill) => !protectedIds.has(skill.id)).map(toCatalogEntry);
  let rendered = entries.length ? render(entries) : "";
  if (catalogUsage(rendered, explicitSkillIds) > budget) {
    for (const entry of entries) entry.description = truncate(entry.description, DESCRIPTION_SOFT_LIMIT);
    rendered = entries.length ? render(entries) : "";
  }
  while (explicitSkillIds.some((id) => !protectedIds.has(id)) && catalogUsage(rendered, explicitSkillIds) > budget) {
    let removeIndex = explicitSkillIds.length - 1;
    while (removeIndex >= 0 && protectedIds.has(explicitSkillIds[removeIndex]!)) removeIndex -= 1;
    const [removedId] = explicitSkillIds.splice(removeIndex, 1);
    const entryIndex = entries.findIndex((entry) => entry.id === removedId);
    if (entryIndex >= 0) entries.splice(entryIndex, 1);
    rendered = entries.length ? render(entries) : "";
  }
  if (catalogUsage(rendered, explicitSkillIds) > budget) throw new Error("SKILL_EXPLICIT_SELECTION_BUDGET");
  const implicitIds = new Set(implicit.map((skill) => skill.id));
  const omittedCount = implicit.length - explicitSkillIds.filter((id) => implicitIds.has(id)).length;
  return {
    entries,
    explicitSkillIds,
    ...(rendered ? { systemText: rendered } : {}),
    ...(omittedCount ? {
      warning: { code: "SKILL_CATALOG_TRUNCATED" as const, omittedCount }
    } : {})
  };
}

function catalogUsage(rendered: string, skillIds: string[]) {
  if (!skillIds.length) return 0;
  return Buffer.byteLength(rendered, "utf8") + Buffer.byteLength(JSON.stringify([
    createActivateSkillTool(skillIds),
    createReadSkillResourceTool(skillIds),
    createRunSkillScriptTool(skillIds)
  ]), "utf8");
}

function toCatalogEntry(skill: AgentSkillRecord): SkillCatalogEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    virtualEntry: `/skills/${skill.id}/SKILL.md`,
    implicit: true
  };
}

function catalogBudget(contextWindowCharacters: number | undefined) {
  if (contextWindowCharacters == null) return SKILL_CATALOG_UNKNOWN_CONTEXT_BUDGET;
  if (!Number.isFinite(contextWindowCharacters) || contextWindowCharacters <= 0) {
    return SKILL_CATALOG_UNKNOWN_CONTEXT_BUDGET;
  }
  return Math.min(
    SKILL_CATALOG_UNKNOWN_CONTEXT_BUDGET,
    Math.floor(contextWindowCharacters * 0.02)
  );
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function render(entries: SkillCatalogEntry[]) {
  return `${CATALOG_HEADER}${entries
    .map((entry) => `- ${entry.name}: ${entry.description} (${entry.virtualEntry})`)
    .join("\n")}`;
}
