import type { MemoryFactInput } from "../../services/memory/memoryService.js";
import { uniqueStrings } from "./messagingAttachmentHelpers.js";
import type { BatchUserInfo } from "./runtimeContracts.js";

export function normalizeQqId(value: unknown) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/^(?:QQ(?:号)?\s*[:：#]?\s*)?(\d{5,12})$/iu);
  return match?.[1] ?? "";
}

export function normalizeQqIds(value: unknown) {
  return uniqueStrings(qqIdentityParts(value).map(normalizeQqId).filter(Boolean));
}

export function hasInvalidQqIdentity(value: unknown) {
  return qqIdentityParts(value).some((part) => !normalizeQqId(part));
}

function qqIdentityParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(qqIdentityParts);
  const text = stringValue(value);
  if (!text) return [];
  if (normalizeQqId(text)) return [text];
  return text.split(/[,\s，、/]+/).filter(Boolean);
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

export function resolveFactUsers(fact: MemoryFactInput, participants: BatchUserInfo[]) {
  if (!participants.length) return [];
  const participantById = new Map(participants.map((user) => [user.userId, user]));
  const explicitIds = uniqueStrings([
    ...normalizeQqIds(fact.userIds),
    ...normalizeQqIds(fact.userId)
  ]);
  const explicitUsers = explicitIds.flatMap((id) => {
    const user = participantById.get(id);
    return user ? [user] : [];
  });
  if (explicitUsers.length) return explicitUsers;
  return participants.length === 1 ? participants : [];
}
