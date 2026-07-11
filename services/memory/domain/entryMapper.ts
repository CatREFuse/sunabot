import type { MemoryEntry, MemoryRecord, SourceDefinition } from "../types.js";
import { readMemoryText } from "./memoryText.js";
import { formatUserProfileKey, stripUserProfileFactPrefix } from "./profileMergePolicy.js";
import {
  normalizeStringArray,
  normalizeText,
  normalizeUserIds,
  optionalString
} from "./normalizers.js";

export function toMemoryEntry(source: SourceDefinition, record: MemoryRecord): MemoryEntry {
  const userId = optionalString(record.value.userId);
  const userName = optionalString(record.value.userName);
  const addressName = optionalString(record.value.addressName ?? record.value.address_name ?? record.value.salutation);
  const text = source.id === "user_profile"
    ? stripUserProfileFactPrefix(readMemoryText(source, record.value), userId, userName)
    : readMemoryText(source, record.value);
  const id = normalizeText(record.value.id) || `${source.id}:${record.index}`;
  const key = source.id === "user_profile" ? formatUserProfileKey(userId, userName, id) : id;
  return {
    id,
    source: source.id,
    sourceTitle: source.title,
    fileName: source.fileName,
    editable: source.editable,
    key,
    value: text,
    text,
    field: source.field,
    time: optionalString(record.value.time) ?? optionalString(record.value.occurredAt),
    occurredAt: optionalString(record.value.occurredAt),
    occurredEndAt: optionalString(record.value.occurredEndAt),
    observedAt: optionalString(record.value.observedAt),
    createdAt: optionalString(record.value.createdAt),
    updatedAt: optionalString(record.value.updatedAt),
    legacyTime: optionalString(record.value.legacyTime),
    legacyCreatedAt: optionalString(record.value.legacyCreatedAt),
    userId,
    userIds: normalizeUserIds(record.value.userIds),
    userName,
    addressName,
    sourceWorkingMemoryIds: normalizeStringArray(record.value.sourceWorkingMemoryIds),
    sourceCandidateIds: normalizeStringArray(record.value.sourceCandidateIds),
    eventType: optionalString(record.value.eventType),
    subjectKey: optionalString(record.value.subjectKey),
    eventKey: optionalString(record.value.eventKey),
    eventFingerprint: optionalString(record.value.eventFingerprint),
    longTermId: optionalString(record.value.longTermId),
    batchId: optionalString(record.value.batchId),
    promoteToLongTerm: record.value.promoteToLongTerm === true || undefined
  };
}

export function compareMemoryEntries(left: MemoryEntry, right: MemoryEntry) {
  const leftTime = Date.parse(left.occurredAt || left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.occurredAt || right.updatedAt || right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.source.localeCompare(right.source) || left.id.localeCompare(right.id);
}
