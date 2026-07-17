import {
  SHA256_PATTERN,
  type AgentSkillRecord
} from "./agentExtensions.js";

export const SKILL_CATALOG_UNKNOWN_CONTEXT_BUDGET = 8_000;
export const SKILL_ACTIVATION_MAX_RESOURCES = 128;
export const SKILL_ACTIVATION_MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
export const SKILL_ACTIVATION_MAX_INSTRUCTION_CHARS = 128 * 1024;
export const SKILL_ACTIVATION_MAX_INSTRUCTION_BYTES = 64 * 1024;
export const SKILL_ACTIVATION_MAX_CONVERSATION_BYTES = 256 * 1024;
export const SKILL_RESOURCE_MAX_READ_BYTES = 64 * 1024;
export const SKILL_SCRIPT_MAX_RESULT_BYTES = 64 * 1024;
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const MCP_VIRTUAL_WORKBENCH_ROOT = "file:///workbench" as const;

export interface SkillCatalogWarning {
  code: "SKILL_CATALOG_TRUNCATED";
  omittedCount: number;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  virtualEntry: string;
  implicit: boolean;
}

export interface SkillCatalogResult {
  entries: SkillCatalogEntry[];
  explicitSkillIds: string[];
  systemText?: string;
  warning?: SkillCatalogWarning;
}

export interface SkillActivationResource {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillActivationResult {
  skillId: string;
  digestSha256: string;
  virtualDirectory: string;
  instructions: string;
  resources: SkillActivationResource[];
  alreadyActivated: boolean;
}

export function isRuntimeApprovedSkill(record: AgentSkillRecord) {
  return record.enabled === true &&
    record.approval?.status === "approved" &&
    record.approval.digestSha256 === record.digestSha256 &&
    record.riskEvidence.reviewStatus === "approved" &&
    record.riskEvidence.reviewedDigestSha256 === record.digestSha256;
}

export function assertSkillActivationResource(value: SkillActivationResource) {
  if (!safeRelativeResourcePath(value.path) || !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 || value.bytes > SKILL_ACTIVATION_MAX_RESOURCE_BYTES ||
      !SHA256_PATTERN.test(value.sha256)) {
    throw new Error("SKILL_ACTIVATION_RESOURCE_INVALID");
  }
  return value;
}

export function safeRelativeResourcePath(value: string) {
  if (!value || value.length > 1_024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}
