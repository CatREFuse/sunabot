import { createHash } from "node:crypto";
import type {
  AgentSkillRiskEvidence,
  AgentSkillFileManifestEntry
} from "../../packages/contracts/extensions/agentExtensions.js";

export const SKILL_REVIEW_MAX_SCRIPT_BYTES = 256 * 1024;
export const SKILL_REVIEW_MAX_TOTAL_SCRIPT_BYTES = 1024 * 1024;
export const SKILL_REVIEW_MAX_TEXT_BYTES = 512 * 1024;
export const SKILL_REVIEW_MAX_TOTAL_TEXT_BYTES = 2 * 1024 * 1024;

export interface SkillReviewScriptEvidence extends AgentSkillFileManifestEntry {
  content: Buffer;
}

export interface SkillReviewTextEvidence extends AgentSkillFileManifestEntry {
  content: Buffer;
  kind: "instructions" | "reference" | "config" | "script" | "text";
}

export interface SkillReviewPreparation {
  schemaVersion: 1;
  agentId: string;
  skillId: string;
  indexRevision: string;
  digestSha256: string;
  files: AgentSkillFileManifestEntry[];
  scripts: SkillReviewScriptEvidence[];
  texts: SkillReviewTextEvidence[];
  allowedTools: string[];
  riskEvidence: AgentSkillRiskEvidence;
}

export interface SkillReviewAuditRequest extends SkillReviewPreparation {
  administratorApproved: true;
}

export interface SkillReviewAuditDecision {
  approved: boolean;
  digestSha256: string;
}

export interface SkillReviewAuditRunnerPort {
  review(request: SkillReviewAuditRequest): Promise<SkillReviewAuditDecision>;
}

const DOWNLOAD_PATTERN = /(?:^|[^A-Za-z0-9_])(?:npx|uvx|bunx)(?:[^A-Za-z0-9_]|$)|\b(?:npm|pnpm|yarn)\s+(?:install|i|add|exec|dlx)\b|\b(?:pip|pip3)\s+install\b|\bpython(?:3)?\s+-m\s+pip\s+install\b/iu;
const NETWORK_PATTERN = /(?:https?|ftp):\/\/|\/dev\/(?:tcp|udp)\/|\b(?:curl|wget|telnet|netcat|nc|ssh|scp|sftp)\b|\b(?:fetch|axios|urllib|requests\.(?:get|post|put|patch|delete))\s*\(/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const TOKEN_PATTERN = /\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{16,}\b/u;
const ASSIGNED_SECRET_PATTERN = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*["'][^"'\r\n$]{8,}["']/iu;
const MALICIOUS_LINK_PATTERN = /\b(?:upload|exfiltrat(?:e|ion)|send|post|curl|wget)\b[^\r\n]{0,160}https?:\/\/|https?:\/\/[^\r\n]{0,160}\b(?:password|secret|token|credential|private[_ -]?key)\b/iu;
const BINARY_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".mp3", ".mp4", ".mov", ".ogg", ".otf",
  ".pdf", ".png", ".tar", ".tgz", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".zip"
]);

export class DeterministicSkillReviewAuditRunner implements SkillReviewAuditRunnerPort {
  async review(request: SkillReviewAuditRequest): Promise<SkillReviewAuditDecision> {
    const digestSha256 = validDigest(request.digestSha256) ? request.digestSha256 : "";
    if (!validRequest(request)) return { approved: false, digestSha256 };
    for (const text of request.texts) {
      let source = "";
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(text.content);
      } catch {
        return { approved: false, digestSha256 };
      }
      if (source.includes("\0") || DOWNLOAD_PATTERN.test(source) || PRIVATE_KEY_PATTERN.test(source) ||
          TOKEN_PATTERN.test(source) || ASSIGNED_SECRET_PATTERN.test(source) || MALICIOUS_LINK_PATTERN.test(source) ||
          (text.kind === "script" && NETWORK_PATTERN.test(source))) {
        return { approved: false, digestSha256 };
      }
    }
    if (request.riskEvidence.mcpDependencies.length > 0 &&
        (request.riskEvidence.declaredFileAccess.length > 0 || request.allowedTools.length > 0)) {
      return { approved: false, digestSha256 };
    }
    return { approved: true, digestSha256 };
  }
}

function validRequest(request: SkillReviewAuditRequest) {
  if (request.schemaVersion !== 1 || request.administratorApproved !== true || !request.agentId || !request.skillId ||
      !validDigest(request.indexRevision) || !validDigest(request.digestSha256) ||
      !Array.isArray(request.files) || !request.files.length || request.files.length > 512 ||
      !Array.isArray(request.scripts) || request.scripts.length > request.files.length ||
      !Array.isArray(request.texts) || request.texts.length > request.files.length ||
      !Array.isArray(request.allowedTools) || request.allowedTools.length > 64 ||
      request.allowedTools.some((tool) => typeof tool !== "string" || !tool || tool.length > 128)) {
    return false;
  }
  const files = new Map<string, AgentSkillFileManifestEntry>();
  for (const file of request.files) {
    if (!validManifest(file) || files.has(file.path)) return false;
    files.set(file.path, file);
  }
  let total = 0;
  for (const script of request.scripts) {
    const manifest = files.get(script.path);
    if (!manifest || !script.path.startsWith("scripts/") || !Buffer.isBuffer(script.content) ||
        script.content.length !== script.bytes || script.bytes > SKILL_REVIEW_MAX_SCRIPT_BYTES ||
        script.sha256 !== manifest.sha256 || script.bytes !== manifest.bytes ||
        createHash("sha256").update(script.content).digest("hex") !== script.sha256) {
      return false;
    }
    total += script.bytes;
    if (total > SKILL_REVIEW_MAX_TOTAL_SCRIPT_BYTES) return false;
  }
  const expectedScripts = request.files.filter((file) => file.path.startsWith("scripts/"));
  if (expectedScripts.length !== request.scripts.length ||
      !expectedScripts.every((file) => request.scripts.some((script) => script.path === file.path))) return false;
  let textTotal = 0;
  const textPaths = new Set<string>();
  for (const text of request.texts) {
    const manifest = files.get(text.path);
    if (!manifest || textPaths.has(text.path) || !Buffer.isBuffer(text.content) ||
        text.content.length !== text.bytes || text.bytes > SKILL_REVIEW_MAX_TEXT_BYTES ||
        text.sha256 !== manifest.sha256 || text.bytes !== manifest.bytes ||
        text.kind !== textKind(text.path) ||
        createHash("sha256").update(text.content).digest("hex") !== text.sha256) {
      return false;
    }
    textPaths.add(text.path);
    textTotal += text.bytes;
    if (textTotal > SKILL_REVIEW_MAX_TOTAL_TEXT_BYTES) return false;
  }
  const expectedTexts = request.files.filter((file) => !BINARY_EXTENSIONS.has(extension(file.path)));
  return request.files.some((file) => file.path === "SKILL.md") &&
    expectedTexts.length === request.texts.length && expectedTexts.every((file) => textPaths.has(file.path));
}

function validManifest(file: AgentSkillFileManifestEntry) {
  return Boolean(file) && typeof file.path === "string" && file.path.length > 0 && file.path.length <= 240 &&
    !file.path.startsWith("/") && !file.path.includes("\\") && !file.path.includes("\0") &&
    file.path.split("/").every((segment) => segment && segment !== "." && segment !== "..") &&
    Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 8 * 1024 * 1024 &&
    validDigest(file.sha256);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function extension(filePath: string) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function textKind(filePath: string): SkillReviewTextEvidence["kind"] {
  if (filePath === "SKILL.md") return "instructions";
  if (filePath.startsWith("references/")) return "reference";
  if (filePath.startsWith("scripts/")) return "script";
  if (filePath === "agents/openai.yaml" || /(?:^|\/)(?:config|settings)\.[^/]+$/iu.test(filePath)) return "config";
  return "text";
}
