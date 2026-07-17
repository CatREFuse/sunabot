import { createHash } from "node:crypto";
import path from "node:path";
import {
  SKILL_REVIEW_MAX_SCRIPT_BYTES
} from "../../services/extensions/public.js";
import {
  assertSkillActivationResource,
  type SkillActivationResource
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";

export const SKILL_SCRIPT_BASH_INTERPRETER = "/bin/bash";
export const SKILL_SCRIPT_NODE_INTERPRETER = "/usr/bin/node";
export const SKILL_SCRIPT_MAX_ARGUMENTS = 64;
export const SKILL_SCRIPT_MAX_ARGUMENT_BYTES = 32 * 1024;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_AUDIT_ACCESSES = 64;
const MAX_AUDIT_VIOLATIONS = 32;
const MAX_AUDIT_TEXT = 1_000;
const FORBIDDEN_RUNTIME_TOKEN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])(?:bunx|corepack|npm|npx|pip|pip3|pnpm|uv|uvx|yarn)(?:$|[^A-Za-z0-9_])`,
  "iu"
);
const FORBIDDEN_NETWORK_TOKEN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])(?:curl|wget|fetch|https?|websocket|net|tls|ssh|scp|sftp|nc|ncat|socat)(?:$|[^A-Za-z0-9_])`,
  "iu"
);
const FORBIDDEN_HOST_TOKEN = /(?:docker\.sock|\/var\/run\/docker|\/run\/docker|\/proc\/(?:self|\d+|1)\/(?:environ|root)|process\.env|Deno\.env|Bun\.env)/iu;
const FORBIDDEN_SHELL_DYNAMIC = /(?:\beval\b|\bsource\b|(?:^|[;|&()\s])\.(?:[;|&()\s]|$)|\$\(|`|\$\{|\\\r?\n)/mu;
const FORBIDDEN_NODE_DYNAMIC = /(?:node:)?child_process|\b(?:exec|execFile|spawn|fork)Sync?\s*\(|\bimport\s*\(|\brequire\s*\(\s*[^"']|\beval\s*\(|\bFunction\s*\(|\bnew\s+Function\s*\(|(?:node:)?vm\b/iu;
const SHELL_MUTATING_COMMAND = /(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?(?:cp|install|mkdir|mv|rm|rmdir|sed|tee|touch|truncate)(?=$|[;&|()\s])/imu;
const NODE_WRITE_API = /\b(?:appendFile|appendFileSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|createWriteStream|link|linkSync|mkdir|mkdirSync|rename|renameSync|symlink|symlinkSync|truncate|truncateSync|utimes|utimesSync|write|writeFile|writeFileSync)\s*\(/iu;
const NODE_DELETE_API = /\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/iu;

export interface SkillScriptAuditInput {
  agentId: string;
  conversationId: string;
  skillId: string;
  expectedDigestSha256: string;
  resource: SkillActivationResource;
  args: readonly string[];
  bytes: Uint8Array;
}

export type SkillScriptMutationHint = "write" | "delete" | null;
export type SkillScriptAuditAccessKind = "read" | "write" | "delete";

export interface SkillScriptAuditAccess {
  path: string;
  access: SkillScriptAuditAccessKind;
}

export interface SkillScriptAuditDecision {
  interpreter: typeof SKILL_SCRIPT_BASH_INTERPRETER | typeof SKILL_SCRIPT_NODE_INTERPRETER;
  fingerprintSha256: string;
  scriptSha256: string;
  mutationHint: SkillScriptMutationHint;
}

export interface SkillScriptIndependentAuditInput extends SkillScriptAuditInput {
  source: string;
  interpreter: SkillScriptAuditDecision["interpreter"];
  scriptSha256: string;
  preflightFingerprintSha256: string;
  signal?: AbortSignal;
}

export interface SkillScriptIndependentAuditResult {
  decision: "allow" | "confirm" | "deny";
  risk: "low" | "medium" | "high";
  accesses: SkillScriptAuditAccess[];
  violations: string[];
  summary: string;
}

export interface SkillScriptExecutionAuditDecision {
  interpreter: SkillScriptAuditDecision["interpreter"];
  fingerprintSha256: string;
  preflightFingerprintSha256: string;
  scriptSha256: string;
  accesses: SkillScriptAuditAccess[];
}

export interface AgentSkillScriptAuditRunnerPort {
  audit(input: SkillScriptIndependentAuditInput): Promise<unknown>;
}

export function auditAgentSkillScript(input: SkillScriptAuditInput): SkillScriptAuditDecision {
  const resource = assertSkillActivationResource(input.resource);
  if (!SAFE_ID.test(input.agentId) || !input.conversationId || input.conversationId.length > 512 ||
      /[\u0000\r\n]/u.test(input.conversationId) || !SAFE_ID.test(input.skillId) ||
      !SHA256.test(input.expectedDigestSha256) || !resource.path.startsWith("scripts/") ||
      resource.bytes < 1 || resource.bytes > SKILL_REVIEW_MAX_SCRIPT_BYTES ||
      input.bytes.byteLength !== resource.bytes || !Array.isArray(input.args)) {
    denied("SKILL_SCRIPT_AUDIT_DENIED");
  }
  const scriptSha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (scriptSha256 !== resource.sha256) denied("SKILL_SCRIPT_AUDIT_DENIED");
  const extension = path.posix.extname(resource.path).toLowerCase();
  const interpreter = extension === ".sh"
    ? SKILL_SCRIPT_BASH_INTERPRETER
    : extension === ".js"
      ? SKILL_SCRIPT_NODE_INTERPRETER
      : denied("SKILL_SCRIPT_INTERPRETER_DENIED");
  validateArguments(input.args);
  const source = decodeSource(input.bytes);
  const deobfuscatedSource = source.replaceAll("\\", "").replaceAll("'", "").replaceAll('"', "");
  if (!source || source.includes("\0") || FORBIDDEN_RUNTIME_TOKEN.test(source) ||
      FORBIDDEN_RUNTIME_TOKEN.test(deobfuscatedSource) || FORBIDDEN_NETWORK_TOKEN.test(source) ||
      FORBIDDEN_NETWORK_TOKEN.test(deobfuscatedSource) || FORBIDDEN_HOST_TOKEN.test(source) ||
      (extension === ".sh" && FORBIDDEN_SHELL_DYNAMIC.test(source)) ||
      (extension === ".js" && FORBIDDEN_NODE_DYNAMIC.test(source)) ||
      permanentSkillScriptDenialReason(source, extension)) {
    denied("SKILL_SCRIPT_AUDIT_DENIED");
  }
  const mutationHint = deterministicMutationHint(source, extension);
  const fingerprintSha256 = createHash("sha256")
    .update("sunabot-skill-script-preflight-v2\0", "utf8")
    .update(canonicalJson({
      agentId: input.agentId,
      conversationId: input.conversationId,
      skillId: input.skillId,
      expectedDigestSha256: input.expectedDigestSha256,
      resource: {
        path: resource.path,
        bytes: resource.bytes,
        sha256: resource.sha256
      },
      args: [...input.args],
      interpreter,
      mutationHint
    }), "utf8")
    .digest("hex");
  return { interpreter, fingerprintSha256, scriptSha256, mutationHint };
}

export function buildSkillScriptIndependentAuditInput(
  input: SkillScriptAuditInput,
  preflight: SkillScriptAuditDecision,
  signal?: AbortSignal
): SkillScriptIndependentAuditInput {
  const verified = auditAgentSkillScript(input);
  if (verified.fingerprintSha256 !== preflight.fingerprintSha256 ||
      verified.scriptSha256 !== preflight.scriptSha256 ||
      verified.interpreter !== preflight.interpreter ||
      verified.mutationHint !== preflight.mutationHint) {
    denied("SKILL_SCRIPT_AUDIT_MISMATCH");
  }
  return {
    ...input,
    source: decodeSource(input.bytes),
    interpreter: verified.interpreter,
    scriptSha256: verified.scriptSha256,
    preflightFingerprintSha256: verified.fingerprintSha256,
    signal
  };
}

export function completeAgentSkillScriptAudit(
  input: SkillScriptIndependentAuditInput,
  rawResult: unknown
): SkillScriptExecutionAuditDecision {
  const preflight = auditAgentSkillScript(input);
  if (preflight.fingerprintSha256 !== input.preflightFingerprintSha256 ||
      preflight.scriptSha256 !== input.scriptSha256 || preflight.interpreter !== input.interpreter) {
    denied("SKILL_SCRIPT_AUDIT_MISMATCH");
  }
  const result = normalizeIndependentAuditResult(rawResult);
  if (result.decision === "deny" || result.risk !== "low" || result.violations.length > 0) {
    denied("SKILL_SCRIPT_AUDIT_DENIED");
  }
  const mutations = result.accesses.filter((access) => access.access !== "read");
  if (preflight.mutationHint && !mutations.some((access) => access.access === preflight.mutationHint)) {
    denied("SKILL_SCRIPT_AUDIT_INVALID");
  }
  if (result.decision === "confirm" || mutations.some((access) => !isTemporaryPath(access.path))) {
    denied("SKILL_SCRIPT_APPROVAL_REQUIRED");
  }
  const fingerprintSha256 = createHash("sha256")
    .update("sunabot-skill-script-independent-audit-v1\0", "utf8")
    .update(canonicalJson({
      agentId: input.agentId,
      conversationId: input.conversationId,
      skillId: input.skillId,
      expectedDigestSha256: input.expectedDigestSha256,
      resource: input.resource,
      args: [...input.args],
      interpreter: input.interpreter,
      scriptSha256: input.scriptSha256,
      preflightFingerprintSha256: input.preflightFingerprintSha256,
      result
    }), "utf8")
    .digest("hex");
  return {
    interpreter: input.interpreter,
    fingerprintSha256,
    preflightFingerprintSha256: input.preflightFingerprintSha256,
    scriptSha256: input.scriptSha256,
    accesses: result.accesses
  };
}

function normalizeIndependentAuditResult(value: unknown): SkillScriptIndependentAuditResult {
  if (!isRecord(value) || !hasExactKeys(value, ["accesses", "decision", "risk", "summary", "violations"]) ||
      !isDecision(value.decision) || !isRisk(value.risk) || !Array.isArray(value.accesses) ||
      value.accesses.length > MAX_AUDIT_ACCESSES || !Array.isArray(value.violations) ||
      value.violations.length > MAX_AUDIT_VIOLATIONS || typeof value.summary !== "string" ||
      !value.summary.trim() || Buffer.byteLength(value.summary, "utf8") > MAX_AUDIT_TEXT) {
    denied("SKILL_SCRIPT_AUDIT_INVALID");
  }
  const accesses = value.accesses.map((entry) => normalizeAuditAccess(entry));
  const unique = new Set(accesses.map((entry) => `${entry.access}\0${entry.path}`));
  if (unique.size !== accesses.length) denied("SKILL_SCRIPT_AUDIT_INVALID");
  const violations = value.violations.map((violation) => {
    if (typeof violation !== "string" || !violation.trim() || Buffer.byteLength(violation, "utf8") > 500) {
      denied("SKILL_SCRIPT_AUDIT_INVALID");
    }
    return violation.trim();
  });
  return {
    decision: value.decision,
    risk: value.risk,
    accesses,
    violations,
    summary: value.summary.trim()
  };
}

function normalizeAuditAccess(value: unknown): SkillScriptAuditAccess {
  if (!isRecord(value) || !hasExactKeys(value, ["access", "path"]) ||
      !isAccess(value.access) || typeof value.path !== "string" ||
      value.path.length > 1_024 || value.path.includes("\0") || !path.posix.isAbsolute(value.path) ||
      value.path.split("/").includes("..")) {
    denied("SKILL_SCRIPT_AUDIT_INVALID");
  }
  const normalized = path.posix.normalize(value.path);
  if (!isVirtualRuntimePath(normalized) ||
      ((normalized === "/skills" || normalized.startsWith("/skills/")) && value.access !== "read")) {
    denied("SKILL_SCRIPT_AUDIT_INVALID");
  }
  return { path: normalized, access: value.access };
}

function permanentSkillScriptDenialReason(source: string, extension: string) {
  const canonical = canonicalSafetySource(source);
  if (extension === ".sh") {
    if (hasStartedSelfRecursiveFunction(canonical) || hasVariableWrappedDestructiveCommand(canonical) ||
        dangerousRecursiveRemoval(canonical) || dangerousFindDelete(canonical) ||
        encodedExecution(source)) return true;
  }
  if (extension === ".js") {
    const compact = canonical.replace(/[\s+]/gu, "");
    if (encodedNodeExecution(source) ||
        /(?:\.|\[)(?:rm|rmSync|rmdir|rmdirSync)\]?\([^)]*[,{][^)]*recursive:true/iu.test(compact) ||
        /(?:\.|\[)(?:rm|rmSync|rmdir|rmdirSync)\]?\([^)]*(?:\/workbench|process\.cwd\(\)|^\/|\.\.)/iu.test(compact)) {
      return true;
    }
  }
  return false;
}

function deterministicMutationHint(source: string, extension: string): SkillScriptMutationHint {
  const canonical = canonicalSafetySource(source);
  if (extension === ".sh") {
    if (/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?(?:rm|rmdir)(?=$|[;&|()\s])/imu.test(canonical) ||
        dangerousFindDelete(canonical)) return "delete";
    if (SHELL_MUTATING_COMMAND.test(canonical) || /(^|[^<])>{1,2}(?![>&])/mu.test(canonical)) return "write";
  } else {
    const compact = canonical.replace(/[\s+'"\[\]]/gu, "");
    if (NODE_DELETE_API.test(source) || /\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\(/iu.test(compact)) {
      return "delete";
    }
    if (NODE_WRITE_API.test(source)) return "write";
  }
  return null;
}

function dangerousRecursiveRemoval(command: string) {
  if (/\bxargs\b[^\n]*\brm\b[^\n]*(?:--recursive|-[A-Za-z]*[rR][A-Za-z]*)/iu.test(command)) return true;
  for (const match of command.matchAll(/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?rm\s+([^;&|\n]*)/giu)) {
    const tokens = safetyWords(match[1] ?? "");
    const recursive = tokens.some((token) => /^-[^-]*[rR]/u.test(token) || token === "--recursive");
    if (!recursive) continue;
    const targets = tokens.filter((token) => token !== "--" && !token.startsWith("-"));
    if (!targets.length || targets.some(isDangerousRemovalTarget)) return true;
  }
  return false;
}

function dangerousFindDelete(command: string) {
  for (const match of command.matchAll(/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?find\s+([^;&|\n]*)/giu)) {
    const tokens = safetyWords(match[1] ?? "");
    const deleteIndex = tokens.indexOf("-delete");
    if (deleteIndex < 0) continue;
    const roots = tokens.slice(0, deleteIndex).filter((token) => token && !token.startsWith("-"));
    if (!roots.length || roots.some(isDangerousRemovalTarget)) return true;
  }
  return false;
}

function isDangerousRemovalTarget(target: string) {
  const normalized = path.posix.normalize(target.replace(/\/+$/u, "") || "/");
  return normalized === "/" || normalized === "." || normalized === ".." || normalized === "/workbench" ||
    normalized.startsWith("/workbench/") && /[*?\[]/u.test(target) ||
    /[*?\[]/u.test(target) || /\$\(|`|\$\{|\$[A-Za-z_]/u.test(target);
}

function hasVariableWrappedDestructiveCommand(command: string) {
  for (const match of command.matchAll(
    /(?:^|[;&|()\s])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\/[^\s;&|()]+\/)?(?:rm|find)(?=$|[;&|()\s])/giu
  )) {
    const name = match[1] ?? "";
    const remainder = command.slice((match.index ?? 0) + match[0].length);
    if (new RegExp(`(?:^|[;&|()\\s])\\$(?:\\{${escapeRegExp(name)}\\}|${escapeRegExp(name)})(?=$|[;&|()\\s])`, "u")
      .test(remainder)) return true;
  }
  return false;
}

function hasStartedSelfRecursiveFunction(command: string) {
  for (const match of command.matchAll(
    /(?:^|[;&|()\s])([:A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{([\s\S]*?)\}\s*;?\s*\1(?=$|[;&|()\s])/gu
  )) {
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    if (new RegExp(`(?:^|[;&|()\\s])${escapeRegExp(name)}(?=$|[;&|()\\s])`, "u").test(body)) return true;
  }
  return false;
}

function encodedExecution(source: string) {
  return /(?:base64\s+(?:-[A-Za-z]*d[A-Za-z]*|--decode)|xxd\s+-r|openssl\s+enc[^\n]*\s-d)[\s\S]{0,512}(?:\|\s*(?:ba)?sh\b|\|\s*node\b|\beval\b)/iu.test(source) ||
    /(?:\\x[0-9a-f]{2}|\\u[0-9a-f]{4})/iu.test(source);
}

function encodedNodeExecution(source: string) {
  return /Buffer\.from\s*\([^)]*,\s*["'](?:base64|hex)["']/iu.test(source) ||
    /(?:\\x[0-9a-f]{2}|\\u[0-9a-f]{4})/iu.test(source) ||
    /\[[^\]]*["'][^"']+["']\s*\+\s*["'][^"']+["'][^\]]*\]\s*\(/u.test(source);
}

function canonicalSafetySource(source: string) {
  return source.replace(/\\([\s\S])/gu, "$1").replace(/["']/gu, "");
}

function validateArguments(args: readonly string[]) {
  if (args.length > SKILL_SCRIPT_MAX_ARGUMENTS) denied("SKILL_SCRIPT_ARGUMENTS_INVALID");
  let bytes = 0;
  for (const value of args) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
        FORBIDDEN_RUNTIME_TOKEN.test(value) || FORBIDDEN_NETWORK_TOKEN.test(value) ||
        FORBIDDEN_HOST_TOKEN.test(value)) {
      denied("SKILL_SCRIPT_ARGUMENTS_INVALID");
    }
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > SKILL_SCRIPT_MAX_ARGUMENT_BYTES || Buffer.byteLength(value, "utf8") > 4_096) {
      denied("SKILL_SCRIPT_ARGUMENTS_INVALID");
    }
  }
}

function decodeSource(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    denied("SKILL_SCRIPT_AUDIT_DENIED");
  }
}

function isVirtualRuntimePath(value: string) {
  return value === "/workbench" || value.startsWith("/workbench/") ||
    value === "/tmp" || value.startsWith("/tmp/") ||
    value === "/skills" || value.startsWith("/skills/");
}

function isTemporaryPath(value: string) {
  return value === "/tmp" || value.startsWith("/tmp/");
}

function safetyWords(value: string) {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDecision(value: unknown): value is SkillScriptIndependentAuditResult["decision"] {
  return value === "allow" || value === "confirm" || value === "deny";
}

function isRisk(value: unknown): value is SkillScriptIndependentAuditResult["risk"] {
  return value === "low" || value === "medium" || value === "high";
}

function isAccess(value: unknown): value is SkillScriptAuditAccessKind {
  return value === "read" || value === "write" || value === "delete";
}

function denied(code: string): never {
  const error = new Error(code);
  error.name = "SkillScriptError";
  throw error;
}
