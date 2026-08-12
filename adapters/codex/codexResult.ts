import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CodexResultArtifactV1,
  CodexSupervisorRequest,
  CodexTaskKind,
  CodexTaskStatus,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import { CodexProtocolError } from "./codexProtocol.js";

const CODEX_MAX_RESULT_BYTES = 32 * 1024 * 1024;
const CODEX_SUMMARY_CHARS = 32 * 1024;

export interface ModelResult {
  status: "succeeded" | "failed" | "needs_input" | "unknown";
  content?: string | null;
  question?: string | null;
  error?: string | null;
  artifacts?: ModelResultArtifactDeclaration[];
}

export interface ModelResultArtifactDeclaration {
  relativePath: string;
  displayName: string;
}

export const CODEX_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["succeeded", "failed", "needs_input", "unknown"] },
    content: { type: ["string", "null"], maxLength: CODEX_SUMMARY_CHARS },
    question: { type: ["string", "null"], maxLength: 4_000 },
    error: { type: ["string", "null"], maxLength: 4_000 },
    artifacts: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relativePath: { type: "string", minLength: 1, maxLength: 1_024 },
          displayName: { type: "string", minLength: 1, maxLength: 180 }
        },
        required: ["relativePath", "displayName"]
      }
    }
  },
  required: ["status", "content", "question", "error", "artifacts"]
} as const;

export async function readCodexResult(filePath: string): Promise<ModelResult> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseCodexResultText(raw);
}

export function parseCodexResultText(raw: string): ModelResult {
  if (Buffer.byteLength(raw) > CODEX_MAX_RESULT_BYTES) {
    throw new CodexProtocolError("result_limit", `Codex result exceeded ${CODEX_MAX_RESULT_BYTES} bytes.`);
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("result must be an object");
  const status = String(parsed.status ?? "");
  if (status !== "succeeded" && status !== "failed" && status !== "needs_input" && status !== "unknown") {
    throw new Error("result status is invalid");
  }
  return {
    status,
    content: nullableString(parsed.content),
    question: nullableString(parsed.question),
    error: nullableString(parsed.error),
    artifacts: parseArtifactDeclarations(parsed.artifacts)
  };
}

export async function validateCodexResultArtifacts(input: {
  declarations: readonly ModelResultArtifactDeclaration[];
  outputDir: string;
  jobDir: string;
}): Promise<CodexResultArtifactV1[]> {
  if (input.declarations.length > 8) throw new Error("Codex declared too many artifacts.");
  const lexicalJobRoot = path.resolve(input.jobDir);
  const lexicalOutputRoot = path.resolve(input.outputDir);
  const lexicalOutputRelative = expectedWorkerOutputRelativePath(
    lexicalJobRoot,
    lexicalOutputRoot
  );
  const jobStat = await fs.lstat(lexicalJobRoot);
  const outputStat = await fs.lstat(lexicalOutputRoot);
  if (
    !jobStat.isDirectory()
    || jobStat.isSymbolicLink()
    || !outputStat.isDirectory()
    || outputStat.isSymbolicLink()
  ) {
    throw new Error("Codex output directory is unsafe.");
  }
  const outputRoot = await fs.realpath(input.outputDir);
  const jobRoot = await fs.realpath(input.jobDir);
  if (
    expectedWorkerOutputRelativePath(jobRoot, outputRoot) !== lexicalOutputRelative
  ) {
    throw new Error("Codex output directory identity changed.");
  }
  const artifacts: CodexResultArtifactV1[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const declaration of input.declarations) {
    const relativePath = safeArtifactRelativePath(declaration.relativePath);
    const displayName = safeArtifactDisplayName(declaration.displayName);
    const absolutePath = path.resolve(outputRoot, relativePath);
    const relativeToRoot = path.relative(outputRoot, absolutePath);
    if (
      relativeToRoot === ""
      || relativeToRoot === ".."
      || relativeToRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToRoot)
    ) {
      throw new Error("Codex artifact escapes its output directory.");
    }
    const realPath = await fs.realpath(absolutePath);
    if (realPath !== absolutePath) {
      throw new Error("Codex artifact cannot use a symbolic link.");
    }
    if (seenPaths.has(realPath)) {
      throw new Error("Codex artifact paths must be unique.");
    }
    seenPaths.add(realPath);
    const relativeToJob = path.relative(jobRoot, realPath);
    if (
      !relativeToJob
      || relativeToJob === ".."
      || relativeToJob.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToJob)
    ) {
      throw new Error("Codex artifact escapes its job directory.");
    }
    const handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW")
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile()
        || before.nlink !== 1n
        || before.size < 1n
        || before.size > 64n * 1024n * 1024n
      ) {
        throw new Error("Codex artifact is not a bounded regular file.");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let sizeBytes = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        sizeBytes += bytesRead;
        if (sizeBytes > 64 * 1024 * 1024) {
          throw new Error("Codex artifact exceeds its size limit.");
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs
        || sizeBytes !== Number(before.size)
      ) {
        throw new Error("Codex artifact changed during validation.");
      }
      totalBytes += sizeBytes;
      if (totalBytes > 128 * 1024 * 1024) {
        throw new Error("Codex artifacts exceed their total size limit.");
      }
      artifacts.push({
        schemaVersion: 1,
        relativePath: relativeToJob.split(path.sep).join("/"),
        displayName,
        sha256: hash.digest("hex"),
        sizeBytes,
        ...(artifactMimeType(displayName) ? { mimeType: artifactMimeType(displayName) } : {})
      });
    } finally {
      await handle.close();
    }
  }
  return artifacts;
}

function expectedWorkerOutputRelativePath(jobRoot: string, outputRoot: string) {
  const relative = path.relative(jobRoot, outputRoot);
  const parts = relative.split(path.sep);
  if (
    parts.length !== 3
    || parts[0] !== ".codex-worker"
    || !/^attempt-[1-9][0-9]*-[A-Za-z0-9_-]{1,128}$/u.test(parts[1] ?? "")
    || parts[2] !== "outputs"
    || path.isAbsolute(relative)
  ) {
    throw new Error("Codex output directory is outside its attempt tree.");
  }
  return relative;
}

export function withTruncatedOutputNotice(
  result: CodexToolResult,
  details: { outputBytes: number; reportFile: string }
): CodexToolResult {
  const notice = `Codex 输出已截断。报告位置：${details.reportFile}`;
  const summary = result.content?.trim()
    ? `${result.content.trim().slice(0, CODEX_SUMMARY_CHARS)}\n\n${notice}`
    : notice;
  return {
    ...result,
    content: summary,
    resultFile: details.reportFile,
    outputTruncated: true,
    outputBytes: details.outputBytes
  };
}

export function normalizeModelResult(
  request: CodexSupervisorRequest,
  result: ModelResult,
  common: Partial<CodexToolResult>
): CodexToolResult {
  if (result.status === "succeeded") {
    const content = result.content?.trim();
    if (!content) {
      return failureResult(request.jobId, request.kind, "unknown", "empty_result", "Codex returned an empty result.", false, common);
    }
    return {
      ok: true,
      status: "succeeded",
      jobId: request.jobId,
      kind: request.kind,
      content,
      ...common
    };
  }
  if (result.status === "needs_input") {
    const question = result.question?.trim();
    if (!question) {
      return failureResult(request.jobId, request.kind, "unknown", "question_missing", "Codex requested input without a question.", false, common);
    }
    return {
      ok: false,
      status: "needs_input",
      jobId: request.jobId,
      kind: request.kind,
      question,
      content: result.content?.trim() || undefined,
      ...common
    };
  }
  return failureResult(
    request.jobId,
    request.kind,
    result.status,
    result.status === "failed" ? "codex_task_failed" : "codex_task_unknown",
    result.error?.trim() || result.content?.trim() || "Codex did not provide a conclusive result.",
    result.status === "failed",
    common
  );
}

export function failureResult(
  jobId: string,
  kind: CodexTaskKind,
  status: Exclude<CodexTaskStatus, "succeeded" | "needs_input">,
  code: string,
  message: string,
  retryable: boolean,
  details: Partial<CodexToolResult> = {}
): CodexToolResult {
  return {
    ok: false,
    status,
    jobId: String(jobId ?? ""),
    kind,
    error: { code, message: message.slice(0, 4_000), retryable },
    ...details
  };
}

function nullableString(value: unknown) {
  return value == null ? null : typeof value === "string" ? value : String(value);
}

function parseArtifactDeclarations(value: unknown): ModelResultArtifactDeclaration[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("result artifacts are invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("result artifact must be an object");
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2
      || typeof record.relativePath !== "string"
      || typeof record.displayName !== "string"
    ) {
      throw new Error("result artifact fields are invalid");
    }
    return {
      relativePath: safeArtifactRelativePath(record.relativePath),
      displayName: safeArtifactDisplayName(record.displayName)
    };
  });
}

function safeArtifactRelativePath(value: string) {
  const candidate = value.trim();
  if (
    !candidate
    || candidate.length > 1_024
    || candidate.includes("\\")
    || path.posix.isAbsolute(candidate)
  ) {
    throw new Error("Codex artifact path is invalid.");
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== candidate
  ) {
    throw new Error("Codex artifact path is invalid.");
  }
  return normalized;
}

function safeArtifactDisplayName(value: string) {
  const candidate = value.normalize("NFC").trim();
  if (
    !candidate
    || [...candidate].length > 180
    || path.basename(candidate) !== candidate
    || /[\u0000-\u001f\u007f/\\]/u.test(candidate)
  ) {
    throw new Error("Codex artifact display name is invalid.");
  }
  return candidate;
}

function artifactMimeType(fileName: string) {
  const extension = path.extname(fileName).toLocaleLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv";
  if (extension === ".md" || extension === ".txt") return "text/plain";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".zip") return "application/zip";
  return undefined;
}

function requiredFlag(name: "O_NOFOLLOW") {
  const value = fsConstants[name];
  if (typeof value !== "number") throw new Error(`${name} is unavailable.`);
  return value;
}
