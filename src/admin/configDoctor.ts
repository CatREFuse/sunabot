import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import {
  defaultConfig,
  getConfigPath,
  getDefaultProvider,
  normalizeConfigDocument
} from "../config.js";
import type { AppConfig, ProviderConfig } from "../types.js";
import type { ConfigService } from "./configService.js";
import { validateCompleteConfig } from "./configService.js";
import { AdminApiError, conflict } from "./errors.js";
import {
  applyConfigDoctorOperations,
  diffConfigDocuments,
  isAiRepairablePath,
  operationRisk,
  parseAiOperations,
  type ConfigDoctorPatchOperation
} from "./configDoctorPatch.js";
import {
  buildConfigDoctorModelRequest,
  publicConfigDoctorProviderInfo,
  type ConfigDoctorProviderInfo
} from "./configDoctorModel.js";
import { ConfigDoctorFileError, readConfigFileNoFollow } from "./configDoctorFile.js";

const PROPOSAL_TTL_MS = 10 * 60_000;
const AI_COOLDOWN_MS = 10_000;
const MAX_AI_RESPONSE_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURE_TOKENS = 4_096;
export interface ConfigDoctorIssue {
  id: string;
  path: string;
  message: string;
  severity: "warning" | "error";
  repairable: boolean;
  source: "rules" | "syntax" | "ai";
}

export interface ConfigDoctorChange {
  path: string;
  action: "add" | "replace" | "remove";
  summary: string;
  risk: "low" | "medium";
}

export type { ConfigDoctorProviderInfo } from "./configDoctorModel.js";
export interface ConfigDoctorProposal {
  id: string;
  sourceRevision: string;
  expiresAt: string;
  risk: "low" | "medium";
  source: "rules" | "ai";
  changes: ConfigDoctorChange[];
}

export interface ConfigDoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevision: string;
  status: "healthy" | "repairable" | "manual";
  issues: ConfigDoctorIssue[];
  proposal?: ConfigDoctorProposal;
  ai: {
    available: boolean;
    provider?: ConfigDoctorProviderInfo;
    summary?: string;
  };
}

export interface ConfigDoctorModelRequest {
  provider: ProviderConfig;
  request: RenderedPromptRequest;
  signal: AbortSignal;
}

export type ConfigDoctorModelRunner = (input: ConfigDoctorModelRequest) => Promise<string>;

interface ConfigDoctorOptions {
  configPath?: string;
  configService: Pick<ConfigService, "applyDoctorCandidate">;
  getActiveConfig: () => AppConfig;
  runModel?: ConfigDoctorModelRunner;
  isModelAvailable?: (provider: ProviderConfig) => boolean;
  now?: () => number;
}

interface ParsedSource {
  raw: Buffer;
  revision: string;
  document?: Record<string, unknown>;
  syntaxChanges: ConfigDoctorChange[];
  syntaxIssues: ConfigDoctorIssue[];
  fatalIssue?: ConfigDoctorIssue;
}

interface StoredProposal {
  id: string;
  sourceRevision: string;
  expiresAt: number;
  source: "rules" | "ai";
  operations: ConfigDoctorPatchOperation[];
  provider?: ConfigDoctorProviderInfo;
  changes: ConfigDoctorChange[];
}

export class ConfigDoctorService {
  private readonly configPath: string;
  private readonly now: () => number;
  private readonly proposals = new Map<string, StoredProposal>();
  private lastAiAt?: number;

  constructor(private readonly options: ConfigDoctorOptions) {
    this.configPath = options.configPath ?? getConfigPath();
    this.now = options.now ?? Date.now;
  }

  async scan(): Promise<ConfigDoctorReport> {
    const source = await this.readSource();
    return this.reportForSource(source, "rules");
  }

  async propose(sourceRevision: string): Promise<ConfigDoctorReport> {
    if (typeof sourceRevision !== "string" || !sourceRevision) {
      throw new AdminApiError(400, "CONFIG_DOCTOR_REQUEST_INVALID", "缺少配置版本，请重新检查。");
    }
    const source = await this.readSource();
    if (source.revision !== sourceRevision) {
      conflict("CONFIG_REVISION_CONFLICT", "配置已变化，请重新检查。", source.revision);
    }
    if (!source.document || source.fatalIssue) {
      throw new AdminApiError(409, "CONFIG_DOCTOR_MANUAL_REQUIRED", "当前配置需要手动处理，无法发送智能诊断。");
    }
    const provider = getDefaultProvider(this.options.getActiveConfig());
    if (!provider?.enabled || !this.options.runModel || !this.isModelAvailable(provider)) {
      throw new AdminApiError(422, "CONFIG_DOCTOR_AI_UNAVAILABLE", "当前没有可用的智能诊断模型。");
    }
    const now = this.now();
    if (this.lastAiAt != null && now - this.lastAiAt < AI_COOLDOWN_MS) {
      const retryAfter = Math.ceil((AI_COOLDOWN_MS - (now - this.lastAiAt)) / 1_000);
      throw new AdminApiError(429, "CONFIG_DOCTOR_AI_RATE_LIMITED", `请在 ${retryAfter} 秒后再次诊断。`);
    }
    this.lastAiAt = now;

    const base = this.analyzeDocument(source);
    const aiIssues = base.issues.filter((issue) => !issue.repairable && isAiRepairablePath(issue.path));
    const aiAllowedPaths = new Set(aiIssues.map((issue) => issue.path));
    const request = buildConfigDoctorModelRequest(source.document, aiIssues);
    let responseText: string;
    try {
      responseText = await this.options.runModel({
        provider,
        request,
        signal: AbortSignal.timeout(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS)
      });
    } catch (error) {
      throw new AdminApiError(
        422,
        "CONFIG_DOCTOR_AI_FAILED",
        error instanceof Error ? error.message : "智能诊断失败。"
      );
    }
    if (Buffer.byteLength(responseText, "utf8") > MAX_AI_RESPONSE_BYTES) {
      throw new AdminApiError(422, "CONFIG_DOCTOR_AI_OUTPUT_INVALID", "智能诊断响应过大。");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new AdminApiError(422, "CONFIG_DOCTOR_AI_OUTPUT_INVALID", "智能诊断没有返回合法 JSON。");
    }
    const modelOperations = parseAiOperations(parsed, aiAllowedPaths);
    const aiOperations = withDerivedMirrorOperations(source.document, modelOperations);
    const existingPaths = new Set(base.ruleOperations.map((operation) => operation.path));
    const combined = [
      ...base.ruleOperations,
      ...aiOperations.filter((operation) => !existingPaths.has(operation.path))
    ];
    const candidate = applyConfigDoctorOperations(source.document, combined) as AppConfig;
    try {
      validateCompleteConfig(candidate);
    } catch {
      throw new AdminApiError(409, "CONFIG_DOCTOR_MANUAL_REQUIRED", "智能建议无法形成完整的有效配置，请手动处理剩余问题。");
    }

    const aiChanges = aiOperations
      .filter((operation) => !existingPaths.has(operation.path))
      .map((operation) => changeForOperation(operation));
    const repairedAiPaths = new Set(aiChanges.map((change) => change.path));
    const remainingBaseIssues = base.issues.filter((issue) => issue.repairable || !repairedAiPaths.has(issue.path));
    const hasManualIssues = remainingBaseIssues.some((issue) => !issue.repairable);
    const changes = [...source.syntaxChanges, ...base.ruleChanges, ...aiChanges];
    const providerInfo = publicConfigDoctorProviderInfo(provider);
    const proposal = !hasManualIssues && changes.length
      ? this.storeProposal(source, "ai", combined, providerInfo, changes)
      : undefined;
    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      sourceRevision: source.revision,
      status: hasManualIssues ? "manual" : proposal ? "repairable" : "healthy",
      issues: [
        ...remainingBaseIssues,
        ...aiChanges.map((change, index) => ({
          id: `CONFIG_AI_SUGGESTION_${index + 1}`,
          path: change.path,
          message: change.summary,
          severity: "warning" as const,
          repairable: true,
          source: "ai" as const
        }))
      ],
      ...(proposal ? { proposal } : {}),
      ai: {
        available: true,
        provider: providerInfo,
        summary: typeof (parsed as { summary?: unknown }).summary === "string"
          ? String((parsed as { summary: string }).summary).slice(0, 500)
          : undefined
      }
    };
  }

  async apply(input: { proposalId: string; sourceRevision: string }) {
    if (!input || typeof input.proposalId !== "string" || typeof input.sourceRevision !== "string") {
      throw new AdminApiError(400, "CONFIG_DOCTOR_REQUEST_INVALID", "修复请求无效。");
    }
    this.pruneProposals();
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.expiresAt <= this.now()) {
      throw new AdminApiError(409, "CONFIG_DOCTOR_PROPOSAL_EXPIRED", "修复方案已过期，请重新检查。");
    }
    if (proposal.sourceRevision !== input.sourceRevision) {
      conflict("CONFIG_REVISION_CONFLICT", "修复方案与配置版本不匹配，请重新检查。", proposal.sourceRevision);
    }
    const source = await this.readSource();
    if (source.revision !== proposal.sourceRevision) {
      conflict("CONFIG_REVISION_CONFLICT", "配置已变化，请重新检查。", source.revision);
    }
    if (!source.document || source.fatalIssue) {
      throw new AdminApiError(409, "CONFIG_DOCTOR_MANUAL_REQUIRED", "当前配置需要手动处理，无法应用修复。");
    }
    const candidate = applyConfigDoctorOperations(source.document, proposal.operations) as AppConfig;
    validateCompleteConfig(candidate);
    const activeConfig = this.options.getActiveConfig();
    const runtimeOperations = proposal.operations
      .filter((operation) => operation.op !== "remove" || documentHasPointer(activeConfig, operation.path))
      .map((operation) => operation.op === "remove" ? operation : { ...operation, op: "add" as const });
    const runtimeCandidate = normalizeConfigDocument(applyConfigDoctorOperations(activeConfig, runtimeOperations));
    validateCompleteConfig(runtimeCandidate);
    const result = await this.options.configService.applyDoctorCandidate({
      expectedFileRevision: source.revision,
      candidate,
      runtimeCandidate,
      source: proposal.source,
      provider: proposal.provider,
      changes: proposal.changes.map((change) => ({
        path: change.path,
        action: change.action,
        risk: change.risk
      }))
    });
    this.proposals.delete(proposal.id);
    return result;
  }

  private async readSource(): Promise<ParsedSource> {
    let raw: Buffer;
    try {
      raw = await readConfigFileNoFollow(this.configPath);
    } catch (error) {
      if (error instanceof ConfigDoctorFileError) {
        const empty = Buffer.alloc(0);
        const issue = error.kind === "missing"
          ? fatalIssue("CONFIG_FILE_MISSING", "系统配置文件不存在。")
          : error.kind === "too-large"
            ? fatalIssue("CONFIG_FILE_TOO_LARGE", "系统配置文件过大。")
            : error.kind === "changed"
              ? fatalIssue("CONFIG_FILE_CHANGED", "检查期间系统配置发生变化，请重新检查。")
              : fatalIssue("CONFIG_PATH_UNSAFE", "系统配置文件路径不安全。");
        return {
          raw: empty,
          revision: fileRevision(empty),
          syntaxChanges: [],
          syntaxIssues: [],
          fatalIssue: issue
        };
      }
      throw error;
    }
    const revision = fileRevision(raw);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return {
        raw,
        revision,
        syntaxChanges: [],
        syntaxIssues: [],
        fatalIssue: fatalIssue("CONFIG_ENCODING_INVALID", "系统配置不是有效的 UTF-8 文本。")
      };
    }
    if (text.includes("\0")) {
      return {
        raw,
        revision,
        syntaxChanges: [],
        syntaxIssues: [],
        fatalIssue: fatalIssue("CONFIG_NUL_INVALID", "系统配置包含无效字符。")
      };
    }
    const syntaxChanges: ConfigDoctorChange[] = [];
    const syntaxIssues: ConfigDoctorIssue[] = [];
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
      syntaxChanges.push({ path: "/", action: "replace", summary: "移除 UTF-8 BOM", risk: "low" });
      syntaxIssues.push(repairableIssue("CONFIG_BOM", "/", "检测到 UTF-8 BOM。", "syntax"));
    }
    const trailing = removeTrailingCommas(text);
    text = trailing.text;
    if (trailing.count) {
      syntaxChanges.push({ path: "/", action: "replace", summary: "清理 JSON 末尾逗号", risk: "medium" });
      syntaxIssues.push(repairableIssue("CONFIG_TRAILING_COMMA", "/", "检测到 JSON 末尾逗号。", "syntax"));
    }
    const structureLimit = jsonStructureLimit(text);
    if (structureLimit) {
      return {
        raw,
        revision,
        syntaxChanges,
        syntaxIssues,
        fatalIssue: structureLimit === "depth"
          ? fatalIssue("CONFIG_STRUCTURE_TOO_DEEP", "系统配置嵌套层级过深。")
          : fatalIssue("CONFIG_STRUCTURE_TOO_COMPLEX", "系统配置结构过于复杂。")
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        raw,
        revision,
        syntaxChanges,
        syntaxIssues,
        fatalIssue: fatalIssue("CONFIG_JSON_INVALID", "系统配置不是合法 JSON。")
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        raw,
        revision,
        syntaxChanges,
        syntaxIssues,
        fatalIssue: fatalIssue("CONFIG_ROOT_INVALID", "系统配置必须是 JSON 对象。")
      };
    }
    const duplicate = findDuplicateJsonKey(text);
    if (duplicate) {
      return {
        raw,
        revision,
        syntaxChanges,
        syntaxIssues,
        fatalIssue: fatalIssue("CONFIG_DUPLICATE_KEY", `系统配置包含重复字段：${duplicate}。`, duplicate)
      };
    }
    return {
      raw,
      revision,
      document: parsed as Record<string, unknown>,
      syntaxChanges,
      syntaxIssues
    };
  }

  private reportForSource(source: ParsedSource, proposalSource: "rules" | "ai"): ConfigDoctorReport {
    const provider = getDefaultProvider(this.options.getActiveConfig());
    const providerInfo = provider ? publicConfigDoctorProviderInfo(provider) : undefined;
    if (!source.document || source.fatalIssue) {
      return {
        schemaVersion: 1,
        generatedAt: new Date(this.now()).toISOString(),
        sourceRevision: source.revision,
        status: "manual",
        issues: [...source.syntaxIssues, ...(source.fatalIssue ? [source.fatalIssue] : [])],
        ai: { available: false, ...(providerInfo ? { provider: providerInfo } : {}) }
      };
    }
    const analysis = this.analyzeDocument(source);
    let proposal: ConfigDoctorProposal | undefined;
    const hasManualIssues = analysis.issues.some((issue) => !issue.repairable);
    if (analysis.candidateValid && !hasManualIssues && (analysis.ruleChanges.length || source.syntaxChanges.length)) {
      proposal = this.storeProposal(
        source,
        proposalSource,
        analysis.ruleOperations,
        proposalSource === "ai" ? providerInfo : undefined,
        [...source.syntaxChanges, ...analysis.ruleChanges]
      );
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date(this.now()).toISOString(),
      sourceRevision: source.revision,
      status: hasManualIssues ? "manual" : proposal ? "repairable" : "healthy",
      issues: [...source.syntaxIssues, ...analysis.issues],
      ...(proposal ? { proposal } : {}),
      ai: {
        available: Boolean(provider?.enabled && this.options.runModel && this.isModelAvailable(provider)),
        ...(providerInfo ? { provider: providerInfo } : {})
      }
    };
  }

  private analyzeDocument(source: ParsedSource) {
    const document = source.document!;
    let normalized: AppConfig;
    try {
      normalized = normalizeConfigDocument(document, { applyRuntimeOverrides: false });
    } catch (error) {
      return {
        ruleOperations: [] as ConfigDoctorPatchOperation[],
        ruleChanges: [] as ConfigDoctorChange[],
        candidateValid: false,
        issues: [fatalIssue(
          (error as { code?: string }).code ?? "CONFIG_STRUCTURE_INVALID",
          error instanceof Error ? error.message : "系统配置结构无效。"
        )]
      };
    }
    const repaired = repairNormalizedConfig(normalized, document);
    const ruleOperations = diffConfigDocuments(document, repaired.candidate);
    const ruleChanges = ruleOperations.map((operation) => changeForOperation(operation));
    const issues: ConfigDoctorIssue[] = [
      ...ruleChanges.map((change, index) => ({
        id: `CONFIG_RULE_REPAIR_${index + 1}`,
        path: change.path,
        message: change.summary,
        severity: "warning" as const,
        repairable: true,
        source: "rules" as const
      })),
      ...repaired.issues
    ];
    const candidate = applyConfigDoctorOperations(document, ruleOperations) as AppConfig;
    let candidateValid = repaired.issues.length === 0;
    if (candidateValid) {
      try {
        validateCompleteConfig(candidate);
      } catch (error) {
        candidateValid = false;
        issues.push(validationIssue(error));
      }
    }
    return { ruleOperations, ruleChanges, candidateValid, issues };
  }

  private storeProposal(
    source: ParsedSource,
    proposalSource: "rules" | "ai",
    operations: ConfigDoctorPatchOperation[],
    provider: ConfigDoctorProviderInfo | undefined,
    changes: ConfigDoctorChange[]
  ): ConfigDoctorProposal {
    this.pruneProposals();
    while (this.proposals.size >= 64) {
      const oldest = this.proposals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.proposals.delete(oldest);
    }
    const now = this.now();
    const stored: StoredProposal = {
      id: crypto.randomUUID(),
      sourceRevision: source.revision,
      expiresAt: now + PROPOSAL_TTL_MS,
      source: proposalSource,
      operations: structuredClone(operations),
      ...(provider ? { provider } : {}),
      changes: structuredClone(changes)
    };
    this.proposals.set(stored.id, stored);
    return publicProposal(stored);
  }

  private pruneProposals() {
    const now = this.now();
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id);
    }
  }

  private isModelAvailable(provider: ProviderConfig) {
    return this.options.isModelAvailable?.(provider) ?? true;
  }
}

function withDerivedMirrorOperations(
  document: Record<string, unknown>,
  operations: readonly ConfigDoctorPatchOperation[]
) {
  const expanded: ConfigDoctorPatchOperation[] = [];
  const onebot = document.onebot && typeof document.onebot === "object" && !Array.isArray(document.onebot)
    ? document.onebot as Record<string, unknown>
    : undefined;
  for (const operation of operations) {
    expanded.push(operation);
    if (operation.path !== "/bot/quoteGroupReplies") continue;
    expanded.push({
      op: onebot && Object.hasOwn(onebot, "quoteGroupReplies") ? "replace" : "add",
      path: "/onebot/quoteGroupReplies",
      value: structuredClone(operation.value)
    });
  }
  return expanded;
}

function repairNormalizedConfig(candidate: AppConfig, source: Record<string, unknown>) {
  const working = structuredClone(candidate);
  const defaults = defaultConfig();
  const issues: ConfigDoctorIssue[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 128; attempt += 1) {
    try {
      validateCompleteConfig(working);
      return { candidate: working, issues };
    } catch (error) {
      const field = error instanceof AdminApiError ? error.field : undefined;
      const path = configFieldToPointer(field);
      if (!path || seen.has(path) || !replaceInvalidValue(
        working as unknown as Record<string, unknown>,
        defaults,
        source,
        path
      )) {
        issues.push(validationIssue(error, path));
        return { candidate: working, issues };
      }
      if (path === "/bot/quoteGroupReplies") {
        working.onebot.quoteGroupReplies = working.bot.quoteGroupReplies;
      }
      seen.add(path);
    }
  }
  issues.push({
    id: "CONFIG_REPAIR_LIMIT_EXCEEDED",
    path: "/",
    message: "系统配置包含过多连续无效字段。",
    severity: "error",
    repairable: false,
    source: "rules"
  });
  return { candidate: working, issues };
}

function validationIssue(error: unknown, path?: string): ConfigDoctorIssue {
  return {
    id: error instanceof AdminApiError ? error.code : "CONFIG_STRUCTURE_INVALID",
    path: path ?? configFieldToPointer(error instanceof AdminApiError ? error.field : undefined) ?? "/",
    message: error instanceof Error ? error.message : "系统配置结构无效。",
    severity: "error",
    repairable: false,
    source: "rules"
  };
}

function replaceInvalidValue(
  target: Record<string, unknown>,
  defaults: AppConfig,
  source: Record<string, unknown>,
  pointer: string
) {
  const defaultValue = valueAtPointer(defaults, pointer);
  if (!defaultValue.exists) return false;
  const sourceValue = valueAtPointer(source, pointer);
  const value = sourceValue.exists && typeof defaultValue.value === "boolean"
    ? false
    : defaultValue.value;
  return replaceAtPointer(target, pointer, value);
}

function valueAtPointer(document: unknown, pointer: string): { exists: boolean; value?: unknown } {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return { exists: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function replaceAtPointer(target: Record<string, unknown>, pointer: string, value: unknown) {
  const segments = pointerSegments(pointer);
  let parent: unknown = target;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, segment)) return false;
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (!parent || typeof parent !== "object") return false;
  (parent as Record<string, unknown>)[segments.at(-1)!] = structuredClone(value);
  return true;
}

function pointerSegments(pointer: string) {
  if (!pointer.startsWith("/") || pointer === "/") return [];
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function documentHasPointer(document: unknown, pointer: string) {
  const segments = pointerSegments(pointer);
  if (!segments.length) return false;
  let current = document;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

function publicProposal(proposal: StoredProposal): ConfigDoctorProposal {
  return {
    id: proposal.id,
    sourceRevision: proposal.sourceRevision,
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    risk: proposal.changes.some((change) => change.risk === "medium") ? "medium" : "low",
    source: proposal.source,
    changes: structuredClone(proposal.changes)
  };
}

function changeForOperation(operation: ConfigDoctorPatchOperation): ConfigDoctorChange {
  const action = operation.op;
  const value = action === "remove" ? "" : `，设置为 ${displayChangeValue(operation.value)}`;
  const summary = action === "add"
    ? `补齐字段 ${operation.path}${value}`
    : action === "remove"
      ? `移除退役字段 ${operation.path}`
      : `修正字段 ${operation.path}${value}`;
  return { path: operation.path, action, summary, risk: operationRisk(operation) };
}

function displayChangeValue(value: unknown) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  return "有效默认值";
}

function repairableIssue(
  id: string,
  path: string,
  message: string,
  source: "rules" | "syntax" | "ai"
): ConfigDoctorIssue {
  return { id, path, message, severity: "warning", repairable: true, source };
}

function fatalIssue(id: string, message: string, path = "/"): ConfigDoctorIssue {
  return { id, path, message, severity: "error", repairable: false, source: "syntax" };
}

function fileRevision(content: Uint8Array) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function configFieldToPointer(field: string | undefined) {
  if (!field) return undefined;
  const segments = field.split(".").filter(Boolean);
  if (["tone", "memory", "orchestrator", "tools", "bash"].includes(segments[0] ?? "")) {
    segments.unshift("bot");
  }
  return `/${segments.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function removeTrailingCommas(text: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        count += 1;
        continue;
      }
    }
    output += character;
  }
  return { text: output, count };
}

function jsonStructureLimit(text: string): "depth" | "complex" | undefined {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      tokens += 1;
      if (depth > MAX_JSON_DEPTH) return "depth";
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    } else if (character === ":" || character === ",") {
      tokens += 1;
    }
    if (tokens > MAX_JSON_STRUCTURE_TOKENS) return "complex";
  }
  return undefined;
}

function findDuplicateJsonKey(text: string) {
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const parseString = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index++]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') break;
    }
    return JSON.parse(text.slice(start, index)) as string;
  };
  const parseValue = (pointer: string): string | undefined => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") return parseObject(pointer);
    if (character === "[") {
      index += 1;
      skipWhitespace();
      let item = 0;
      while (text[index] !== "]") {
        const duplicate = parseValue(`${pointer}/${item}`);
        if (duplicate) return duplicate;
        skipWhitespace();
        if (text[index] === ",") { index += 1; skipWhitespace(); }
        item += 1;
      }
      index += 1;
      return undefined;
    }
    if (character === '"') { parseString(); return undefined; }
    while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
    return undefined;
  };
  const parseObject = (pointer: string): string | undefined => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    while (text[index] !== "}") {
      const key = parseString();
      const keyPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (keys.has(key)) return keyPointer;
      keys.add(key);
      skipWhitespace();
      index += 1;
      const duplicate = parseValue(keyPointer);
      if (duplicate) return duplicate;
      skipWhitespace();
      if (text[index] === ",") { index += 1; skipWhitespace(); }
    }
    index += 1;
    return undefined;
  };
  skipWhitespace();
  return parseValue("");
}
