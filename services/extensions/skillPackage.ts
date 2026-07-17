import { createHash } from "node:crypto";
import {
  compareBinaryText,
  assertExtensionId,
  parseAgentSkillMcpDependency,
  type AgentSkillDeclaredFileAccess,
  type AgentSkillMcpDependency,
  type AgentSkillRecord,
  type AgentSkillRiskEvidence,
  type AgentSkillSource
} from "../../packages/contracts/extensions/agentExtensions.js";

export interface SkillPackageFileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillPackageEvidence {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string[];
  riskEvidence: AgentSkillRiskEvidence;
  digestSha256: string;
  fileCount: number;
  unpackedBytes: number;
  files: SkillPackageFileEvidence[];
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string[];
}

export interface SkillPackageRiskInput {
  hasScripts: boolean;
  hasExternalUrls: boolean;
  externalOrigins: string[];
  mcpDependencies: AgentSkillMcpDependency[];
  allowImplicitInvocation: boolean | null;
}

export interface OpenAiSkillMetadata {
  allowImplicitInvocation: boolean | null;
  mcpDependencies: AgentSkillMcpDependency[];
}

const FRONTMATTER_FIELDS = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools"
]);
const OPENAI_INTERFACE_FIELDS = new Set([
  "display_name", "short_description", "icon_small", "icon_large", "brand_color", "default_prompt"
]);
const OPENAI_DEPENDENCY_FIELDS = new Set(["type", "value", "description", "transport", "url"]);
const ALLOWED_TOOL_PATTERN = /^[A-Za-z0-9_.:/@*?()=,+-]+$/u;

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/^\uFEFF/u, "");
  const lines = normalized.split(/\r?\n/u);
  if (lines.length > 500) {
    throw skillPackageError("SKILL_BODY_LINE_LIMIT", "SKILL.md 超过 500 行，请把详细材料放入按需引用文件。");
  }
  if (lines[0] !== "---") throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md 缺少 YAML frontmatter。");
  const closing = lines.slice(1).findIndex((line) => line === "---");
  if (closing < 0) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md frontmatter 未闭合。");
  if (closing > 100) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md frontmatter 字段过多。");

  const values = new Map<string, string>();
  const metadata: Record<string, string> = {};
  let section: "metadata" | null = null;
  let metadataBudget = 0;
  for (const line of lines.slice(1, closing + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    rejectUnsafeYamlSyntax(line, "SKILL.md frontmatter");
    if (line.startsWith("  ")) {
      if (section !== "metadata" || /^\s{2}\S/u.test(line) === false || /^\s{3,}/u.test(line)) {
        throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md metadata 只允许两空格缩进的字符串映射。");
      }
      const match = /^  ([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):(?:[ \t]*(.*))?$/u.exec(line);
      if (!match) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md metadata 字段无效。");
      const key = String(match[1]);
      if (Object.hasOwn(metadata, key)) {
        throw skillPackageError("SKILL_FRONTMATTER_INVALID", `SKILL.md metadata 重复字段：${key}。`);
      }
      const value = yamlScalar(String(match[2] ?? ""), `metadata.${key}`, true);
      if (value.length > 256) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md metadata value 超限。");
      metadataBudget += key.length + value.length;
      if (Object.keys(metadata).length >= 32 || metadataBudget > 4_096) {
        throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md metadata 超限。");
      }
      metadata[key] = value;
      continue;
    }
    if (/^\s/u.test(line)) {
      throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md frontmatter 缩进无效。");
    }
    section = null;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/u.exec(line);
    if (!match) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md frontmatter 包含无效字段。");
    const key = String(match[1]).toLowerCase();
    if (!FRONTMATTER_FIELDS.has(key)) {
      throw skillPackageError("SKILL_FRONTMATTER_INVALID", `SKILL.md frontmatter 不支持字段：${key}。`);
    }
    if (values.has(key)) throw skillPackageError("SKILL_FRONTMATTER_INVALID", `SKILL.md frontmatter 重复字段：${key}。`);
    const raw = String(match[2] ?? "");
    if (key === "metadata") {
      if (raw.trim()) throw skillPackageError("SKILL_FRONTMATTER_INVALID", "SKILL.md metadata 必须使用字符串映射。");
      values.set(key, "");
      section = "metadata";
      continue;
    }
    values.set(key, yamlScalar(raw, key));
  }

  const name = assertExtensionId(values.get("name"), "name");
  if (/(?:anthropic|claude)/u.test(name)) {
    throw skillPackageError("SKILL_NAME_RESERVED", "Skill name 包含保留词。");
  }
  const description = safeText(values.get("description"), "description", 1_024);
  if (description.includes("<") || description.includes(">")) {
    throw skillPackageError("SKILL_DESCRIPTION_INVALID", "SKILL.md description 需要使用 1-1024 个安全字符。");
  }
  const license = optionalSafeText(values.get("license"), "license", 256);
  const compatibility = optionalSafeText(values.get("compatibility"), "compatibility", 500);
  const allowedTools = values.has("allowed-tools")
    ? parseAllowedTools(values.get("allowed-tools") ?? "")
    : [];
  return { name, description, license, compatibility, metadata, allowedTools };
}

export function parseOpenAiSkillMetadata(content: string): OpenAiSkillMetadata {
  try {
    return parseOpenAiSkillMetadataStrict(content);
  } catch (error) {
    if ((error as { code?: unknown }).code === "SKILL_OPENAI_METADATA_INVALID") throw error;
    throw skillPackageError("SKILL_OPENAI_METADATA_INVALID", "agents/openai.yaml 结构或字段无效。");
  }
}

function parseOpenAiSkillMetadataStrict(content: string): OpenAiSkillMetadata {
  const normalized = content.replace(/^\uFEFF/u, "");
  const lines = normalized.split(/\r?\n/u);
  if (lines.length > 200) throw skillPackageError("SKILL_OPENAI_METADATA_INVALID", "agents/openai.yaml 超过行数限制。");
  const sections = new Set<string>();
  const interfaceFields = new Set<string>();
  const dependencyFields = new Set<string>();
  const dependencies: Array<Record<string, string>> = [];
  let section: "interface" | "policy" | "dependencies" | null = null;
  let dependenciesTools = false;
  let allowImplicitInvocation: boolean | null = null;
  let currentDependency: Record<string, string> | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    rejectUnsafeYamlSyntax(line, "agents/openai.yaml");
    if (/^\S/u.test(line)) {
      const match = /^(interface|policy|dependencies):\s*$/u.exec(line);
      const name = match?.[1];
      if (name !== "interface" && name !== "policy" && name !== "dependencies") openAiMetadataInvalid();
      if (sections.has(name)) openAiMetadataInvalid();
      section = name;
      sections.add(name);
      dependenciesTools = false;
      currentDependency = null;
      continue;
    }
    if (/^  \S/u.test(line)) {
      currentDependency = null;
      const match = /^  ([a-z_]+):(?:[ \t]*(.*))?$/u.exec(line);
      if (!match || !section) openAiMetadataInvalid();
      const key = String(match[1]);
      const raw = String(match[2] ?? "");
      if (section === "interface") {
        if (!OPENAI_INTERFACE_FIELDS.has(key) || interfaceFields.has(key)) openAiMetadataInvalid();
        interfaceFields.add(key);
        validateOpenAiInterfaceValue(key, yamlScalar(raw, `interface.${key}`));
      } else if (section === "policy") {
        if (key !== "allow_implicit_invocation" || allowImplicitInvocation !== null) openAiMetadataInvalid();
        const value = raw.trim();
        if (value !== "true" && value !== "false") openAiMetadataInvalid();
        allowImplicitInvocation = value === "true";
      } else {
        if (key !== "tools" || dependenciesTools || raw.trim()) openAiMetadataInvalid();
        dependenciesTools = true;
      }
      continue;
    }
    if (/^    - /u.test(line)) {
      if (section !== "dependencies" || !dependenciesTools) openAiMetadataInvalid();
      const match = /^    - ([a-z_]+):(?:[ \t]*(.*))?$/u.exec(line);
      const key = match?.[1];
      if (!key || !OPENAI_DEPENDENCY_FIELDS.has(key)) openAiMetadataInvalid();
      currentDependency = {};
      dependencies.push(currentDependency);
      dependencyFields.clear();
      setOpenAiDependencyField(currentDependency, dependencyFields, key, String(match?.[2] ?? ""));
      continue;
    }
    if (/^      \S/u.test(line)) {
      if (!currentDependency) openAiMetadataInvalid();
      const match = /^      ([a-z_]+):(?:[ \t]*(.*))?$/u.exec(line);
      const key = match?.[1];
      if (!key || !OPENAI_DEPENDENCY_FIELDS.has(key)) openAiMetadataInvalid();
      setOpenAiDependencyField(currentDependency, dependencyFields, key, String(match?.[2] ?? ""));
      continue;
    }
    openAiMetadataInvalid();
  }

  if (dependencies.length > 32) openAiMetadataInvalid();
  const mcpDependencies = dependencies.map((dependency, index) => {
    if (Object.keys(dependency).length !== OPENAI_DEPENDENCY_FIELDS.size || dependency.type !== "mcp") {
      openAiMetadataInvalid();
    }
    return parseAgentSkillMcpDependency({
      id: dependency.value,
      description: dependency.description,
      transport: dependency.transport,
      url: dependency.url
    }, `dependencies.tools[${index}]`);
  }).sort((left, right) => compareBinaryText(left.id, right.id));
  if (new Set(mcpDependencies.map((dependency) => dependency.id)).size !== mcpDependencies.length) {
    openAiMetadataInvalid();
  }
  return { allowImplicitInvocation, mcpDependencies };
}

export function buildSkillPackageEvidence(
  files: SkillPackageFileEvidence[],
  frontmatter: SkillFrontmatter,
  riskInput: SkillPackageRiskInput = {
    hasScripts: false,
    hasExternalUrls: false,
    externalOrigins: [],
    mcpDependencies: [],
    allowImplicitInvocation: null
  }
): SkillPackageEvidence {
  if (!files.length || files.length > 512) throw skillPackageError("SKILL_PACKAGE_INVALID", "Skill 文件数量无效。");
  const sorted = files.map(normalizeFileEvidence).sort((left, right) => compareBinaryText(left.path, right.path));
  if (!sorted.some((file) => file.path === "SKILL.md")) {
    throw skillPackageError("SKILL_ENTRY_MISSING", "Skill 根目录缺少 SKILL.md。");
  }
  if (new Set(sorted.map((file) => file.path)).size !== sorted.length) {
    throw skillPackageError("SKILL_PACKAGE_INVALID", "Skill 包含重复路径。");
  }
  const unpackedBytes = sorted.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes < 1 || unpackedBytes > 32 * 1024 * 1024) {
    throw skillPackageError("SKILL_PACKAGE_SIZE_INVALID", "Skill 展开体积无效。");
  }
  const hash = createHash("sha256");
  hash.update("sunabot-skill-package-v1\0");
  for (const file of sorted) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.bytes), "ascii");
    hash.update("\0");
    hash.update(file.sha256, "ascii");
    hash.update("\0");
  }
  const digestSha256 = hash.digest("hex");
  const mcpDependencies = riskInput.mcpDependencies
    .map((dependency, index) => parseAgentSkillMcpDependency(dependency, `mcpDependencies[${index}]`))
    .sort((left, right) => compareBinaryText(left.id, right.id));
  if (new Set(mcpDependencies.map((dependency) => dependency.id)).size !== mcpDependencies.length) {
    throw skillPackageError("SKILL_OPENAI_METADATA_INVALID", "agents/openai.yaml 包含重复 MCP 依赖。");
  }
  const declaredFileAccess = declaredAccess(frontmatter.allowedTools);
  const riskEvidence: AgentSkillRiskEvidence = {
    reviewVersion: 1,
    reviewStatus: "unreviewed",
    reviewedDigestSha256: null,
    classification: riskInput.hasScripts ? "script-bearing" : "instruction-only",
    hasScripts: riskInput.hasScripts,
    hasExternalUrls: riskInput.hasExternalUrls,
    externalOrigins: [...riskInput.externalOrigins].sort(compareBinaryText),
    mcpDependencies,
    declaredFileAccess,
    allowImplicitInvocation: riskInput.allowImplicitInvocation
  };
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: { ...frontmatter.metadata },
    allowedTools: [...frontmatter.allowedTools],
    riskEvidence,
    digestSha256,
    fileCount: sorted.length,
    unpackedBytes,
    files: sorted
  };
}

export function skillRecordFromEvidence(
  evidence: SkillPackageEvidence,
  source: AgentSkillSource,
  installedAt: string,
  enabled = true
): AgentSkillRecord {
  return {
    id: evidence.name,
    name: evidence.name,
    description: evidence.description,
    license: evidence.license,
    compatibility: evidence.compatibility,
    metadata: { ...evidence.metadata },
    allowedTools: [...evidence.allowedTools],
    riskEvidence: evidence.riskEvidence,
    enabled,
    entry: "SKILL.md",
    digestSha256: evidence.digestSha256,
    fileCount: evidence.fileCount,
    unpackedBytes: evidence.unpackedBytes,
    installedAt,
    source,
    approval: {
      status: "unapproved",
      digestSha256: null,
      approvedAt: null
    }
  };
}

function normalizeFileEvidence(file: SkillPackageFileEvidence): SkillPackageFileEvidence {
  if (!file || typeof file.path !== "string" || !portableRelativePath(file.path)) {
    throw skillPackageError("SKILL_PACKAGE_PATH_INVALID", "Skill 文件路径无效。");
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 * 1024) {
    throw skillPackageError("SKILL_PACKAGE_SIZE_INVALID", "Skill 文件体积无效。");
  }
  if (!/^[a-f0-9]{64}$/u.test(file.sha256)) {
    throw skillPackageError("SKILL_PACKAGE_INVALID", "Skill 文件摘要无效。");
  }
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

function portableRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." &&
    !segment.endsWith(".") && !segment.endsWith(" ") && !/[:*?"<>|]/u.test(segment));
}

function parseAllowedTools(value: string) {
  let entries: string[];
  const trimmed = value.trim();
  if (!trimmed) throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 不能为空。");
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 无效。");
    entries = splitInlineList(trimmed.slice(1, -1));
  } else {
    entries = trimmed.split(/[\s,]+/u).filter(Boolean);
  }
  if (!entries.length || entries.length > 64 || new Set(entries).size !== entries.length ||
      entries.some((entry) => entry.length > 128 || !ALLOWED_TOOL_PATTERN.test(entry))) {
    throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 无效或超限。");
  }
  return entries.sort();
}

function splitInlineList(value: string) {
  if (!value.trim()) return [];
  const entries: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          quote = null;
        }
      } else if (quote === "\"" && character === "\\") {
        const escaped = value[index + 1];
        if (escaped !== "\"" && escaped !== "\\") {
          throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 引号无效。");
        }
        current += escaped;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      if (current.trim()) throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 引号无效。");
      quote = character;
    } else if (character === ",") {
      entries.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 引号无效。");
  entries.push(current.trim());
  if (entries.some((entry) => !entry)) throw skillPackageError("SKILL_ALLOWED_TOOLS_INVALID", "SKILL.md allowed-tools 无效。");
  return entries;
}

function declaredAccess(tools: string[]): AgentSkillDeclaredFileAccess[] {
  const access = new Set<AgentSkillDeclaredFileAccess>();
  for (const tool of tools) {
    const name = tool.split("(", 1)[0]!.toLowerCase();
    if (/(?:^|[_-])(?:read|grep|glob|search|find|list)(?:$|[_-])/u.test(name)) access.add("read");
    if (/(?:^|[_-])(?:write|edit|patch|create|delete|remove|move|copy)(?:$|[_-])/u.test(name)) access.add("write");
    if (/(?:^|[_-])(?:bash|shell|exec|terminal|command)(?:$|[_-])/u.test(name)) access.add("shell");
  }
  return (["read", "write", "shell"] as const).filter((value) => access.has(value));
}

function setOpenAiDependencyField(
  dependency: Record<string, string>,
  fields: Set<string>,
  key: string,
  raw: string
) {
  if (fields.has(key)) openAiMetadataInvalid();
  fields.add(key);
  dependency[key] = yamlScalar(raw, `dependencies.tools.${key}`);
}

function validateOpenAiInterfaceValue(key: string, value: string) {
  if (!value || value.length > (key === "default_prompt" ? 2_000 : 500)) openAiMetadataInvalid();
  if ((key === "icon_small" || key === "icon_large") && !portableRelativePath(value)) openAiMetadataInvalid();
  if (key === "brand_color" && !/^#[a-f0-9]{6}$/iu.test(value)) openAiMetadataInvalid();
}

function rejectUnsafeYamlSyntax(line: string, label: string) {
  if (line.includes("\t") || /(?:^|:\s+|-\s+)[ ]*(?:&|\*|!)[^\s]+/u.test(line) || /:\s*[|>]\s*(?:#.*)?$/u.test(line) ||
      /^\s*(?:---|\.\.\.)\s*$/u.test(line)) {
    throw skillPackageError(
      label === "agents/openai.yaml" ? "SKILL_OPENAI_METADATA_INVALID" : "SKILL_FRONTMATTER_INVALID",
      `${label} 包含不支持的 YAML 结构。`
    );
  }
}

function yamlScalar(raw: string, key: string, allowEmpty = false) {
  const value = raw.trim();
  if ((!value && !allowEmpty) || value === "|" || value === ">" || value.startsWith("&") ||
      value.startsWith("*") || value.startsWith("!") || value.startsWith("{") || value.startsWith("[")) {
    if (key === "allowed-tools" && value.startsWith("[")) return value;
    throw skillPackageError("SKILL_FRONTMATTER_INVALID", `${key} 必须使用单行文本。`);
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return safeScalar(parsed, key, allowEmpty);
    } catch { /* converted to the stable error below */ }
    throw skillPackageError("SKILL_FRONTMATTER_INVALID", `${key} 引号无效。`);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw skillPackageError("SKILL_FRONTMATTER_INVALID", `${key} 引号无效。`);
    }
    return safeScalar(value.slice(1, -1).replace(/''/gu, "'"), key, allowEmpty);
  }
  const withoutComment = /\s+#/u.test(value) ? value.replace(/\s+#.*$/u, "").trimEnd() : value;
  return safeScalar(withoutComment, key, allowEmpty);
}

function safeScalar(value: string, key: string, allowEmpty: boolean) {
  if ((!value && !allowEmpty) || value.includes("\0") ||
      /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw skillPackageError("SKILL_FRONTMATTER_INVALID", `${key} 包含无效字符。`);
  }
  return value;
}

function safeText(value: string | undefined, field: string, maxLength: number) {
  if (value == null || !value || value.length > maxLength || value.includes("\0") ||
      /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw skillPackageError(
      field === "description" ? "SKILL_DESCRIPTION_INVALID" : "SKILL_FRONTMATTER_INVALID",
      `SKILL.md ${field} 无效。`
    );
  }
  return value;
}

function optionalSafeText(value: string | undefined, field: string, maxLength: number) {
  return value == null ? null : safeText(value, field, maxLength);
}

function openAiMetadataInvalid(): never {
  throw skillPackageError("SKILL_OPENAI_METADATA_INVALID", "agents/openai.yaml 结构或字段无效。");
}

function skillPackageError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
