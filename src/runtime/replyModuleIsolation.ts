import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import { isAbortError } from "./infrastructure.js";

export interface ReplyModuleIsolationOptions {
  signal?: AbortSignal;
  onFailure?: (error: unknown) => void;
}

export async function isolateReplyModule<T>(
  module: string,
  operation: () => Promise<T>,
  fallback: () => T | Promise<T>,
  options: ReplyModuleIsolationOptions = {}
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    console.error("[runtime] optional reply module unavailable", { module, error });
    options.onFailure?.(error);
    return await fallback();
  }
}

export function appendReplySoftError(text: string, reason: string) {
  const trimmedText = text.trim();
  const trimmedReason = reason.trim();
  if (!trimmedReason) return trimmedText;
  const existing = trimmedText.match(/（错误：([^（）]*)）\s*$/);
  if (!existing || existing.index == null) {
    return `${trimmedText}${trimmedText ? "\n" : ""}（错误：${trimmedReason}）`;
  }
  const reasons = existing[1]!
    .split("；")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!reasons.includes(trimmedReason)) reasons.push(trimmedReason);
  return `${trimmedText.slice(0, existing.index)}（错误：${reasons.join("；")}）`;
}

export function appendReplySoftErrors(text: string, reasons: readonly string[]) {
  return [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))]
    .reduce((current, reason) => appendReplySoftError(current, reason), text);
}

export async function appendReplyActionLog(entry: Parameters<typeof appendRequestLog>[0]) {
  try {
    await appendRequestLog(entry);
  } catch (error) {
    console.error("[runtime] reply action log unavailable", {
      action: entry.action,
      error
    });
  }
}
