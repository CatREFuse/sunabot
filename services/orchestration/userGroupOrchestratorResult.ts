import {
  readUserGroupOrchestratorResult,
  type UserGroupOrchestratorResultV1
} from "../../packages/contracts/session/runtimeMessages.js";
import { modelContentText, parseModelJson } from "../../packages/contracts/model/modelContent.js";

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
  if (!isRecord(parsed)) return null;
  const shouldReply = parsed.should_reply === "true" ? true
    : parsed.should_reply === "false" ? false : parsed.should_reply;
  if (typeof shouldReply !== "boolean") return null;
  const reason = modelContentText(parsed.reason);
  if (!shouldReply) {
    return { shouldReply: false, reason, replyToMessageId: null };
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

function normalizeMessageId(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
