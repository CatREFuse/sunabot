export const AGENT_EXTENSION_SCHEMA_VERSION = 1 as const;
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
export const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MCP_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_TOOL_PATTERN = /^[A-Za-z0-9_.:/@*?()=,+-]+$/u;
const SAFE_MCP_COMMAND_PATTERN = /^\/(?:usr\/(?:local\/)?bin|opt\/[a-z0-9][a-z0-9._-]{0,63}\/bin|app\/bin)\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_MCP_ARGUMENT_PATTERN = /^[A-Za-z0-9._~:/=@,+%-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export interface AgentSkillSourceUpload {
  kind: "upload";
}

export interface AgentSkillSourceCopy {
  kind: "copy";
  agentId: string;
  skillId: string;
}

export type AgentSkillSource = AgentSkillSourceUpload | AgentSkillSourceCopy;

export interface AgentSkillMcpDependency {
  id: string;
  description: string;
  transport: "streamable_http";
  url: string;
}

export type AgentSkillDeclaredFileAccess = "read" | "write" | "shell";

export interface AgentSkillRiskEvidence {
  reviewVersion: 1;
  reviewStatus: "unreviewed";
  reviewedDigestSha256: null;
  classification: "instruction-only" | "script-bearing";
  hasScripts: boolean;
  hasExternalUrls: boolean;
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
}

export interface AgentSkillIndex {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  revision: string;
  skills: AgentSkillRecord[];
}

export interface AgentMcpServerDescriptor {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: "stdio";
  command: string;
  args: string[];
  envKeys: string[];
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
}

export interface AgentExtensionCopyPreview {
  schemaVersion: typeof AGENT_EXTENSION_SCHEMA_VERSION;
  sourceAgentId: string;
  targetAgentId: string;
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
  const object = strictObject(value, [
    "id", "name", "description", "license", "compatibility", "metadata", "allowedTools", "riskEvidence",
    "enabled", "entry", "digestSha256",
    "fileCount", "unpackedBytes", "installedAt", "source"
  ], field);
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
    source
  };
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
  const object = strictObject(value, [
    "id", "name", "description", "enabled", "transport", "command", "args", "envKeys"
  ], field);
  const id = assertExtensionId(object.id, `${field}.id`);
  const name = stringValue(object.name, `${field}.name`, 128);
  const description = stringValue(object.description, `${field}.description`, 1_024, true);
  if (typeof object.enabled !== "boolean") invalid("AGENT_EXTENSION_MCP_INVALID", "MCP enabled 无效。", field);
  if (object.transport !== "stdio") invalid("AGENT_EXTENSION_MCP_INVALID", "当前只支持 stdio MCP。", field);
  const command = stringValue(object.command, `${field}.command`, 512);
  if (!SAFE_MCP_COMMAND_PATTERN.test(command) || isUnsafeMcpCommand(command)) {
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
  return { id, name, description, enabled: object.enabled, transport: "stdio", command, args, envKeys };
}

function parseSkillRiskEvidence(value: unknown, field: string): AgentSkillRiskEvidence {
  const object = strictObject(value, [
    "reviewVersion", "reviewStatus", "reviewedDigestSha256", "classification", "hasScripts",
    "hasExternalUrls", "mcpDependencies", "declaredFileAccess", "allowImplicitInvocation"
  ], field);
  if (object.reviewVersion !== 1 || object.reviewStatus !== "unreviewed" || object.reviewedDigestSha256 !== null ||
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
  return {
    reviewVersion: 1,
    reviewStatus: "unreviewed",
    reviewedDigestSha256: null,
    classification: object.classification,
    hasScripts: object.hasScripts,
    hasExternalUrls: object.hasExternalUrls,
    mcpDependencies,
    declaredFileAccess,
    allowImplicitInvocation: object.allowImplicitInvocation
  };
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

function analyzeMcpArgument(value: string) {
  const decoded = decodedCredentialCandidates(value);
  return {
    credential: decoded.candidates.some((candidate) => candidateContainsCredential(candidate)),
    unsafePath: decoded.candidates.some((candidate) => isUnsafeMcpArgumentPath(candidate)),
    decodeLimitExceeded: decoded.limitExceeded
  };
}

function candidateContainsCredential(candidate: string) {
    if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u.test(candidate) ||
        /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/u.test(candidate) ||
        /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u.test(candidate) ||
        /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/u.test(candidate)) {
      return true;
    }
    return looksLikeOpaqueSecret(candidate) ||
      /(?:^|[^a-z0-9])(?:authorization|bearer|basic[ \t]+[A-Za-z0-9+/=]+|token|secret|password|passwd|api[-_]?key|access[-_]?token|client[-_]?secret|private[-_]?key|cookie|netrc|cert|key)(?:$|[^a-z0-9])/iu.test(candidate) ||
      /(?:^|\s)(?:--header|-H|--cookie|--netrc|--cert|--key)(?:\s|=|$)/u.test(candidate) ||
      /[?&](?:access_token|token|api_key|apikey|key|secret|password)=/iu.test(candidate);
}

function isUnsafeMcpArgumentPath(value: string) {
  for (const fragment of argumentFragments(value)) {
    if (/^https?:\/\//iu.test(fragment)) continue;
    if (/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/\/|~[\\/])/iu.test(fragment) ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(fragment)) {
      return true;
    }
    if (fragment.startsWith("/")) {
      if (fragment === "/workbench") continue;
      if (!fragment.startsWith("/workbench/")) return true;
      if (fragment.slice("/workbench/".length).split("/").some((segment) =>
        !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
        return true;
      }
    }
  }
  return false;
}

function decodedCredentialCandidates(value: string) {
  const maximumCandidates = 24;
  const maximumDepth = 4;
  const queue = [{ value, depth: 0 }];
  const candidates = new Set<string>();
  let limitExceeded = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidate = current.value;
    if (candidates.has(candidate)) continue;
    if (candidates.size >= maximumCandidates) {
      limitExceeded = true;
      break;
    }
    candidates.add(candidate);
    const derived = argumentFragments(candidate).filter((fragment) => fragment !== candidate);
    if (candidate.length <= 4_096) {
      try {
        const percentDecoded = decodeURIComponent(candidate);
        if (percentDecoded !== candidate) derived.push(percentDecoded);
      } catch { /* malformed encoding is rejected by the auditable argument grammar */ }
      const base64Decoded = decodeBase64Utf8(candidate);
      if (base64Decoded != null && base64Decoded !== candidate) derived.push(base64Decoded);
    }
    for (const next of derived) {
      if (!next || candidates.has(next)) continue;
      if (current.depth >= maximumDepth) {
        limitExceeded = true;
      } else {
        queue.push({ value: next, depth: current.depth + 1 });
      }
    }
  }
  return { candidates: [...candidates], limitExceeded };
}

function argumentFragments(value: string) {
  const fragments = new Set([value]);
  let lastSeparator = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "=" || value[index] === ",") {
      const suffix = value.slice(index + 1);
      if (suffix) fragments.add(suffix);
      lastSeparator = index;
    } else if (value[index] === ":") {
      const scheme = value.slice(lastSeparator + 1, index);
      const suffix = value.slice(index + 1);
      if (suffix && !/^https?$/iu.test(scheme)) fragments.add(suffix);
      lastSeparator = index;
    }
  }
  return [...fragments];
}

function decodeBase64Utf8(value: string) {
  if (value.length < 16 || value.length > 4_096 || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) return null;
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (padded.length % 4 !== 0) return null;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeOpaqueSecret(value: string) {
  if (value.length < 24 || value.length > 2_048 || value.startsWith("/workbench/") ||
      /^https?:\/\//iu.test(value) ||
      /^--[a-z0-9-]+=(?:https?:\/\/|\/workbench(?:\/|$)|[a-z0-9._-]{1,64}$)/iu.test(value) ||
      value.startsWith("--") && /^[a-z0-9-]+$/u.test(value)) {
    return false;
  }
  if (/^[a-f0-9]{32,}$/iu.test(value) ||
      /^(?=[A-Z2-7]{32,}={0,6}$)(?=.*[2-7])[A-Z2-7]+=*$/u.test(value) ||
      /^(?=[a-z2-7]{32,}={0,6}$)(?=.*[2-7])[a-z2-7]+=*$/u.test(value)) {
    return true;
  }
  const distinct = new Set(value).size;
  if (/^[A-Za-z0-9]+$/u.test(value) && value.length >= 32 && distinct <= 6) return true;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(value)).length;
  if (classes < 2) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4.1;
}

function isUnsafeMcpCommand(command: string) {
  const segments = command.split("/").filter(Boolean);
  const executable = segments.at(-1) ?? "";
  const dynamicSegments = command.startsWith("/opt/")
    ? [segments[1] ?? "", executable]
    : [executable];
  return dynamicSegments.some((segment) => {
    if (!segment) return true;
    const decoded = decodedCredentialCandidates(segment);
    return decoded.limitExceeded || decoded.candidates.some((candidate) =>
      candidateContainsCredential(candidate) || looksLikeOpaqueExecutableSegment(candidate));
  });
}

function looksLikeOpaqueExecutableSegment(value: string) {
  if (/^[a-f0-9]{32,}$/iu.test(value)) return true;
  if (/^(?=[A-Z2-7]{32,}$)(?=.*[2-7])[A-Z2-7]+$/u.test(value) ||
      /^(?=[a-z2-7]{32,}$)(?=.*[2-7])[a-z2-7]+$/u.test(value)) return true;
  return value.length >= 48 && /^[A-Za-z0-9]+$/u.test(value) && new Set(value).size <= 8;
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
  return key === "PATH" || key === "HOME" || key === "NODE_OPTIONS" || key === "BASH_ENV" ||
    /^(?:LD_|DYLD_|DOCKER_|SUNABOT_|CODEX_)/u.test(key);
}

function invalid(code: string, message: string, field?: string): never {
  throw new AgentExtensionContractError(code, message, field);
}
