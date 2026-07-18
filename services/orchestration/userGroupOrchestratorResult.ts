import {
  readUserGroupOrchestratorResult,
  type UserGroupOrchestratorResultV1
} from "../../packages/contracts/session/runtimeMessages.js";

export interface UserGroupOrchestratorDecision {
  shouldReply: boolean;
  reason: string;
  replyToMessageId: string | null;
}

export function parseUserGroupOrchestratorDecision(
  text: string,
  replyCandidateMessageIds: readonly string[]
): UserGroupOrchestratorDecision | null {
  const parsed = parseModelJson(text);
  if (!isRecord(parsed) || !hasExactKeys(parsed, [
    "should_reply",
    "reason",
    "reply_to_message_id"
  ])) return null;
  const shouldReply = parsed.should_reply;
  if (typeof shouldReply !== "boolean") return null;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!validReason(reason)) return null;
  if (!shouldReply) {
    return parsed.reply_to_message_id === null
      ? { shouldReply: false, reason, replyToMessageId: null }
      : null;
  }

  const replyToMessageId = normalizeMessageId(parsed.reply_to_message_id);
  if (!replyToMessageId || !replyCandidateMessageIds.includes(replyToMessageId)) return null;
  return { shouldReply: true, reason, replyToMessageId };
}

export function userGroupOrchestratorResult(
  decision: UserGroupOrchestratorDecision
): UserGroupOrchestratorResultV1 | undefined {
  if (!decision.shouldReply || !decision.replyToMessageId) return undefined;
  return readUserGroupOrchestratorResult({
    schemaVersion: 1,
    reason: decision.reason,
    replyToMessageId: decision.replyToMessageId
  });
}

export function serializeUserGroupOrchestratorResult(
  value: UserGroupOrchestratorResultV1 | undefined
) {
  const result = readUserGroupOrchestratorResult(value);
  if (!result) return "";
  return JSON.stringify({
    should_reply: true,
    reason: result.reason,
    reply_to_message_id: result.replyToMessageId
  })
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function parseModelJson(text: string): unknown {
  return tryParseJson(text.trim());
}

function tryParseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeMessageId(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized === value
    && normalized
    && Array.from(normalized).length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : "";
}

function validReason(value: string) {
  return Boolean(value) && Array.from(value).length <= 1_000 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
