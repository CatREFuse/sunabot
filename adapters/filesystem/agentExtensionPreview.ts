import { createHash } from "node:crypto";
import {
  compareBinaryText,
  AGENT_EXTENSION_SCHEMA_VERSION,
  assertAgentId,
  mcpDescriptorEnvKeys,
  type AgentExtensionCopyPreview,
  type AgentMcpSecretStatus,
  type AgentMcpServerDescriptor,
  type AgentMcpServerIndex,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import type { SkillPackageEvidence } from "../../services/extensions/public.js";
import { storeError } from "./agentExtensionSecureFs.js";

export async function buildAgentExtensionCopyPreview(input: {
  sourceAgentId: string;
  targetAgentId: string;
  skillId: string;
  mcpServerIds: string[];
  sourceSkills: AgentSkillIndex;
  targetSkills: AgentSkillIndex;
  sourceMcp: AgentMcpServerIndex;
  targetMcp: AgentMcpServerIndex;
  evidence: SkillPackageEvidence;
  credentialStatus: (query: {
    agentId: string;
    serverId: string;
    envKeys: string[];
  }) => Promise<AgentMcpSecretStatus>;
}): Promise<AgentExtensionCopyPreview> {
  const record = input.sourceSkills.skills.find((skill) => skill.id === input.skillId);
  if (!record) throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
  if (!sameSkillEvidence(record, input.evidence)) {
    throw storeError(409, "SKILL_SOURCE_CHANGED", "Skill 在预览期间发生变化。");
  }
  const targetSkill = input.targetSkills.skills.find((skill) => skill.id === input.skillId);
  const declaredMcpDependencies = input.evidence.riskEvidence.mcpDependencies;
  const missingMcpDependencies = declaredMcpDependencies
    .filter((dependency) => !input.targetMcp.servers.some((server) => server.id === dependency.id))
    .map((dependency) => dependency.id);
  const selectedMcpServers: AgentExtensionCopyPreview["selectedMcpServers"] = [];
  for (const serverId of input.mcpServerIds) {
    const sourceServer = input.sourceMcp.servers.find((candidate) => candidate.id === serverId);
    if (!sourceServer) throw storeError(404, "MCP_SERVER_NOT_FOUND", `MCP 服务不存在：${serverId}。`);
    const server = migrationDescriptor(sourceServer);
    const target = input.targetMcp.servers.find((candidate) => candidate.id === serverId);
    const sourceEnvKeys = mcpDescriptorEnvKeys(sourceServer, input.sourceAgentId);
    const targetEnvKeys = mcpDescriptorEnvKeys(sourceServer, input.targetAgentId);
    const [sourceSecrets, targetSecrets] = await Promise.all([
      input.credentialStatus({ agentId: input.sourceAgentId, serverId, envKeys: sourceEnvKeys }),
      input.credentialStatus({ agentId: input.targetAgentId, serverId, envKeys: targetEnvKeys })
    ]);
    selectedMcpServers.push({
      server,
      descriptorVersion: digest(server),
      conflict: target == null
        ? "none"
        : digest(target) === digest(server) ? "same-content" : "different-content",
      sourceSecrets,
      targetSecrets,
      targetState: "disabled",
      requiresAuthorization: server.migrationStatus === "reauthorization_required"
    });
  }
  const preview: Omit<AgentExtensionCopyPreview, "previewRevision"> = {
    schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
    sourceAgentId: assertAgentId(input.sourceAgentId),
    targetAgentId: assertAgentId(input.targetAgentId),
    sourceSkillRevision: input.sourceSkills.revision,
    targetSkillRevision: input.targetSkills.revision,
    sourceMcpRevision: input.sourceMcp.revision,
    targetMcpRevision: input.targetMcp.revision,
    skill: {
      record,
      contentVersion: record.digestSha256,
      files: input.evidence.files,
      conflict: targetSkill == null
        ? "none"
        : targetSkill.digestSha256 === record.digestSha256 ? "same-content" : "different-content",
      declaredMcpDependencies,
      declaredMcpDependenciesStatus: declaredMcpDependencies.length === 0
        ? "none"
        : missingMcpDependencies.length === 0 ? "declared" : "missing",
      missingMcpDependencies
    },
    selectedMcpServers
  };
  return { ...preview, previewRevision: digest(preview) };
}

export function sameSkillEvidence(record: AgentSkillRecord, evidence: SkillPackageEvidence) {
  return record.id === evidence.name && record.description === evidence.description &&
    record.license === evidence.license && record.compatibility === evidence.compatibility &&
    stableJson(record.metadata) === stableJson(evidence.metadata) &&
    stableJson(record.allowedTools) === stableJson(evidence.allowedTools) &&
    stableJson(packageRiskEvidence(record.riskEvidence)) === stableJson(packageRiskEvidence(evidence.riskEvidence)) &&
    record.digestSha256 === evidence.digestSha256 && record.fileCount === evidence.fileCount &&
    record.unpackedBytes === evidence.unpackedBytes;
}

function packageRiskEvidence(risk: AgentSkillRecord["riskEvidence"]) {
  const {
    reviewStatus: _reviewStatus,
    reviewedDigestSha256: _reviewedDigestSha256,
    externalOrigins = [],
    ...contentEvidence
  } = risk;
  return { ...contentEvidence, externalOrigins };
}

function migrationDescriptor(server: AgentMcpServerDescriptor): AgentMcpServerDescriptor {
  if (server.transport === "stdio") {
    return server.envKeys.length > 0
      ? { ...server, enabled: false, envKeys: [...server.envKeys], migrationStatus: "reauthorization_required" }
      : { ...server, enabled: false };
  }
  if (server.auth.kind === "bearer" || server.auth.kind === "oauth") {
    return {
      ...server,
      enabled: false,
      auth: { kind: server.auth.kind, credentialRef: "pending" },
      migrationStatus: "reauthorization_required"
    };
  }
  return { ...server, enabled: false };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareBinaryText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
