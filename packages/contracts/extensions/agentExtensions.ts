import { createHash } from "node:crypto";
import {
  analyzeMcpArgument,
  isSafeMcpCommandPath,
  isUnsafeMcpCommand
} from "./agentMcpDescriptorSecurity.js";

export const AGENT_EXTENSION_SCHEMA_VERSION = 1 as const;
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
export const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MCP_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_TOOL_PATTERN = /^[A-Za-z0-9_.:/@*?()=,+-]+$/u;
const SAFE_MCP_ARGUMENT_PATTERN = /^[A-Za-z0-9._~:/=@,+%-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export type AgentSkillSourceUpload = { kind: "upload" };
export type AgentSkillSourceCopy = { kind: "copy"; agentId: string; skillId: string };
export type AgentSkillSource = AgentSkillSourceUpload | AgentSkillSourceCopy | { kind: "bundled"; bundleId: string };

export interface AgentSkillMcpDependency {
  id: string;
  description: string;
  transport: "streamable_http";
  url: string;
}

export type AgentSkillDeclaredFileAccess = "read" | "write" | "shell";

export interface AgentSkillRiskEvidence {
  reviewVersion: 1;
  reviewStatus: "unreviewed" | "approved";
  reviewedDigestSha256: string | null;
  classification: "instruction-only" | "script-bearing";
  hasScripts: boolean;
  hasExternalUrls: boolean;
  externalOrigins?: string[];
  mcpDependencies: AgentSkillMcpDependency[];
  declaredFileAccess: AgentSkillDeclaredFileAccess[];
  allowImplicitInvocation: boolean | null;
}

export interface AgentSkillRecord {
  id: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string[];
  riskEvidence: AgentSkillRiskEvidence;
  enabled: boolean;
  entry: "SKILL.md";
  digestSha256: string;
  fileCount: number;
  unpackedBytes: number;
  installedAt: string;
  source: AgentSkillSource;
  approval?: {
    status: "unapproved" | "approved";
    digestSha256: string | null;
    approvedAt: string | null;
  };
}

export interface AgentSkillIndex {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  revision: string;
  skills: AgentSkillRecord[];
}

export type AgentMcpApprovalMode = "always" | "mutating" | "never";

interface AgentMcpServerPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  required?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  ordinaryUserTools?: string[];
  approvalMode?: AgentMcpApprovalMode;
  migrationStatus?: "reauthorization_required";
}

export interface AgentMcpStdioServerDescriptor extends AgentMcpServerPolicy {
  transport: "stdio";
  command: string;
  args: string[];
  envKeys: string[];
}

export interface AgentMcpHttpServerDescriptor extends AgentMcpServerPolicy {
  transport: "streamable_http";
  url: string;
  auth:
    | { kind: "none" }
    | { kind: "bearer" | "oauth"; credentialRef: string };
}

export type AgentMcpServerDescriptor =
  | AgentMcpStdioServerDescriptor
  | AgentMcpHttpServerDescriptor;

export function mcpDescriptorEnvKeys(server: AgentMcpServerDescriptor, agentId?: string) {
  if (server.transport === "stdio") {
    if (agentId === undefined) return server.envKeys;
    return server.envKeys.map((key) => mcpStdioCredentialEnvironmentKey(agentId, server.id, key));
  }
  if (server.auth.kind !== "bearer" || agentId === undefined) return [];
  return [mcpHttpCredentialEnvironmentKey(agentId, server.id, server.auth.credentialRef, server.url)];
}

export function mcpStdioCredentialEnvironmentKey(
  agentId: string,
  serverId: string,
  logicalKey: string
) {
  const safeAgentId = assertAgentId(agentId);
  const safeServerId = assertExtensionId(serverId, "serverId");
  const safeLogicalKey = assertMcpEnvKey(logicalKey, "logicalKey");
  const digest = createHash("sha256")
    .update(JSON.stringify([safeAgentId, safeServerId, safeLogicalKey]))
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return `SUNABOT_MCP_STDIO_SECRET_${digest}`;
}

export function mcpHttpCredentialEnvironmentKey(
  agentId: string,
  serverId: string,
  credentialRef: string,
  resource: string
) {
  const safeAgentId = assertAgentId(agentId);
  const safeServerId = assertExtensionId(serverId, "serverId");
  if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(credentialRef) || credentialRef.includes("..")) {
    invalid("AGENT_EXTENSION_MCP_CREDENTIAL_REF_INVALID", "MCP credentialRef 无效。", "credentialRef");
  }
  let canonicalResource = "";
  try {
    const url = new URL(resource);
    const localhost = url.hostname.toLowerCase() === "localhost";
    if ((url.protocol !== "https:" && !(localhost && url.protocol === "http:")) ||
        url.username || url.password || url.hash) throw new Error("unsafe");
    canonicalResource = url.toString();
  } catch {
    invalid("AGENT_EXTENSION_MCP_URL_INVALID", "MCP resource URL 无效。", "resource");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([safeAgentId, safeServerId, credentialRef, canonicalResource]))
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return `SUNABOT_MCP_HTTP_BEARER_${digest}`;
}

export interface AgentMcpServerIndex {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  revision: string;
  servers: AgentMcpServerDescriptor[];
}

export interface AgentMcpSecretStatus {
  configuredKeys: string[];
  missingKeys: string[];
}

export type AgentExtensionConflictStatus = "none" | "same-content" | "different-content";

export interface AgentSkillFileManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AgentMcpMigrationPreview {
  server: AgentMcpServerDescriptor;
  descriptorVersion: string;
  conflict: AgentExtensionConflictStatus;
  sourceSecrets: AgentMcpSecretStatus;
  targetSecrets: AgentMcpSecretStatus;
  targetState: "disabled";
  requiresAuthorization: boolean;
}

export interface AgentExtensionCopyPreview {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  previewRevision: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceSkillRevision: string;
  targetSkillRevision: string;
  sourceMcpRevision: string;
  targetMcpRevision: string;
  skill: {
    record: AgentSkillRecord;
    contentVersion: string;
    files: AgentSkillFileManifestEntry[];
    conflict: AgentExtensionConflictStatus;
    declaredMcpDependencies: AgentSkillMcpDependency[];
    declaredMcpDependenciesStatus: "none" | "declared" | "missing";
    missingMcpDependencies: string[];
  };
  selectedMcpServers: AgentMcpMigrationPreview[];
}

export type AgentExtensionCopyConflictStrategy = "skip" | "replace" | "rename";

export interface AgentExtensionCopyApplyResult {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  sourceAgentId: string;
  targetAgentId: string;
  skill: AgentSkillRecord | null;
  skipped: boolean;
  mcpServers: AgentMcpServerDescriptor[];
}

export interface AgentExtensionOverview {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  agentId: string;
  skills: AgentSkillRecord[];
  mcp: {
    servers: AgentMcpServerDescriptor[];
    secrets: AgentMcpSecretStatus;
  };
}

export class AgentExtensionContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "AgentExtensionContractError";
  }
}

export function compareBinaryText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function emptyAgentSkillIndex(): AgentSkillIndex {
  return {
    schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
    revision: "0".repeat(64),
    skills: []
  };
}

export function emptyAgentMcpServerIndex(): AgentMcpServerIndex {
  return {
    schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
    revision: "0".repeat(64),
    servers: []
  };
}

export function assertAgentId(value: unknown, field = "agentId") {
  const agentId = stringValue(value, field, 32);
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentExtensionContractError(
      "AGENT_EXTENSION_AGENT_ID_INVALID",
      "Agent ID 需要使用 2-32 位小写字母、数字或连字符，并以字母开头。",
      field
    );
  }
  return agentId;
}

export function assertExtensionId(value: unknown, field = "id") {
  const id = stringValue(value, field, 64);
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new AgentExtensionContractError(
      "AGENT_EXTENSION_ID_INVALID",
      "扩展 ID 需要使用 1-64 位小写字母、数字或连字符。",
      field
    );
  }
  return id;
}

export function assertMcpEnvKey(value: unknown, field = "envKey") {
  const key = stringValue(value, field, 128);
  if (!MCP_ENV_KEY_PATTERN.test(key) || isReservedMcpEnvKey(key)) {
    throw new AgentExtensionContractError(
      "AGENT_EXTENSION_ENV_KEY_INVALID",
      "MCP 环境变量名称无效或属于保留项。",
      field
    );
  }
  return key;
}

export function parseAgentSkillIndex(value: unknown): AgentSkillIndex {
  const object = strictObject(value, ["schemaVersion", "revision", "skills"], "Skill 索引");
  assertSchemaVersion(object.schemaVersion, "Skill 索引");
  const revision = sha256Value(object.revision, "revision");
  if (!Array.isArray(object.skills) || object.skills.length > 512) {
    invalid("AGENT_EXTENSION_INDEX_INVALID", "Skill 索引列表无效。", "skills");
  }
  const skills = object.skills.map((record, index) => parseAgentSkillRecord(record, `skills[${index}]`));
  assertUnique(skills.map((record) => record.id), "Skill 索引包含重复 ID。", "skills");
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision, skills };
}

export function parseAgentSkillRecord(value: unknown, field = "skill"): AgentSkillRecord {
  const raw = recordValue(value, field);
  const keys = [
    "id", "name", "description", "license", "compatibility", "metadata", "allowedTools", "riskEvidence",
    "enabled", "entry", "digestSha256",
    "fileCount", "unpackedBytes", "installedAt", "source"
  ];
  const object = strictObject(value, "approval" in raw ? [...keys, "approval"] : keys, field);
  const id = assertExtensionId(object.id, `${field}.id`);
  const name = assertExtensionId(object.name, `${field}.name`);
  if (id !== name) invalid("AGENT_EXTENSION_SKILL_NAME_MISMATCH", "Skill ID 必须与 frontmatter name 一致。", field);
  const description = stringValue(object.description, `${field}.description`, 1_024);
  const license = nullableString(object.license, `${field}.license`, 256);
  const compatibility = nullableString(object.compatibility, `${field}.compatibility`, 500);
  const metadata = parseSkillMetadata(object.metadata, `${field}.metadata`);
  const allowedTools = stringArray(object.allowedTools, `${field}.allowedTools`, 64, 128);
  if (allowedTools.some((tool) => !ALLOWED_TOOL_PATTERN.test(tool))) {
    invalid("AGENT_EXTENSION_SKILL_ALLOWED_TOOLS_INVALID", "Skill allowedTools 无效。", `${field}.allowedTools`);
  }
  const riskEvidence = parseSkillRiskEvidence(object.riskEvidence, `${field}.riskEvidence`);
  if (typeof object.enabled !== "boolean") invalid("AGENT_EXTENSION_INDEX_INVALID", "Skill enabled 无效。", field);
  if (object.entry !== "SKILL.md") invalid("AGENT_EXTENSION_INDEX_INVALID", "Skill 入口无效。", field);
  const digestSha256 = sha256Value(object.digestSha256, `${field}.digestSha256`);
  const fileCount = boundedInteger(object.fileCount, 1, 512, `${field}.fileCount`);
  const unpackedBytes = boundedInteger(object.unpackedBytes, 1, 32 * 1024 * 1024, `${field}.unpackedBytes`);
  const installedAt = isoTimestamp(object.installedAt, `${field}.installedAt`);
  const source = parseSkillSource(object.source, `${field}.source`);
  const approval = "approval" in object ? parseSkillApproval(object.approval, `${field}.approval`, digestSha256) : undefined;
  return {
    id,
    name,
    description,
    license,
    compatibility,
    metadata,
    allowedTools,
    riskEvidence,
    enabled: object.enabled,
    entry: "SKILL.md",
    digestSha256,
    fileCount,
    unpackedBytes,
    installedAt,
    source,
    ...(approval ? { approval } : {})
  };
}

function parseSkillApproval(value: unknown, field: string, recordDigest: string) {
  const object = strictObject(value, ["status", "digestSha256", "approvedAt"], field);
  if (object.status === "unapproved") {
    if (object.digestSha256 !== null || object.approvedAt !== null) {
      invalid("AGENT_EXTENSION_SKILL_APPROVAL_INVALID", "Skill 审批状态无效。", field);
    }
    return { status: "unapproved" as const, digestSha256: null, approvedAt: null };
  }
  if (object.status !== "approved") {
    invalid("AGENT_EXTENSION_SKILL_APPROVAL_INVALID", "Skill 审批状态无效。", field);
  }
  const digestSha256 = sha256Value(object.digestSha256, `${field}.digestSha256`);
  const approvedAt = isoTimestamp(object.approvedAt, `${field}.approvedAt`);
  if (digestSha256 !== recordDigest) {
    invalid("AGENT_EXTENSION_SKILL_APPROVAL_INVALID", "Skill 审批摘要无效。", field);
  }
  return { status: "approved" as const, digestSha256, approvedAt };
}

export function parseAgentMcpServerIndex(value: unknown): AgentMcpServerIndex {
  const object = strictObject(value, ["schemaVersion", "revision", "servers"], "MCP 索引");
  assertSchemaVersion(object.schemaVersion, "MCP 索引");
  const revision = sha256Value(object.revision, "revision");
  if (!Array.isArray(object.servers) || object.servers.length > 128) {
    invalid("AGENT_EXTENSION_MCP_INDEX_INVALID", "MCP 服务列表无效。", "servers");
  }
  const servers = object.servers.map((server, index) => parseAgentMcpServerDescriptor(server, `servers[${index}]`));
  assertUnique(servers.map((server) => server.id), "MCP 服务列表包含重复 ID。", "servers");
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision, servers };
}

export function parseAgentMcpServerDescriptor(
  value: unknown,
  field = "server"
): AgentMcpServerDescriptor {
  const raw = recordValue(value, field);
  const commonKeys = [
    "id", "name", "description", "enabled", "transport",
    "required", "enabledTools", "disabledTools", "approvalMode"
  ];
  const ordinaryUserKeys = "ordinaryUserTools" in raw ? ["ordinaryUserTools"] : [];
  const migrationKeys = "migrationStatus" in raw ? ["migrationStatus"] : [];
  const transport = raw.transport;
  const legacyStdio = transport === "stdio" &&
    !["required", "enabledTools", "disabledTools", "approvalMode"].some((key) => key in raw);
  const object = strictObject(value, transport === "stdio"
    ? legacyStdio
      ? ["id", "name", "description", "enabled", "transport", ...migrationKeys, "command", "args", "envKeys"]
      : [...commonKeys, ...ordinaryUserKeys, ...migrationKeys, "command", "args", "envKeys"]
    : transport === "streamable_http"
      ? [...commonKeys, ...ordinaryUserKeys, ...migrationKeys, "url", "auth"]
      : commonKeys, field);
  const id = assertExtensionId(object.id, `${field}.id`);
  const name = stringValue(object.name, `${field}.name`, 128);
  const description = stringValue(object.description, `${field}.description`, 1_024, true);
  if (typeof object.enabled !== "boolean") invalid("AGENT_EXTENSION_MCP_INVALID", "MCP enabled 无效。", field);
  const policy = legacyStdio ? {} : parseMcpPolicy(object, field);
  const migrationStatus = "migrationStatus" in object
    ? parseMcpMigrationStatus(object.migrationStatus, `${field}.migrationStatus`)
    : undefined;
  if (object.transport === "streamable_http") {
    const url = safeMcpServerUrl(object.url, `${field}.url`);
    const auth = parseMcpAuth(object.auth, `${field}.auth`);
    if ("ordinaryUserTools" in policy && policy.ordinaryUserTools && auth.kind !== "none") {
      invalid(
        "AGENT_EXTENSION_MCP_ORDINARY_USER_CREDENTIAL_FORBIDDEN",
        "带凭据的 MCP 服务不能向普通用户开放。",
        `${field}.ordinaryUserTools`
      );
    }
    return {
      id,
      name,
      description,
      enabled: object.enabled,
      ...policy,
      ...(migrationStatus ? { migrationStatus } : {}),
      transport: "streamable_http",
      url,
      auth
    };
  }
  if (object.transport !== "stdio") invalid("AGENT_EXTENSION_MCP_INVALID", "MCP transport 不受支持。", field);
  const command = stringValue(object.command, `${field}.command`, 512);
  if (!isSafeMcpCommandPath(command) || isUnsafeMcpCommand(command)) {
    invalid("AGENT_EXTENSION_MCP_COMMAND_INVALID", "MCP command 必须是容器内绝对路径。", `${field}.command`);
  }
  if (!Array.isArray(object.args) || object.args.length > 64) {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP args 无效。", `${field}.args`);
  }
  const args = object.args.map((arg, index) => {
    const parsed = stringValue(arg, `${field}.args[${index}]`, 1_024, true);
    const analysis = analyzeMcpArgument(parsed);
    if (analysis.credential) {
      invalid(
        "AGENT_EXTENSION_MCP_SECRET_ARGUMENT_REJECTED",
        "MCP 凭据必须通过 envKeys 提供，不能写入 args。",
        `${field}.args[${index}]`
      );
    }
    if (!parsed || !SAFE_MCP_ARGUMENT_PATTERN.test(parsed) || analysis.decodeLimitExceeded || analysis.unsafePath) {
      invalid("AGENT_EXTENSION_MCP_ARGUMENT_INVALID", "MCP 参数必须使用可审计语法和容器虚拟路径。", `${field}.args[${index}]`);
    }
    return parsed;
  });
  if (!Array.isArray(object.envKeys) || object.envKeys.length > 64) {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP envKeys 无效。", `${field}.envKeys`);
  }
  const envKeys = object.envKeys.map((key, index) => assertMcpEnvKey(key, `${field}.envKeys[${index}]`));
  assertUnique(envKeys, "MCP envKeys 包含重复项。", `${field}.envKeys`);
  if ("ordinaryUserTools" in policy && policy.ordinaryUserTools && envKeys.length > 0) {
    invalid(
      "AGENT_EXTENSION_MCP_ORDINARY_USER_CREDENTIAL_FORBIDDEN",
      "带凭据的 MCP 服务不能向普通用户开放。",
      `${field}.ordinaryUserTools`
    );
  }
  return {
    id,
    name,
    description,
    enabled: object.enabled,
    ...policy,
    ...(migrationStatus ? { migrationStatus } : {}),
    transport: "stdio",
    command,
    args,
    envKeys
  };
}

function parseSkillRiskEvidence(value: unknown, field: string): AgentSkillRiskEvidence {
  const raw = recordValue(value, field);
  const keys = [
    "reviewVersion", "reviewStatus", "reviewedDigestSha256", "classification", "hasScripts",
    "hasExternalUrls", "mcpDependencies", "declaredFileAccess", "allowImplicitInvocation"
  ];
  const object = strictObject(value, "externalOrigins" in raw ? [...keys, "externalOrigins"] : keys, field);
  const reviewValid = object.reviewStatus === "unreviewed"
    ? object.reviewedDigestSha256 === null
    : object.reviewStatus === "approved" && typeof object.reviewedDigestSha256 === "string" &&
      SHA256_PATTERN.test(object.reviewedDigestSha256);
  if (object.reviewVersion !== 1 || !reviewValid ||
      typeof object.hasScripts !== "boolean" || typeof object.hasExternalUrls !== "boolean" ||
      (object.classification !== "instruction-only" && object.classification !== "script-bearing") ||
      (object.classification === "script-bearing") !== object.hasScripts ||
      (object.allowImplicitInvocation !== null && typeof object.allowImplicitInvocation !== "boolean")) {
    invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill 风险证据无效。", field);
  }
  if (!Array.isArray(object.mcpDependencies) || object.mcpDependencies.length > 32) {
    invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill MCP 依赖无效。", `${field}.mcpDependencies`);
  }
  const mcpDependencies = object.mcpDependencies.map((dependency, index) =>
    parseAgentSkillMcpDependency(dependency, `${field}.mcpDependencies[${index}]`))
    .sort((left, right) => compareBinaryText(left.id, right.id));
  assertUnique(mcpDependencies.map((dependency) => dependency.id), "Skill MCP 依赖包含重复 ID。", field);
  const declaredFileAccessValues = stringArray(object.declaredFileAccess, `${field}.declaredFileAccess`, 3, 5)
    .map((access) => {
      if (access !== "read" && access !== "write" && access !== "shell") {
        invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill 文件访问声明无效。", field);
      }
      return access;
    }) as AgentSkillDeclaredFileAccess[];
  const declaredFileAccess = (["read", "write", "shell"] as const)
    .filter((access) => declaredFileAccessValues.includes(access));
  const externalOrigins = "externalOrigins" in object
    ? stringArray(object.externalOrigins, `${field}.externalOrigins`, 32, 512).map((origin, index) => {
        let parsed: URL;
        try { parsed = new URL(origin); } catch {
          invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill 外部来源证据无效。", `${field}.externalOrigins[${index}]`);
        }
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin ||
            parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
          invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill 外部来源证据无效。", `${field}.externalOrigins[${index}]`);
        }
        return origin;
      }).sort(compareBinaryText)
    : undefined;
  if (externalOrigins && new Set(externalOrigins).size !== externalOrigins.length) {
    invalid("AGENT_EXTENSION_RISK_EVIDENCE_INVALID", "Skill 外部来源证据包含重复项。", `${field}.externalOrigins`);
  }
  return {
    reviewVersion: 1,
    reviewStatus: object.reviewStatus as AgentSkillRiskEvidence["reviewStatus"],
    reviewedDigestSha256: object.reviewedDigestSha256 as string | null,
    classification: object.classification,
    hasScripts: object.hasScripts,
    hasExternalUrls: object.hasExternalUrls,
    ...(externalOrigins ? { externalOrigins } : {}),
    mcpDependencies,
    declaredFileAccess,
    allowImplicitInvocation: object.allowImplicitInvocation
  };
}

function parseMcpPolicy(object: Record<string, unknown>, field: string) {
  if (typeof object.required !== "boolean") {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP required 无效。", `${field}.required`);
  }
  const enabledTools = mcpToolNameArray(object.enabledTools, `${field}.enabledTools`);
  const disabledTools = mcpToolNameArray(object.disabledTools, `${field}.disabledTools`);
  const ordinaryUserTools = "ordinaryUserTools" in object
    ? mcpToolNameArray(object.ordinaryUserTools, `${field}.ordinaryUserTools`)
    : [];
  if (enabledTools.some((tool) => disabledTools.includes(tool))) {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP 工具 allow/deny 列表冲突。", field);
  }
  if (ordinaryUserTools.some((tool) => !enabledTools.includes(tool) || disabledTools.includes(tool))) {
    invalid("AGENT_EXTENSION_MCP_INVALID", "普通用户 MCP 工具必须属于显式 allowlist。", field);
  }
  if (object.approvalMode !== "always" && object.approvalMode !== "mutating" && object.approvalMode !== "never") {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP approvalMode 无效。", `${field}.approvalMode`);
  }
  return {
    required: object.required,
    enabledTools,
    disabledTools,
    ...(ordinaryUserTools.length ? { ordinaryUserTools } : {}),
    approvalMode: object.approvalMode
  } as const;
}

function parseMcpMigrationStatus(value: unknown, field: string): "reauthorization_required" {
  if (value !== "reauthorization_required") {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP 迁移授权状态无效。", field);
  }
  return value;
}

function mcpToolNameArray(value: unknown, field: string) {
  const names = stringArray(value, field, 256, 128);
  if (names.some((name) => !/^[A-Za-z0-9_.:/-]+$/u.test(name))) {
    invalid("AGENT_EXTENSION_MCP_INVALID", "MCP 工具名称无效。", field);
  }
  return names;
}

function parseMcpAuth(value: unknown, field: string): AgentMcpHttpServerDescriptor["auth"] {
  const raw = recordValue(value, field);
  if (raw.kind === "none") {
    strictObject(value, ["kind"], field);
    return { kind: "none" };
  }
  if (raw.kind === "bearer" || raw.kind === "oauth") {
    const object = strictObject(value, ["kind", "credentialRef"], field);
    const credentialRef = stringValue(object.credentialRef, `${field}.credentialRef`, 128);
    const validReference = /^[a-z][a-z0-9._/-]{1,127}$/u.test(credentialRef) && !credentialRef.includes("..");
    const validOAuthHandle = raw.kind === "oauth" && /^mcpcred_[A-Za-z0-9_-]{24,120}$/u.test(credentialRef);
    if (!validReference && !validOAuthHandle) {
      invalid("AGENT_EXTENSION_MCP_CREDENTIAL_REF_INVALID", "MCP credentialRef 无效。", `${field}.credentialRef`);
    }
    return { kind: raw.kind, credentialRef };
  }
  invalid("AGENT_EXTENSION_MCP_INVALID", "MCP auth 无效。", field);
}

function safeMcpServerUrl(value: unknown, field: string) {
  const raw = stringValue(value, field, 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    invalid("AGENT_EXTENSION_MCP_URL_INVALID", "MCP URL 无效。", field);
  }
  const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if ((parsed.protocol !== "https:" && !(localhost && parsed.protocol === "http:")) ||
      !parsed.hostname || parsed.username || parsed.password || parsed.hash || containsCredentialMaterial(raw)) {
    invalid("AGENT_EXTENSION_MCP_URL_INVALID", "MCP URL 无效。", field);
  }
  return parsed.toString();
}

function recordValue(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("AGENT_EXTENSION_CONFIG_INVALID", `${field}结构无效。`, field);
  }
  return value as Record<string, unknown>;
}

export function parseAgentSkillMcpDependency(value: unknown, field = "dependency"): AgentSkillMcpDependency {
  const object = strictObject(value, ["id", "description", "transport", "url"], field);
  const id = assertExtensionId(object.id, `${field}.id`);
  const description = stringValue(object.description, `${field}.description`, 500, true);
  if (object.transport !== "streamable_http") {
    invalid("AGENT_EXTENSION_MCP_DEPENDENCY_INVALID", "Skill MCP transport 不受支持。", `${field}.transport`);
  }
  const url = safeMcpDependencyUrl(object.url, `${field}.url`);
  return { id, description, transport: "streamable_http", url };
}

function parseSkillMetadata(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("AGENT_EXTENSION_SKILL_METADATA_INVALID", "Skill metadata 无效。", field);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) invalid("AGENT_EXTENSION_SKILL_METADATA_INVALID", "Skill metadata 超限。", field);
  const metadata: Record<string, string> = {};
  let budget = 0;
  for (const [key, raw] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(key)) {
      invalid("AGENT_EXTENSION_SKILL_METADATA_INVALID", "Skill metadata key 无效。", field);
    }
    const value = stringValue(raw, `${field}.${key}`, 256, true);
    budget += key.length + value.length;
    if (budget > 4_096) invalid("AGENT_EXTENSION_SKILL_METADATA_INVALID", "Skill metadata 超限。", field);
    metadata[key] = value;
  }
  return metadata;
}

function parseSkillSource(value: unknown, field: string): AgentSkillSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("AGENT_EXTENSION_INDEX_INVALID", "Skill 来源无效。", field);
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "upload") {
    strictObject(value, ["kind"], field);
    return { kind };
  }
  if (kind === "copy") {
    const object = strictObject(value, ["kind", "agentId", "skillId"], field);
    return {
      kind,
      agentId: assertAgentId(object.agentId, `${field}.agentId`),
      skillId: assertExtensionId(object.skillId, `${field}.skillId`)
    };
  }
  if (kind === "bundled") {
    const object = strictObject(value, ["kind", "bundleId"], field);
    return { kind, bundleId: assertExtensionId(object.bundleId, `${field}.bundleId`) };
  }
  invalid("AGENT_EXTENSION_INDEX_INVALID", "Skill 来源无效。", field);
}

function strictObject(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("AGENT_EXTENSION_CONFIG_INVALID", `${label}结构无效。`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(object).some((key) => !allowed.has(key)) || keys.some((key) => !(key in object))) {
    invalid("AGENT_EXTENSION_CONFIG_INVALID", `${label}字段无效。`);
  }
  return object;
}

function assertSchemaVersion(value: unknown, label: string) {
  if (value !== AGENT_EXTENSION_SCHEMA_VERSION) {
    throw new AgentExtensionContractError(
      "AGENT_EXTENSION_SCHEMA_UNSUPPORTED",
      `${label} schemaVersion 不受支持。`,
      "schemaVersion"
    );
  }
}

function stringValue(value: unknown, field: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    invalid("AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  if (!isWellFormedUnicode(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    invalid("AGENT_EXTENSION_VALUE_INVALID", `${field} 包含非法字符。`, field);
  }
  return value;
}

function nullableString(value: unknown, field: string, maxLength: number) {
  return value === null ? null : stringValue(value, field, maxLength);
}

function stringArray(value: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalid("AGENT_EXTENSION_VALUE_INVALID", `${field} 无效。`, field);
  }
  const values = value.map((entry, index) => stringValue(entry, `${field}[${index}]`, maxLength));
  assertUnique(values, `${field} 包含重复项。`, field);
  return values.sort();
}

function safeMcpDependencyUrl(value: unknown, field: string) {
  const raw = stringValue(value, field, 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    invalid("AGENT_EXTENSION_MCP_DEPENDENCY_INVALID", "Skill MCP URL 无效。", field);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash || containsCredentialMaterial(raw)) {
    invalid("AGENT_EXTENSION_MCP_DEPENDENCY_INVALID", "Skill MCP URL 无效。", field);
  }
  return parsed.toString();
}

function containsCredentialMaterial(value: string) {
  return analyzeMcpArgument(value).credential;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function sha256Value(value: unknown, field: string) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("AGENT_EXTENSION_CONFIG_INVALID", `${field} 无效。`, field);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid("AGENT_EXTENSION_CONFIG_INVALID", `${field} 无效。`, field);
  }
  return Number(value);
}

function isoTimestamp(value: unknown, field: string) {
  const timestamp = stringValue(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) invalid("AGENT_EXTENSION_CONFIG_INVALID", `${field} 无效。`, field);
  return timestamp;
}

function assertUnique(values: string[], message: string, field: string) {
  if (new Set(values).size !== values.length) invalid("AGENT_EXTENSION_CONFIG_INVALID", message, field);
}

function isReservedMcpEnvKey(key: string) {
  return key === "PATH" || key === "HOME" || key === "PWD" || key === "SHELL" || key === "USER" ||
    key === "LOGNAME" || key === "TERM" || key === "NODE_OPTIONS" || key === "BASH_ENV" ||
    key.endsWith("_PROXY") || /^(?:LD_|DYLD_|DOCKER_|SUNABOT_|CODEX_)/u.test(key);
}

function invalid(code: string, message: string, field?: string): never {
  throw new AgentExtensionContractError(code, message, field);
}
