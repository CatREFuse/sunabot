import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { createHash } from "node:crypto";
import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  AgentExtensionContractError,
  assertAgentId,
  assertExtensionId,
  mcpDescriptorEnvKeys,
  parseAgentMcpServerDescriptor,
  type AgentExtensionOverview,
  type AgentExtensionCopyPreview,
  type AgentExtensionCopyApplyResult,
  type AgentExtensionCopyConflictStrategy,
  type AgentMcpSecretStatus,
  type AgentMcpServerIndex,
  type AgentMcpServerDescriptor,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import { MAX_SKILL_ARCHIVE_BYTES } from "../../packages/contracts/extensions/agentExtensionLimits.js";
import {
  DeterministicSkillReviewAuditRunner,
  type SkillReviewAuditRunnerPort,
  type SkillReviewPreparation
} from "./skillReview.js";

export { MAX_SKILL_ARCHIVE_BYTES } from "../../packages/contracts/extensions/agentExtensionLimits.js";

export interface AgentMcpCredentialStatusQuery {
  agentId: string;
  serverId: string;
  envKeys: string[];
}

export type AgentMcpCredentialStatusResolver = (
  query: AgentMcpCredentialStatusQuery
) => Promise<AgentMcpSecretStatus>;

export type AgentExtensionAgentResolver = (agentId: string) => boolean | Promise<boolean>;

export interface AgentMcpMutationLifecyclePort {
  invalidateOAuthCredential(input: {
    agentId: string;
    serverId: string;
    resource: string;
    credentialHandle: string;
  }): Promise<void>;
}

export interface AgentExtensionRepository {
  ensureLayout(agentId: string): Promise<void>;
  readSkillIndex(agentId: string): Promise<AgentSkillIndex>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
  installSkill(input: {
    agentId: string;
    archive: Buffer;
    replace: boolean;
    expectedIndexRevision?: string;
  }): Promise<AgentSkillRecord>;
  prepareSkillReview(input: {
    agentId: string;
    skillId: string;
  }): Promise<SkillReviewPreparation>;
  commitSkillReview(input: {
    agentId: string;
    skillId: string;
    expectedIndexRevision: string;
    expectedDigestSha256: string;
    expectedFiles: SkillReviewPreparation["files"];
    auditDigestSha256: string;
  }): Promise<AgentSkillRecord>;
  previewCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds: string[];
    credentialStatus: AgentMcpCredentialStatusResolver;
  }): Promise<AgentExtensionCopyPreview>;
  setSkillEnabled(input: {
    agentId: string;
    skillId: string;
    enabled: boolean;
  }): Promise<AgentSkillRecord>;
  restoreReviewedSkill(input: {
    agentId: string;
    previous: AgentSkillRecord;
  }): Promise<AgentSkillRecord>;
  restoreSkillRecord(input: {
    agentId: string;
    previous: AgentSkillRecord;
  }): Promise<AgentSkillRecord>;
  uninstallSkill(input: {
    agentId: string;
    skillId: string;
    expectedIndexRevision?: string;
  }): Promise<AgentSkillRecord>;
  applyCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds: string[];
    previewRevision: string;
    conflictStrategy: AgentExtensionCopyConflictStrategy;
    renameTo?: string;
    credentialStatus: AgentMcpCredentialStatusResolver;
  }): Promise<AgentExtensionCopyApplyResult>;
  putMcpServer(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
    replace: boolean;
    expectedIndexRevision?: string;
  }): Promise<AgentMcpServerDescriptor>;
  setMcpServerEnabled(input: {
    agentId: string;
    serverId: string;
    enabled: boolean;
    credentialStatus: AgentMcpCredentialStatusResolver;
  }): Promise<AgentMcpServerDescriptor>;
  removeMcpServer(input: {
    agentId: string;
    serverId: string;
    expectedIndexRevision?: string;
  }): Promise<AgentMcpServerDescriptor>;
}

export class AgentExtensionServiceError extends ServiceError {
  constructor(statusCode: number, code: string, message: string, field?: string) {
    super(statusCode, code, message, field);
    this.name = "AgentExtensionServiceError";
  }
}

export class AgentExtensionService {
  constructor(
    private readonly repository: AgentExtensionRepository,
    private readonly credentialStatus: AgentMcpCredentialStatusResolver = missingCredentialStatus,
    private readonly agentExists: AgentExtensionAgentResolver = () => true,
    private readonly skillReviewAudit: SkillReviewAuditRunnerPort = new DeterministicSkillReviewAuditRunner(),
    private readonly mcpMutationLifecycle?: AgentMcpMutationLifecyclePort
  ) {}

  async ensureLayout(agentIdValue: unknown) {
    return this.call(async () => this.repository.ensureLayout(await this.resolveAgent(agentIdValue)));
  }

  async overview(agentIdValue: unknown): Promise<AgentExtensionOverview> {
    return this.call(async () => {
      const agentId = await this.resolveAgent(agentIdValue);
      const [skillIndex, mcpIndex] = await Promise.all([
        this.repository.readSkillIndex(agentId),
        this.repository.readMcpServerIndex(agentId)
      ]);
      const statuses = await Promise.all(mcpIndex.servers.map(async (server) => ({
        server,
        envKeys: mcpDescriptorEnvKeys(server, agentId),
        status: await this.resolveCredentialStatus(agentId, server.id, mcpDescriptorEnvKeys(server, agentId))
      })));
      const requiredKeys = [...new Set(statuses.flatMap(({ envKeys }) => envKeys))].sort();
      const missingKeys = requiredKeys.filter((key) => statuses.some(({ envKeys, status }) =>
        envKeys.includes(key) && status.missingKeys.includes(key)));
      const secrets = {
        configuredKeys: requiredKeys.filter((key) => !missingKeys.includes(key)),
        missingKeys
      };
      return {
        schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
        agentId,
        skills: skillIndex.skills,
        mcp: { servers: mcpIndex.servers, secrets }
      };
    });
  }

  async installSkill(input: { agentId: unknown; archive: Buffer; replace?: unknown }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      if (!Buffer.isBuffer(input.archive) || input.archive.length < 1 || input.archive.length > MAX_SKILL_ARCHIVE_BYTES) {
        throw new AgentExtensionServiceError(400, "SKILL_ARCHIVE_SIZE_INVALID", "Skill ZIP 大小无效。", "archive");
      }
      return this.repository.installSkill({
        agentId,
        archive: input.archive,
        replace: booleanValue(input.replace, "replace")
      });
    });
  }

  async previewCopy(input: {
    sourceAgentId: unknown;
    targetAgentId: unknown;
    skillId: unknown;
    mcpServerIds?: unknown;
  }) {
    return this.call(async () => this.repository.previewCopy({
      sourceAgentId: await this.resolveAgent(input.sourceAgentId, "sourceAgentId"),
      targetAgentId: await this.resolveAgent(input.targetAgentId, "targetAgentId"),
      skillId: assertExtensionId(input.skillId, "skillId"),
      mcpServerIds: extensionIdArray(input.mcpServerIds, "mcpServerIds"),
      credentialStatus: (query) => this.resolveCredentialStatus(query.agentId, query.serverId, query.envKeys)
    }));
  }

  async reviewSkill(input: { agentId: unknown; skillId: unknown; approve: unknown }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      const skillId = assertExtensionId(input.skillId, "skillId");
      if (input.approve !== true) {
        throw new AgentExtensionServiceError(
          400,
          "SKILL_REVIEW_APPROVAL_REQUIRED",
          "Skill 安全审查需要管理员明确批准。",
          "approve"
        );
      }
      const prepared = await this.repository.prepareSkillReview({ agentId, skillId });
      const expectedIndexRevision = prepared.indexRevision;
      const expectedDigestSha256 = prepared.digestSha256;
      const expectedFiles = prepared.files.map((file) => ({ ...file }));
      const auditScripts = prepared.scripts.map((script) => ({ ...script, content: Buffer.from(script.content) }));
      const auditTexts = prepared.texts.map((text) => ({ ...text, content: Buffer.from(text.content) }));
      let decision;
      try {
        decision = await this.runSkillReviewAudit({
          ...prepared,
          files: expectedFiles.map((file) => ({ ...file })),
          scripts: auditScripts,
          texts: auditTexts,
          allowedTools: [...prepared.allowedTools],
          riskEvidence: structuredClone(prepared.riskEvidence),
          administratorApproved: true
        });
      } finally {
        clearReviewBuffers(auditScripts, auditTexts, prepared.scripts, prepared.texts);
      }
      if (!decision.approved || decision.digestSha256 !== expectedDigestSha256) {
        throw new AgentExtensionServiceError(409, "SKILL_REVIEW_REJECTED", "Skill 未通过安全审查。");
      }
      return this.repository.commitSkillReview({
        agentId,
        skillId,
        expectedIndexRevision,
        expectedDigestSha256,
        expectedFiles,
        auditDigestSha256: decision.digestSha256
      });
    });
  }

  async applyCopy(input: {
    sourceAgentId: unknown;
    targetAgentId: unknown;
    skillId: unknown;
    mcpServerIds?: unknown;
    previewRevision: unknown;
    conflictStrategy: unknown;
    renameTo?: unknown;
  }) {
    return this.call(async () => this.repository.applyCopy({
      sourceAgentId: await this.resolveAgent(input.sourceAgentId, "sourceAgentId"),
      targetAgentId: await this.resolveAgent(input.targetAgentId, "targetAgentId"),
      skillId: assertExtensionId(input.skillId, "skillId"),
      mcpServerIds: extensionIdArray(input.mcpServerIds, "mcpServerIds"),
      previewRevision: sha256Value(input.previewRevision, "previewRevision"),
      conflictStrategy: copyConflictStrategy(input.conflictStrategy),
      ...(input.renameTo == null ? {} : { renameTo: assertExtensionId(input.renameTo, "renameTo") }),
      credentialStatus: (query) => this.resolveCredentialStatus(query.agentId, query.serverId, query.envKeys)
    }));
  }

  async setSkillEnabled(input: { agentId: unknown; skillId: unknown; enabled: unknown }) {
    return this.call(async () => this.repository.setSkillEnabled({
      agentId: await this.resolveAgent(input.agentId),
      skillId: assertExtensionId(input.skillId, "skillId"),
      enabled: requiredBoolean(input.enabled, "enabled")
    }));
  }

  async uninstallSkill(input: { agentId: unknown; skillId: unknown }) {
    return this.call(async () => this.repository.uninstallSkill({
      agentId: await this.resolveAgent(input.agentId),
      skillId: assertExtensionId(input.skillId, "skillId")
    }));
  }

  async previewMcpServer(input: { agentId: unknown; server: unknown }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      const server = parseAgentMcpServerDescriptor(input.server);
      return mcpServerInstallPreview(agentId, server);
    });
  }

  async putMcpServer(input: {
    agentId: unknown;
    server: unknown;
    replace?: unknown;
    previewRevision: unknown;
    approveCommand?: unknown;
  }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      const server = parseAgentMcpServerDescriptor(input.server);
      const preview = mcpServerInstallPreview(agentId, server);
      if (sha256Value(input.previewRevision, "previewRevision") !== preview.previewRevision) {
        throw new AgentExtensionServiceError(409, "MCP_INSTALL_PREVIEW_STALE", "MCP 安装预览已失效。");
      }
      if (server.transport === "stdio" && input.approveCommand !== true) {
        throw new AgentExtensionServiceError(
          400,
          "MCP_COMMAND_APPROVAL_REQUIRED",
          "需要确认完整的 MCP 启动命令。",
          "approveCommand"
        );
      }
      const replace = booleanValue(input.replace, "replace");
      const index = await this.repository.readMcpServerIndex(agentId);
      const previous = index.servers.find((candidate) => candidate.id === server.id);
      if (replace && previous) {
        await invalidateChangedOAuthBinding(this.mcpMutationLifecycle, agentId, previous, server);
      }
      return this.repository.putMcpServer({
        agentId,
        server,
        replace,
        expectedIndexRevision: index.revision
      });
    });
  }

  async setMcpServerEnabled(input: { agentId: unknown; serverId: unknown; enabled: unknown }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      const serverId = assertExtensionId(input.serverId, "serverId");
      const enabled = requiredBoolean(input.enabled, "enabled");
      return this.repository.setMcpServerEnabled({
        agentId,
        serverId,
        enabled,
        credentialStatus: (query) => this.resolveCredentialStatus(query.agentId, query.serverId, query.envKeys)
      });
    });
  }

  async removeMcpServer(input: { agentId: unknown; serverId: unknown }) {
    return this.call(async () => {
      const agentId = await this.resolveAgent(input.agentId);
      const serverId = assertExtensionId(input.serverId, "serverId");
      const index = await this.repository.readMcpServerIndex(agentId);
      const previous = index.servers.find((candidate) => candidate.id === serverId);
      if (previous) {
        await invalidateChangedOAuthBinding(this.mcpMutationLifecycle, agentId, previous);
      }
      return this.repository.removeMcpServer({
        agentId,
        serverId,
        expectedIndexRevision: index.revision
      });
    });
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error instanceof AgentExtensionContractError) {
        throw new AgentExtensionServiceError(400, error.code, error.message, error.field);
      }
      if (isStorageIoError(error)) {
        throw new AgentExtensionServiceError(
          503,
          "AGENT_EXTENSION_STORAGE_UNAVAILABLE",
          "Agent 扩展存储暂时不可用。"
        );
      }
      throw error;
    }
  }

  private async resolveAgent(value: unknown, field = "agentId") {
    const agentId = assertAgentId(value, field);
    let exists = false;
    try { exists = await this.agentExists(agentId); } catch { exists = false; }
    if (!exists) {
      throw new AgentExtensionServiceError(404, "AGENT_EXTENSION_AGENT_NOT_FOUND", "Agent 不存在。", field);
    }
    return agentId;
  }

  private async resolveCredentialStatus(agentId: string, serverId: string, envKeys: string[]) {
    const expected = [...new Set(envKeys)].sort();
    try {
      const status = await this.credentialStatus({ agentId, serverId, envKeys: expected });
      const configured = validStatusKeys(status?.configuredKeys, expected);
      const missing = validStatusKeys(status?.missingKeys, expected);
      if (configured.some((key) => missing.includes(key)) ||
          new Set([...configured, ...missing]).size !== expected.length) {
        throw credentialStatusInvalid();
      }
      return { configuredKeys: configured, missingKeys: missing };
    } catch {
      throw credentialStatusInvalid();
    }
  }

  private async runSkillReviewAudit(
    request: Parameters<SkillReviewAuditRunnerPort["review"]>[0]
  ) {
    try {
      const decision = await this.skillReviewAudit.review(request);
      if (!decision || typeof decision.approved !== "boolean" ||
          typeof decision.digestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(decision.digestSha256)) {
        throw new Error("invalid audit decision");
      }
      return decision;
    } catch {
      throw new AgentExtensionServiceError(503, "SKILL_REVIEW_UNAVAILABLE", "Skill 安全审查暂时不可用。");
    }
  }
}

async function invalidateChangedOAuthBinding(
  lifecycle: AgentMcpMutationLifecyclePort | undefined,
  agentId: string,
  previous: AgentMcpServerDescriptor,
  next?: AgentMcpServerDescriptor
) {
  const binding = revocableOAuthBinding(previous);
  if (!binding) return;
  const retained = next?.transport === "streamable_http" &&
    next.url === binding.resource &&
    next.auth.kind === "oauth" &&
    next.auth.credentialRef === binding.credentialHandle;
  if (retained) return;
  if (!lifecycle) throw oauthInvalidationFailed();
  try {
    await lifecycle.invalidateOAuthCredential({
      agentId,
      serverId: previous.id,
      ...binding
    });
  } catch {
    throw oauthInvalidationFailed();
  }
}

function revocableOAuthBinding(server: AgentMcpServerDescriptor) {
  if (server.transport !== "streamable_http" || server.auth.kind !== "oauth" ||
      !/^mcpcred_[A-Za-z0-9_-]{24,120}$/u.test(server.auth.credentialRef)) return undefined;
  return {
    resource: server.url,
    credentialHandle: server.auth.credentialRef
  };
}

function oauthInvalidationFailed() {
  return new AgentExtensionServiceError(
    503,
    "MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED",
    "MCP OAuth 凭据失效失败。"
  );
}

function mcpServerInstallPreview(agentId: string, server: AgentMcpServerDescriptor) {
  const previewRevision = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    agentId,
    server
  })).digest("hex");
  return {
    schemaVersion: 1 as const,
    previewRevision,
    server,
    commandApproval: server.transport === "stdio" ? {
      required: true as const,
      command: server.command,
      args: [...server.args],
      digestSha256: createHash("sha256").update(JSON.stringify([server.command, ...server.args])).digest("hex")
    } : null
  };
}

async function missingCredentialStatus(query: AgentMcpCredentialStatusQuery): Promise<AgentMcpSecretStatus> {
  return { configuredKeys: [], missingKeys: [...query.envKeys] };
}

function validStatusKeys(value: unknown, expected: string[]) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string") || new Set(value).size !== value.length) {
    throw credentialStatusInvalid();
  }
  const keys = [...value].sort() as string[];
  if (keys.some((key) => !expected.includes(key))) {
    throw credentialStatusInvalid();
  }
  return keys;
}

function credentialStatusInvalid() {
  return new AgentExtensionServiceError(
    503,
    "AGENT_EXTENSION_CREDENTIAL_STATUS_INVALID",
    "MCP 凭据状态暂时不可用。"
  );
}

function isStorageIoError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as NodeJS.ErrnoException & { path?: unknown; dest?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const commonWithoutPath = new Set(["EIO", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC", "ESTALE"]);
  const errnoShape = /^E[A-Z0-9]+$/u.test(code);
  return (errnoShape && (
    typeof candidate.syscall === "string" ||
    typeof candidate.path === "string" ||
    typeof candidate.dest === "string"
  )) || commonWithoutPath.has(code);
}

function booleanValue(value: unknown, field: string) {
  if (value == null) return false;
  if (typeof value !== "boolean") {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  return value;
}

function extensionIdArray(value: unknown, field: string) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  const ids = value.map((id, index) => assertExtensionId(id, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_VALUE_INVALID", `${field} 包含重复项。`, field);
  }
  return ids.sort();
}

function sha256Value(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  return value;
}

function copyConflictStrategy(value: unknown): AgentExtensionCopyConflictStrategy {
  if (value !== "skip" && value !== "replace" && value !== "rename") {
    throw new AgentExtensionServiceError(
      400, "AGENT_EXTENSION_VALUE_INVALID", "conflictStrategy 无效。", "conflictStrategy"
    );
  }
  return value;
}

function clearReviewBuffers(...groups: Array<Array<{ content: Buffer }>>) {
  const cleared = new Set<Buffer>();
  for (const group of groups) {
    for (const item of group) {
      if (cleared.has(item.content)) continue;
      item.content.fill(0);
      cleared.add(item.content);
    }
  }
}
