import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  AgentExtensionContractError,
  assertAgentId,
  assertExtensionId,
  type AgentExtensionOverview,
  type AgentExtensionCopyPreview,
  type AgentMcpSecretStatus,
  type AgentMcpServerIndex,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";

export const MAX_SKILL_ARCHIVE_BYTES = 16 * 1024 * 1024;

export interface AgentMcpCredentialStatusQuery {
  agentId: string;
  serverId: string;
  envKeys: string[];
}

export type AgentMcpCredentialStatusResolver = (
  query: AgentMcpCredentialStatusQuery
) => Promise<AgentMcpSecretStatus>;

export interface AgentExtensionRepository {
  ensureLayout(agentId: string): Promise<void>;
  readSkillIndex(agentId: string): Promise<AgentSkillIndex>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
  installSkill(input: {
    agentId: string;
    archive: Buffer;
    replace: boolean;
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
  uninstallSkill(input: {
    agentId: string;
    skillId: string;
  }): Promise<AgentSkillRecord>;
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
    private readonly credentialStatus: AgentMcpCredentialStatusResolver = missingCredentialStatus
  ) {}

  async ensureLayout(agentIdValue: unknown) {
    return this.call(async () => this.repository.ensureLayout(assertAgentId(agentIdValue)));
  }

  async overview(agentIdValue: unknown): Promise<AgentExtensionOverview> {
    return this.call(async () => {
      const agentId = assertAgentId(agentIdValue);
      const [skillIndex, mcpIndex] = await Promise.all([
        this.repository.readSkillIndex(agentId),
        this.repository.readMcpServerIndex(agentId)
      ]);
      const statuses = await Promise.all(mcpIndex.servers.map(async (server) => ({
        server,
        status: await this.resolveCredentialStatus(agentId, server.id, server.envKeys)
      })));
      const requiredKeys = [...new Set(statuses.flatMap(({ server }) => server.envKeys))].sort();
      const missingKeys = requiredKeys.filter((key) => statuses.some(({ server, status }) =>
        server.envKeys.includes(key) && status.missingKeys.includes(key)));
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
      const agentId = assertAgentId(input.agentId);
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
      sourceAgentId: assertAgentId(input.sourceAgentId, "sourceAgentId"),
      targetAgentId: assertAgentId(input.targetAgentId, "targetAgentId"),
      skillId: assertExtensionId(input.skillId, "skillId"),
      mcpServerIds: extensionIdArray(input.mcpServerIds, "mcpServerIds"),
      credentialStatus: (query) => this.resolveCredentialStatus(query.agentId, query.serverId, query.envKeys)
    }));
  }

  async setSkillEnabled(input: { agentId: unknown; skillId: unknown; enabled: unknown }) {
    return this.call(async () => this.repository.setSkillEnabled({
      agentId: assertAgentId(input.agentId),
      skillId: assertExtensionId(input.skillId, "skillId"),
      enabled: requiredBoolean(input.enabled, "enabled")
    }));
  }

  async uninstallSkill(input: { agentId: unknown; skillId: unknown }) {
    return this.call(async () => this.repository.uninstallSkill({
      agentId: assertAgentId(input.agentId),
      skillId: assertExtensionId(input.skillId, "skillId")
    }));
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
