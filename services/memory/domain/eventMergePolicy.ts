import { nanoid } from "nanoid";
import type { MemoryRecord, NormalizedMemoryFact, SourceDefinition } from "../types.js";
import {
  computeMemoryEventFingerprint,
  computeMemoryEventKey,
  isMemoryEventKey,
  mergeCompatibleCausalChainKeys,
  memoryRecordChanged,
  normalizeIsoTimestamp,
  normalizeAddressNames,
  normalizeStringArray,
  normalizeText,
  normalizeUserId,
  normalizeUserIds,
  sha256,
  uniqueStrings
} from "./normalizers.js";

export function buildWorkingMemoryRecords(
  source: SourceDefinition,
  records: MemoryRecord[],
  normalizedFacts: NormalizedMemoryFact[],
  metadata: Record<string, unknown>,
  now: string,
  allocateNewId?: (fact: NormalizedMemoryFact, index: number) => string
) {
  const existingById = new Map(records.map((record) => [normalizeText(record.value.id), record]));
  const reusedIds = new Set<string>();
  return normalizedFacts.map((fact, index) => {
    const requestedId = fact.id;
    const existing = requestedId && !reusedIds.has(requestedId) ? existingById.get(requestedId) : undefined;
    if (existing) reusedIds.add(requestedId);
    const id = existing ? requestedId : allocateNewId?.(fact, index) || `${source.id}_${nanoid()}`;
    const previous = existing?.value ?? {};
    const value = buildEventMemoryValue(source, mergeNormalizedEventFact(fact, previous), { ...metadata, ...previous }, now, id);
    value.createdAt = normalizeIsoTimestamp(previous.createdAt) || now;
    if (existing && memoryRecordChanged(existing.value, value)) value.updatedAt = now;
    return { index, value };
  });
}

export function mergeNormalizedEventFact(fact: NormalizedMemoryFact, previous: Record<string, unknown>) {
  return {
    ...fact,
    userId: fact.userId || normalizeUserId(previous.userId),
    userIds: fact.userIds.length ? fact.userIds : normalizeUserIds(previous.userIds),
    userName: fact.userName || normalizeText(previous.userName),
    addressNames: fact.addressNames.length
      ? fact.addressNames
      : normalizeAddressNames(previous.addressNames ?? previous.addressName ?? previous.address_name ?? previous.salutation),
    occurredAt: fact.occurredAt || normalizeIsoTimestamp(previous.occurredAt),
    occurredEndAt: fact.occurredEndAt || normalizeIsoTimestamp(previous.occurredEndAt),
    observedAt: fact.observedAt || normalizeIsoTimestamp(previous.observedAt),
    sourceWorkingMemoryIds: fact.sourceWorkingMemoryIds.length
      ? fact.sourceWorkingMemoryIds
      : normalizeStringArray(previous.sourceWorkingMemoryIds),
    sourceCandidateIds: fact.sourceCandidateIds.length
      ? fact.sourceCandidateIds
      : normalizeStringArray(previous.sourceCandidateIds),
    eventType: fact.eventType || normalizeText(previous.eventType),
    subjectKey: fact.subjectKey || normalizeText(previous.subjectKey),
    eventKey: fact.eventKey || normalizeText(previous.eventKey),
    causalChainKey: mergeCompatibleCausalChainKeys(fact.causalChainKey, previous.causalChainKey),
    eventFingerprint: fact.eventFingerprint || normalizeText(previous.eventFingerprint),
    longTermId: fact.longTermId || normalizeText(previous.longTermId),
    batchId: fact.batchId || normalizeText(previous.batchId),
    promoteToLongTerm: fact.promoteToLongTerm || previous.promoteToLongTerm === true
  };
}

export function attachWorkingSourcesToLongTermFacts(
  longTermFacts: NormalizedMemoryFact[],
  workingFacts: NormalizedMemoryFact[]
) {
  const promotedWorkingFacts = workingFacts.filter((fact) => fact.promoteToLongTerm);
  return longTermFacts.map((longTermFact) => {
    const sourceMappedWorking = promotedWorkingFacts.filter((workingFact) => (
      longTermFact.sourceWorkingMemoryIds.includes(workingFact.id)
    ));
    if (sourceMappedWorking.length) {
      return {
        ...longTermFact,
        causalChainKey: mergeCompatibleCausalChainKeys(
          longTermFact.causalChainKey,
          ...sourceMappedWorking.map((workingFact) => workingFact.causalChainKey)
        )
      };
    }
    if (longTermFact.sourceWorkingMemoryIds.length) return longTermFact;
    const preparedLongTerm = prepareLongTermFact(longTermFact);
    const matchingWorking = promotedWorkingFacts.filter((workingFact) => {
      const preparedWorking = prepareLongTermFact(workingFact);
      if (preparedLongTerm.eventKey && preparedWorking.eventKey === preparedLongTerm.eventKey) return true;
      return preparedWorking.eventFingerprint === preparedLongTerm.eventFingerprint;
    });
    return matchingWorking.length === 1
      ? {
          ...longTermFact,
          sourceWorkingMemoryIds: [matchingWorking[0]!.id],
          causalChainKey: mergeCompatibleCausalChainKeys(
            longTermFact.causalChainKey,
            matchingWorking[0]!.causalChainKey
          )
        }
      : longTermFact;
  });
}

export function attachLongTermMappingsToWorkingFacts(
  workingFacts: NormalizedMemoryFact[],
  longTermRecords: MemoryRecord[]
) {
  return workingFacts.map((workingFact) => {
    if (!workingFact.promoteToLongTerm) return workingFact;
    const preparedWorking = prepareLongTermFact(workingFact);
    const mapped = longTermRecords.find((record) => normalizeStringArray(record.value.sourceWorkingMemoryIds).includes(workingFact.id))
      ?? longTermRecords.find((record) => preparedWorking.eventKey
        && normalizeText(record.value.eventKey) === preparedWorking.eventKey
        && participantsCompatible(record.value, preparedWorking)
        && eventTimesOverlap(record.value, preparedWorking))
      ?? longTermRecords.find((record) => normalizeText(record.value.eventFingerprint) === preparedWorking.eventFingerprint
        && participantsCompatible(record.value, preparedWorking)
        && eventTimesOverlap(record.value, preparedWorking));
    if (!mapped) return workingFact;
    return {
      ...workingFact,
      longTermId: normalizeText(mapped.value.id),
      eventKey: normalizeText(mapped.value.eventKey) || preparedWorking.eventKey,
      causalChainKey: mergeCompatibleCausalChainKeys(
        preparedWorking.causalChainKey,
        mapped.value.causalChainKey
      )
    };
  });
}

export function buildLongTermMemoryRecords(
  source: SourceDefinition,
  records: MemoryRecord[],
  facts: NormalizedMemoryFact[],
  metadata: Record<string, unknown>,
  now: string
) {
  const nextRecords = records.map((record) => ({ index: record.index, value: { ...record.value } }));
  const touchedIds = new Set<string>();
  for (const [factIndex, fact] of facts.entries()) {
    const prepared = prepareLongTermFact(fact);
    const requestedId = prepared.longTermId;
    const requested = requestedId
      ? nextRecords.find((record) => normalizeText(record.value.id) === requestedId && participantsCompatible(record.value, prepared))
      : undefined;
    const sourceMatches = nextRecords.filter((record) => {
      if (!participantsCompatible(record.value, prepared)) return false;
      const sourceIds = normalizeStringArray(record.value.sourceWorkingMemoryIds);
      return prepared.sourceWorkingMemoryIds.some((id) => sourceIds.includes(id));
    });
    const eventKeyMatches = prepared.eventKey
      ? nextRecords.filter((record) => participantsCompatible(record.value, prepared)
        && normalizeText(record.value.eventKey) === prepared.eventKey
        && eventTimesOverlap(record.value, prepared))
      : [];
    const fingerprintMatches = nextRecords.filter((record) => participantsCompatible(record.value, prepared)
      && normalizeText(record.value.eventFingerprint) === prepared.eventFingerprint
      && eventTimesOverlap(record.value, prepared));
    const matchingRecords = requested
      ? [requested]
      : (sourceMatches.length ? sourceMatches : eventKeyMatches.length ? eventKeyMatches : fingerprintMatches)
        .sort(compareLongTermRecordAge);
    const selected = requested ?? matchingRecords[0];
    const stableId = selected
      ? normalizeText(selected.value.id)
      : allocateLongTermId(prepared, metadata, factIndex, nextRecords);
    const previous = selected?.value ?? {};
    const combined = mergeNormalizedEventFact(prepared, previous);
    combined.causalChainKey = mergeCompatibleCausalChainKeys(
      prepared.causalChainKey,
      ...matchingRecords.map((record) => record.value.causalChainKey)
    );
    combined.sourceWorkingMemoryIds = uniqueStrings([
      ...matchingRecords.flatMap((record) => normalizeStringArray(record.value.sourceWorkingMemoryIds)),
      ...prepared.sourceWorkingMemoryIds
    ]).sort();
    combined.sourceCandidateIds = uniqueStrings([
      ...matchingRecords.flatMap((record) => normalizeStringArray(record.value.sourceCandidateIds)),
      ...prepared.sourceCandidateIds
    ]).sort();
    combined.occurredAt = matchingRecords.reduce(
      (time, record) => earliestValidIso(time, normalizeIsoTimestamp(record.value.occurredAt)),
      prepared.occurredAt
    );
    combined.occurredEndAt = matchingRecords.reduce(
      (time, record) => mergeEventEnd(record.value.occurredEndAt, time),
      prepared.occurredEndAt
    );
    combined.observedAt = matchingRecords.reduce(
      (time, record) => earliestValidIso(time, normalizeIsoTimestamp(record.value.observedAt)),
      prepared.observedAt
    );
    combined.longTermId = "";
    combined.promoteToLongTerm = false;
    const value = buildEventMemoryValue(source, combined, { ...metadata, ...previous }, now, stableId);
    value.createdAt = normalizeIsoTimestamp(previous.createdAt) || now;
    value.updatedAt = now;
    if (selected) {
      selected.value = value;
      for (const redundant of matchingRecords.slice(1)) {
        const redundantIndex = nextRecords.indexOf(redundant);
        if (redundantIndex >= 0) nextRecords.splice(redundantIndex, 1);
      }
    }
    else nextRecords.push({ index: nextRecords.length, value });
    touchedIds.add(stableId);
  }
  return {
    records: nextRecords.map((record, index) => ({ index, value: record.value })),
    touchedIds
  };
}

export function prepareLongTermFact(fact: NormalizedMemoryFact) {
  const userIds = uniqueStrings([...(fact.userIds ?? []), ...(fact.userId ? [fact.userId] : [])]).sort();
  const eventKey = fact.eventType && fact.subjectKey
    ? computeMemoryEventKey(fact.eventType, fact.subjectKey, userIds)
    : isMemoryEventKey(fact.eventKey) ? fact.eventKey : "";
  return {
    ...fact,
    userIds,
    eventKey,
    eventFingerprint: computeMemoryEventFingerprint({
      fact: fact.fact,
      userIds,
      occurredAt: fact.occurredAt,
      occurredEndAt: fact.occurredEndAt
    })
  };
}

export function participantsCompatible(record: Record<string, unknown>, fact: NormalizedMemoryFact) {
  const left = normalizeUserIds(record.userIds ?? record.userId).sort();
  const right = uniqueStrings([...(fact.userIds ?? []), ...(fact.userId ? [fact.userId] : [])]).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function eventTimesOverlap(record: Record<string, unknown>, fact: NormalizedMemoryFact) {
  const leftStart = Date.parse(normalizeText(record.occurredAt));
  const rightStart = Date.parse(fact.occurredAt);
  if (!Number.isFinite(leftStart) && !Number.isFinite(rightStart)) return true;
  if (!Number.isFinite(leftStart) || !Number.isFinite(rightStart)) return false;
  const leftEnd = Date.parse(normalizeText(record.occurredEndAt));
  const rightEnd = Date.parse(fact.occurredEndAt);
  const effectiveLeftEnd = Number.isFinite(leftEnd) ? leftEnd : Number.POSITIVE_INFINITY;
  const effectiveRightEnd = Number.isFinite(rightEnd) ? rightEnd : Number.POSITIVE_INFINITY;
  return leftStart <= effectiveRightEnd && rightStart <= effectiveLeftEnd;
}

export function compareLongTermRecordAge(left: MemoryRecord, right: MemoryRecord) {
  const leftCreatedAt = Date.parse(normalizeText(left.value.createdAt));
  const rightCreatedAt = Date.parse(normalizeText(right.value.createdAt));
  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }
  return normalizeText(left.value.id).localeCompare(normalizeText(right.value.id));
}

export function allocateLongTermId(
  fact: NormalizedMemoryFact,
  metadata: Record<string, unknown>,
  index: number,
  records: MemoryRecord[]
) {
  const seed = JSON.stringify({
    eventKey: fact.eventKey,
    eventFingerprint: fact.eventFingerprint,
    sourceWorkingMemoryIds: fact.sourceWorkingMemoryIds,
    batchId: fact.batchId || normalizeText(metadata.batchId),
    index
  });
  const base = `long_term_${sha256(seed).slice(0, 32)}`;
  if (!records.some((record) => normalizeText(record.value.id) === base)) return base;
  return `long_term_${sha256(`${seed}:collision`).slice(0, 40)}`;
}

export function earliestValidIso(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

export function mergeEventEnd(previous: unknown, next: string) {
  const left = normalizeIsoTimestamp(previous);
  if (!left) return next;
  if (!next) return left;
  return Date.parse(left) >= Date.parse(next) ? left : next;
}

export function buildEventMemoryValue(
  source: SourceDefinition,
  fact: NormalizedMemoryFact,
  metadata: Record<string, unknown>,
  now: string,
  id: string
) {
  const userIds = uniqueStrings([
    ...fact.userIds,
    ...(fact.userId ? [fact.userId] : [])
  ]).sort();
  const userId = fact.userId || (userIds.length === 1 ? userIds[0]! : "");
  const eventKey = fact.eventType && fact.subjectKey
    ? computeMemoryEventKey(fact.eventType, fact.subjectKey, userIds)
    : isMemoryEventKey(fact.eventKey) ? fact.eventKey : "";
  const eventFingerprint = computeMemoryEventFingerprint({
    fact: fact.fact,
    userIds,
    occurredAt: fact.occurredAt,
    occurredEndAt: fact.occurredEndAt
  });
  const causalChainKey = mergeCompatibleCausalChainKeys(fact.causalChainKey);
  const value: Record<string, unknown> = {
    ...metadata,
    schemaVersion: 2,
    id,
    [source.field]: fact.fact,
    createdAt: fact.createdAt || normalizeIsoTimestamp(metadata.createdAt) || now,
    updatedAt: fact.updatedAt || now,
    source: fact.source || normalizeText(metadata.source) || "sunabot.memory.compress"
  };

  delete value.time;
  delete value.address_name;
  delete value.addressName;
  delete value.salutation;
  delete value.userName;
  if (fact.time && !fact.occurredAt) value.legacyTime = fact.time;
  value.occurredAt = fact.occurredAt || null;
  value.occurredEndAt = fact.occurredEndAt || null;
  value.observedAt = fact.observedAt || null;
  if (userId) value.userId = userId;
  else delete value.userId;
  if (userIds.length) value.userIds = userIds;
  else delete value.userIds;
  if (fact.addressNames.length) value.addressNames = fact.addressNames;
  else delete value.addressNames;
  if (fact.sourceWorkingMemoryIds.length) value.sourceWorkingMemoryIds = fact.sourceWorkingMemoryIds;
  else delete value.sourceWorkingMemoryIds;
  if (fact.sourceCandidateIds.length) value.sourceCandidateIds = fact.sourceCandidateIds;
  else delete value.sourceCandidateIds;
  if (fact.eventType) value.eventType = fact.eventType;
  else delete value.eventType;
  if (fact.subjectKey) value.subjectKey = fact.subjectKey;
  else delete value.subjectKey;
  if (eventKey) value.eventKey = eventKey;
  else delete value.eventKey;
  if (causalChainKey) value.causalChainKey = causalChainKey;
  else delete value.causalChainKey;
  value.eventFingerprint = eventFingerprint;
  if (fact.longTermId) value.longTermId = fact.longTermId;
  else delete value.longTermId;
  if (fact.batchId) value.batchId = fact.batchId;
  else delete value.batchId;
  if (fact.promoteToLongTerm) value.promoteToLongTerm = true;
  else delete value.promoteToLongTerm;
  return value;
}
