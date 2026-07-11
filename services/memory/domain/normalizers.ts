import { createHash } from "node:crypto";
import type {
  MemoryFactInput,
  MemoryIdentityConfig,
  MemoryRecord,
  NormalizedMemoryFact
} from "../types.js";

export function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeUserId(value: unknown) {
  const text = normalizeText(value);
  if (!text) return "";
  const match = text.match(/\d{5,}/);
  return match?.[0] ?? text;
}

export function normalizeUserIds(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : normalizeText(value)
      .split(/[,\s，、/]+/)
      .filter(Boolean);
  return [...new Set(values.map(normalizeUserId).filter(Boolean))];
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function optionalString(value: unknown) {
  const text = normalizeText(value);
  return text || undefined;
}

export function normalizeLimit(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 20);
}

export function computeMemoryEventKey(eventTypeInput: unknown, subjectKeyInput: unknown, userIdsInput: unknown) {
  const eventType = normalizeEventType(eventTypeInput);
  const subjectKey = normalizeSubjectKey(subjectKeyInput);
  const userIds = normalizeUserIds(userIdsInput).sort();
  if (!eventType || !subjectKey) return "";
  return `v1:sha256:${sha256(JSON.stringify({ eventType, subjectKey, userIds }))}`;
}

export function computeMemoryEventFingerprint(input: {
  fact: unknown;
  userIds?: unknown;
  occurredAt?: unknown;
  occurredEndAt?: unknown;
}) {
  return `sha256:${sha256(JSON.stringify({
    fact: normalizeFingerprintText(input.fact),
    userIds: normalizeUserIds(input.userIds).sort(),
    occurredAt: normalizeIsoTimestamp(input.occurredAt) || null,
    occurredEndAt: normalizeIsoTimestamp(input.occurredEndAt) || null
  }))}`;
}

export function parseEventTime(startInput: unknown, endInput?: unknown) {
  const explicitEnd = normalizeIsoTimestamp(endInput);
  const text = normalizeText(startInput);
  const direct = normalizeIsoTimestamp(text);
  if (direct) return { occurredAt: direct, occurredEndAt: explicitEnd };
  const range = splitLegacyTimeRange(text);
  return {
    occurredAt: normalizeIsoTimestamp(range?.[0]),
    occurredEndAt: explicitEnd || normalizeIsoTimestamp(range?.[1])
  };
}

export function splitLegacyTimeRange(value: string): [string, string] | undefined {
  if (!value) return undefined;
  for (const separator of ["/", "~", "～"]) {
    const index = value.indexOf(separator);
    if (index > 0) return [value.slice(0, index), value.slice(index + separator.length)];
  }
  const zRange = value.match(/^(.+Z)-(\d{4}-\d{2}-\d{2}T.+Z)$/);
  return zRange ? [zRange[1]!, zRange[2]!] : undefined;
}

export function normalizeIsoTimestamp(value: unknown) {
  const text = normalizeText(value);
  if (!text) return "";
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export function normalizeEventType(value: unknown) {
  const type = normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return type.slice(0, 64);
}

export function normalizeSubjectKey(value: unknown) {
  return normalizeText(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").slice(0, 512);
}

export function normalizeFingerprintText(value: unknown) {
  return normalizeText(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

export function normalizeStringArray(value: unknown) {
  const values = Array.isArray(value) ? value : normalizeText(value).split(/[,，、\s]+/);
  return uniqueStrings(values.map(normalizeText).filter(Boolean));
}

export function normalizeAddressName(value: unknown) {
  return normalizeText(value).slice(0, 120);
}

export function readAddressName(value: Record<string, unknown>) {
  return normalizeAddressName(value.addressName ?? value.address_name ?? value.salutation);
}

export function configuredAddressName(config: MemoryIdentityConfig, userId: string, requested: string) {
  const adminQq = normalizeUserId(config.bot.adminQq);
  if (userId && adminQq && userId === adminQq) {
    return normalizeAddressName(config.bot.adminName) || "猫老师";
  }
  return requested;
}

export function isMemoryEventKey(value: string) {
  return /^v\d+:sha256:[a-f0-9]{64}$/.test(value);
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function earliestIsoLike(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime <= rightTime ? left : right;
  return left;
}

export function latestIsoLike(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime >= rightTime ? left : right;
  return right;
}

export function memoryRecordsEqual(left: MemoryRecord[], right: MemoryRecord[]) {
  if (left.length !== right.length) return false;
  return left.every((record, index) => JSON.stringify(record.value) === JSON.stringify(right[index]?.value));
}

export function normalizeMemoryFactInputs(facts: MemoryFactInput[]): NormalizedMemoryFact[] {
  return facts
    .map((item) => {
      const range = parseEventTime(item.occurredAt ?? item.time, item.occurredEndAt);
      return {
        id: normalizeText(item.id),
        fact: normalizeText(item.fact),
        time: normalizeText(item.time),
        occurredAt: range.occurredAt,
        occurredEndAt: range.occurredEndAt,
        observedAt: normalizeIsoTimestamp(item.observedAt),
        createdAt: normalizeIsoTimestamp(item.createdAt),
        updatedAt: normalizeIsoTimestamp(item.updatedAt),
        source: normalizeText(item.source),
        userId: normalizeUserId(item.userId),
        userIds: normalizeUserIds(item.userIds),
        userName: normalizeText(item.userName),
        addressName: normalizeAddressName(item.addressName ?? item.address_name ?? item.salutation),
        sourceWorkingMemoryIds: normalizeStringArray(item.sourceWorkingMemoryIds),
        sourceCandidateIds: normalizeStringArray(item.sourceCandidateIds),
        eventType: normalizeEventType(item.eventType),
        subjectKey: normalizeSubjectKey(item.subjectKey),
        eventKey: normalizeText(item.eventKey),
        eventFingerprint: normalizeText(item.eventFingerprint),
        longTermId: normalizeText(item.longTermId),
        batchId: normalizeText(item.batchId),
        promoteToLongTerm: item.promoteToLongTerm === true
      };
    })
    .filter((item) => item.fact);
}

export function memorySnapshotToken(records: MemoryRecord[]) {
  const content = records.map((record) => JSON.stringify(record.value)).join("\n");
  return createHash("sha256").update(content).digest("hex");
}

export function memoryRecordChanged(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const previousComparable = { ...previous };
  const nextComparable = { ...next };
  delete previousComparable.updatedAt;
  delete nextComparable.updatedAt;
  return JSON.stringify(previousComparable) !== JSON.stringify(nextComparable);
}
