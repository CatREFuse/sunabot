import fs from "node:fs/promises";
import type {
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
}

export const CODEX_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["succeeded", "failed", "needs_input", "unknown"] },
    content: { type: ["string", "null"], maxLength: CODEX_SUMMARY_CHARS },
    question: { type: ["string", "null"], maxLength: 4_000 },
    error: { type: ["string", "null"], maxLength: 4_000 }
  },
  required: ["status", "content", "question", "error"]
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
    error: nullableString(parsed.error)
  };
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
