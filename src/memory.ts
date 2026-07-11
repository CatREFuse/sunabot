import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import { AppConfig } from "./types.js";
import { resolveProjectPath } from "./config.js";
import { AdminMutationMutex } from "./admin/mutation.js";
import { AdminApiError, badRequest } from "./admin/errors.js";
import { applicationDataStore, type MemoryDataSource } from "./dataStore.js";

export const MEMORY_RECALL_TOOL_NAME = "memory_recall";
const memoryMutationMutex = new AdminMutationMutex();

export type MemorySourceId = "working" | "long_term" | "user_profile";

export interface MemorySource {
  id: MemorySourceId;
  title: string;
  fileName: string;
  editable: boolean;
}

export interface MemoryEntry {
  id: string;
  source: MemorySourceId;
  sourceTitle: string;
  fileName: string;
  editable: boolean;
  key: string;
  value: string;
  text: string;
  field: string;
  time?: string;
  occurredAt?: string;
  occurredEndAt?: string;
  observedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  legacyTime?: string;
  legacyCreatedAt?: string;
  userId?: string;
  userIds?: string[];
  userName?: string;
  addressName?: string;
  userNickname?: string;
  groupCards?: Array<{ groupId: number; card: string; lastSeenAt: string }>;
  sourceWorkingMemoryIds?: string[];
  sourceCandidateIds?: string[];
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  eventFingerprint?: string;
  longTermId?: string;
  batchId?: string;
  promoteToLongTerm?: boolean;
  score?: number;
}

export interface MemoryFactInput {
  id?: string;
  fact: string;
  time?: string;
  occurredAt?: string;
  occurredEndAt?: string | null;
  observedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  userId?: string;
  userIds?: string[];
  userName?: string;
  addressName?: string;
  address_name?: string;
  salutation?: string;
  sourceWorkingMemoryIds?: string[];
  sourceCandidateIds?: string[];
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  eventFingerprint?: string;
  longTermId?: string;
  batchId?: string;
  promoteToLongTerm?: boolean;
}

export interface WorkingMemorySnapshot {
  token: string;
  entries: MemoryEntry[];
}

export type ReplaceWorkingMemoryFactsResult =
  | { status: "applied"; entries: MemoryEntry[] }
  | { status: "snapshot_conflict" }
  | { status: "empty_not_authorized" };

export interface MemoryBatchTransactionInput {
  batchId: string;
  expectedWorkingSnapshotToken: string;
  workingFacts: MemoryFactInput[];
  allPreviousMemoriesInvalidated?: boolean;
  userProfileFacts: MemoryFactInput[];
  longTermFacts: MemoryFactInput[];
  metadata?: Record<string, unknown>;
}

export type ApplyMemoryBatchTransactionResult =
  | {
    status: "applied";
    transactionId: string;
    workingEntries: MemoryEntry[];
    userProfileEntries: MemoryEntry[];
    longTermEntries: MemoryEntry[];
  }
  | { status: "snapshot_conflict" | "empty_not_authorized" };

export interface MemoryRecallInput {
  query?: unknown;
  source?: unknown;
  limit?: unknown;
}

export interface MemoryWriteInput {
  source?: unknown;
  id?: unknown;
  text?: unknown;
  userId?: unknown;
  userName?: unknown;
  addressName?: unknown;
}

interface SourceDefinition extends MemorySource {
  legacyFileName: string;
  field: string;
  fields: string[];
  idPrefix: string;
}

interface MemoryRecord {
  index: number;
  value: Record<string, unknown>;
}

interface MemoryStorageBinding {
  store: ReturnType<typeof applicationDataStore>;
  source: MemoryDataSource;
}

const memoryStorageBindings = new Map<string, MemoryStorageBinding>();

interface NormalizedMemoryFact {
  id: string;
  fact: string;
  time: string;
  createdAt: string;
  source: string;
  userId: string;
  userIds: string[];
  userName: string;
  addressName: string;
  occurredAt: string;
  occurredEndAt: string;
  observedAt: string;
  updatedAt: string;
  sourceWorkingMemoryIds: string[];
  sourceCandidateIds: string[];
  eventType: string;
  subjectKey: string;
  eventKey: string;
  eventFingerprint: string;
  longTermId: string;
  batchId: string;
  promoteToLongTerm: boolean;
}

interface UserProfileAggregate {
  id: string;
  userId: string;
  userName: string;
  addressName: string;
  facts: string[];
  factKeys: Set<string>;
  createdAt: string;
  updatedAt: string;
  time: string;
  source: string;
}

interface UserProfileFactGroup {
  userId: string;
  userName: string;
  addressName: string;
  facts: string[];
  createdAt: string;
  updatedAt: string;
  time: string;
  source: string;
}

const sourceDefinitions: SourceDefinition[] = [
  {
    id: "working",
    title: "工作记忆",
    fileName: "sunabot.sqlite#memory/working",
    legacyFileName: "WORKING_MEMORY.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "text", "content", "summary", "memory"],
    idPrefix: "mem"
  },
  {
    id: "long_term",
    title: "长期记忆",
    fileName: "sunabot.sqlite#memory/long-term",
    legacyFileName: "LONG_TERM_MEMORY.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "text", "content", "summary", "memory"],
    idPrefix: "longmem"
  },
  {
    id: "user_profile",
    title: "用户画像",
    fileName: "sunabot.sqlite#memory/user-profile",
    legacyFileName: "USER_PROFILE.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "value", "text", "content", "summary", "memory"],
    idPrefix: "profile"
  },
];

export const memoryRecallTool = {
  type: "function",
  name: MEMORY_RECALL_TOOL_NAME,
  description: "Recall relevant persona memory using BM25 search over the agent memory files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The memory search query."
      },
      source: {
        type: ["string", "null"],
        enum: ["all", "working", "long_term", "user_profile", null],
        description: "Memory source to search. Use null or all for every source."
      },
      limit: {
        type: ["integer", "null"],
        description: "Maximum result count from 1 to 20. Use null for the default."
      }
    },
    required: ["query", "source", "limit"]
  },
  strict: true
};

export async function listMemoryEntries(config: AppConfig, sourceInput?: unknown) {
  const sources = selectSources(sourceInput);
  const entries = (await Promise.all(sources.map((source) => readSourceEntries(config, source)))).flat();
  return {
    sources: sourceDefinitions.map(toPublicSource),
    entries: entries.sort((left, right) => compareMemoryEntries(left, right))
  };
}

export async function recallMemory(config: AppConfig, input: MemoryRecallInput = {}) {
  const query = normalizeText(input.query);
  const limit = normalizeLimit(input.limit, 8);
  if (!query) {
    return {
      ok: false,
      query,
      matches: [],
      error: "Memory query is empty."
    };
  }

  const sources = selectSources(input.source);
  const corpus = (await Promise.all(sources.map((source) => readSourceEntries(config, source)))).flat();
  const matches = bm25Search(query, corpus, limit);
  return {
    ok: true,
    query,
    matches
  };
}

export async function createMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const text = normalizeText(input.text);
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const now = new Date().toISOString();
    const value: Record<string, unknown> = {
      id: `${source.id}_${nanoid()}`,
      [source.field]: text,
      createdAt: now,
      source: "sunabot.memory.ui"
    };
    if (source.id === "user_profile") {
      const userId = normalizeUserId(input.userId);
      const userName = normalizeText(input.userName);
      const addressName = configuredAddressName(config, userId, normalizeAddressName(input.addressName));
      if (userId) {
        value.userId = userId;
        value.userIds = [userId];
        value.id = `user_profile_${userId}`;
      }
      if (userName) value.userName = userName;
      value.addressName = addressName;
      value.value = text;
    }

    const record = { index: records.length, value };
    records.push(record);
    if (source.id === "user_profile" && normalizeUserId(value.userId)) {
      const mergedRecords = mergeUserProfileRecords(config, source, records, []);
      await writeMemoryRecords(filePath, mergedRecords);
      const userId = normalizeUserId(value.userId);
      const merged = mergedRecords.find((item) => profileRecordUserIds(item.value).includes(userId));
      if (merged) return toMemoryEntry(source, merged);
    }
    await writeMemoryRecords(filePath, records);
    return toMemoryEntry(source, record);
  });
}

export async function updateMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  const text = normalizeText(input.text);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const record = records.find((item) => String(item.value.id ?? "") === id);
    if (!record) throw new AdminApiError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");

    const nextText = source.id === "user_profile"
      ? stripUserProfileFactPrefix(text, optionalString(record.value.userId), optionalString(record.value.userName))
      : text;
    record.value[source.field] = nextText;
    record.value.updatedAt = new Date().toISOString();
    if (source.id === "user_profile") {
      record.value.value = nextText;
      record.value.key = formatUserProfileKey(optionalString(record.value.userId), optionalString(record.value.userName), id);
      const userId = normalizeUserId(record.value.userId);
      if (Object.hasOwn(input, "addressName")) {
        const addressName = configuredAddressName(config, userId, normalizeAddressName(input.addressName));
        record.value.addressName = addressName;
      } else {
        const addressName = configuredAddressName(config, userId, readAddressName(record.value));
        record.value.addressName = addressName;
      }
    }

    await writeMemoryRecords(filePath, records);
    return toMemoryEntry(source, record);
  });
}

export async function deleteMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = records.filter((item) => String(item.value.id ?? "") !== id);
    if (nextRecords.length === records.length) throw new AdminApiError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");

    await writeMemoryRecords(filePath, nextRecords.map((record, index) => ({ ...record, index })));
    return { ok: true };
  });
}

export async function readMemorySourceEntries(config: AppConfig, sourceInput: MemorySourceId) {
  return readSourceEntries(config, sourceById(sourceInput));
}

export async function appendMemoryFacts(
  config: AppConfig,
  sourceInput: MemorySourceId,
  facts: MemoryFactInput[],
  metadata: Record<string, unknown> = {}
) {
  const source = sourceById(sourceInput);
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");

  const normalizedFacts = normalizeMemoryFactInputs(facts);
  if (!normalizedFacts.length) return [];

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    if (source.id === "user_profile") {
      return appendUserProfileFacts(config, source, normalizedFacts, metadata);
    }

    const records = await readMemoryRecords(filePath);
    const now = new Date().toISOString();
    const nextRecords = normalizedFacts.map((item, offset) => {
      const value = buildEventMemoryValue(source, item, metadata, now, `${source.id}_${nanoid()}`);
      return {
        index: records.length + offset,
        value
      };
    });

    records.push(...nextRecords);
    await writeMemoryRecords(filePath, records);
    return nextRecords.map((record) => toMemoryEntry(source, record));
  });
}

export async function readWorkingMemorySnapshot(config: AppConfig): Promise<WorkingMemorySnapshot> {
  const source = sourceById("working");
  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    return {
      token: memorySnapshotToken(records),
      entries: records.map((record) => toMemoryEntry(source, record)).filter((entry) => entry.text.trim())
    };
  });
}

export async function replaceWorkingMemoryFacts(
  config: AppConfig,
  facts: MemoryFactInput[],
  options: {
    expectedSnapshotToken: string;
    allPreviousMemoriesInvalidated?: boolean;
    metadata?: Record<string, unknown>;
  }
): Promise<ReplaceWorkingMemoryFactsResult> {
  const source = sourceById("working");
  const filePath = memorySourcePath(config, source);
  const normalizedFacts = normalizeMemoryFactInputs(facts);

  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    if (memorySnapshotToken(records) !== options.expectedSnapshotToken) {
      return { status: "snapshot_conflict" };
    }
    if (records.length && !normalizedFacts.length && options.allPreviousMemoriesInvalidated !== true) {
      return { status: "empty_not_authorized" };
    }

    const nextRecords = buildWorkingMemoryRecords(
      source,
      records,
      normalizedFacts,
      options.metadata ?? {},
      new Date().toISOString()
    );

    await writeMemoryRecords(filePath, nextRecords);
    return {
      status: "applied",
      entries: nextRecords.map((record) => toMemoryEntry(source, record))
    };
  });
}

function buildWorkingMemoryRecords(
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

function mergeNormalizedEventFact(fact: NormalizedMemoryFact, previous: Record<string, unknown>) {
  return {
    ...fact,
    userId: fact.userId || normalizeUserId(previous.userId),
    userIds: fact.userIds.length ? fact.userIds : normalizeUserIds(previous.userIds),
    userName: fact.userName || normalizeText(previous.userName),
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
    eventFingerprint: fact.eventFingerprint || normalizeText(previous.eventFingerprint),
    longTermId: fact.longTermId || normalizeText(previous.longTermId),
    batchId: fact.batchId || normalizeText(previous.batchId),
    promoteToLongTerm: fact.promoteToLongTerm || previous.promoteToLongTerm === true
  };
}

export async function mergeUserProfileMemory(config: AppConfig) {
  const source = sourceById("user_profile");
  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = mergeUserProfileRecords(config, source, records, []);
    if (memoryRecordsEqual(records, nextRecords)) {
      return nextRecords.map((record) => toMemoryEntry(source, record));
    }
    await writeMemoryRecords(filePath, nextRecords);
    return nextRecords.map((record) => toMemoryEntry(source, record));
  });
}

export async function normalizeEventMemorySchema(config: AppConfig) {
  return memoryMutationMutex.runExclusive(async () => {
    let updated = 0;
    for (const sourceId of ["working", "long_term"] as const) {
      const source = sourceById(sourceId);
      const filePath = memorySourcePath(config, source);
      const records = await readMemoryRecords(filePath);
      const nextRecords = records.map((record) => {
        const previous = record.value;
        const value = { ...previous };
        const range = parseEventTime(previous.occurredAt ?? previous.time, previous.occurredEndAt);
        const legacyTime = normalizeText(previous.time);
        value.schemaVersion = 2;
        value.occurredAt = range.occurredAt || null;
        value.occurredEndAt = range.occurredEndAt || null;
        value.observedAt = normalizeIsoTimestamp(previous.observedAt) || null;
        if (legacyTime && !range.occurredAt) value.legacyTime = legacyTime;
        delete value.time;
        if (!memoryRecordsEqual([record], [{ ...record, value }])) updated += 1;
        return { ...record, value };
      });
      if (!memoryRecordsEqual(records, nextRecords)) await writeMemoryRecords(filePath, nextRecords);
    }
    return { updated };
  });
}

export async function readUserProfileForUser(config: AppConfig, userIdInput: unknown) {
  const userId = normalizeUserId(userIdInput);
  if (!userId) return undefined;
  const entries = await readMemorySourceEntries(config, "user_profile");
  return entries.find((entry) => entry.userId === userId || entry.userIds?.includes(userId));
}

export function resolveUserAddressName(
  config: AppConfig,
  userIdInput: unknown,
  profile?: Pick<MemoryEntry, "addressName" | "userName">,
  runtimeName?: unknown
) {
  const userId = normalizeUserId(userIdInput);
  return configuredAddressName(
    config,
    userId,
    normalizeAddressName(profile?.addressName) || normalizeText(profile?.userName) || normalizeText(runtimeName) || userId
  );
}

export async function upsertLongTermMemoryFacts(
  config: AppConfig,
  facts: MemoryFactInput[],
  metadata: Record<string, unknown> = {}
) {
  const source = sourceById("long_term");
  const filePath = memorySourcePath(config, source);
  const normalizedFacts = normalizeMemoryFactInputs(facts);
  if (!normalizedFacts.length) return [];
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const { records: nextRecords, touchedIds } = buildLongTermMemoryRecords(
      source,
      records,
      normalizedFacts,
      metadata,
      new Date().toISOString()
    );
    await writeMemoryRecords(filePath, nextRecords);
    return nextRecords
      .filter((record) => touchedIds.has(normalizeText(record.value.id)))
      .map((record) => toMemoryEntry(source, record));
  });
}

export async function applyMemoryBatchTransaction(
  config: AppConfig,
  input: MemoryBatchTransactionInput
): Promise<ApplyMemoryBatchTransactionResult> {
  const batchId = normalizeText(input.batchId);
  if (!batchId) badRequest("MEMORY_INVALID", "记忆批次 ID 为空。", "batchId");
  return memoryMutationMutex.runExclusive(async () => {
    const store = memoryStore(config, sourceById("working"));
    const existing = store.readMemoryBatch(batchId);
    if (existing !== undefined) return existing as ApplyMemoryBatchTransactionResult;

    const workingSource = sourceById("working");
    const longTermSource = sourceById("long_term");
    const profileSource = sourceById("user_profile");
    const workingRecords = await readMemoryRecords(memorySourcePath(config, workingSource));
    const longTermRecords = await readMemoryRecords(memorySourcePath(config, longTermSource));
    const profileRecords = await readMemoryRecords(memorySourcePath(config, profileSource));
    if (memorySnapshotToken(workingRecords) !== input.expectedWorkingSnapshotToken) {
      return { status: "snapshot_conflict" };
    }
    const workingFacts = normalizeMemoryFactInputs(input.workingFacts);
    if (workingRecords.length && !workingFacts.length && input.allPreviousMemoriesInvalidated !== true) {
      return { status: "empty_not_authorized" };
    }

    const now = new Date().toISOString();
    const metadata = { ...(input.metadata ?? {}), batchId };
    const existingWorkingIds = new Set(workingRecords.map((record) => normalizeText(record.value.id)).filter(Boolean));
    const usedExistingWorkingIds = new Set<string>();
    const preparedWorkingFacts = workingFacts.map((fact, index) => {
      const requestedId = fact.id;
      const reusableId = requestedId && existingWorkingIds.has(requestedId) && !usedExistingWorkingIds.has(requestedId)
        ? requestedId
        : "";
      if (reusableId) usedExistingWorkingIds.add(reusableId);
      return { ...fact, id: reusableId || allocateTransactionWorkingId(batchId, fact, index) };
    });
    const preparedLongTermFacts = attachWorkingSourcesToLongTermFacts(
      normalizeMemoryFactInputs(input.longTermFacts),
      preparedWorkingFacts
    );
    const longTermBuild = buildLongTermMemoryRecords(
      longTermSource,
      longTermRecords,
      preparedLongTermFacts,
      metadata,
      now
    );
    const resolvedWorkingFacts = attachLongTermMappingsToWorkingFacts(preparedWorkingFacts, longTermBuild.records);
    const nextWorkingRecords = buildWorkingMemoryRecords(
      workingSource,
      workingRecords,
      resolvedWorkingFacts,
      metadata,
      now,
      (fact) => fact.id
    );
    const nextProfileRecords = mergeUserProfileRecords(
      config,
      profileSource,
      profileRecords,
      normalizeMemoryFactInputs(input.userProfileFacts),
      metadata
    );
    const transactionId = memoryTransactionId(batchId);
    const result: ApplyMemoryBatchTransactionResult = {
      status: "applied",
      transactionId,
      workingEntries: nextWorkingRecords.map((record) => toMemoryEntry(workingSource, record)),
      userProfileEntries: nextProfileRecords.map((record) => toMemoryEntry(profileSource, record)),
      longTermEntries: longTermBuild.records
        .filter((record) => longTermBuild.touchedIds.has(normalizeText(record.value.id)))
        .map((record) => toMemoryEntry(longTermSource, record))
    };
    const committed = store.commitMemoryBatch({
      batchId,
      baselineWorking: workingRecords.map((record) => record.value),
      working: nextWorkingRecords.map((record) => record.value),
      longTerm: longTermBuild.records.map((record) => record.value),
      userProfile: nextProfileRecords.map((record) => record.value),
      result
    });
    if (committed.status === "snapshot_conflict") return { status: "snapshot_conflict" };
    return committed.result as ApplyMemoryBatchTransactionResult;
  });
}

export async function recoverMemoryTransactions(config: AppConfig) {
  memoryStore(config, sourceById("working"));
  memoryStore(config, sourceById("long_term"));
  memoryStore(config, sourceById("user_profile"));
  return { recovered: 0 };
}

export async function isMemoryBatchCommitted(config: AppConfig, batchIdInput: unknown) {
  const batchId = normalizeText(batchIdInput);
  return Boolean(batchId && memoryStore(config, sourceById("working")).hasMemoryBatch(batchId));
}

function memoryTransactionId(batchId: string) {
  return `memory_txn_${sha256(batchId).slice(0, 32)}`;
}

function allocateTransactionWorkingId(batchId: string, fact: NormalizedMemoryFact, index: number) {
  return `working_${sha256(JSON.stringify({
    batchId,
    index,
    fingerprint: computeMemoryEventFingerprint({
      fact: fact.fact,
      userIds: fact.userIds,
      occurredAt: fact.occurredAt,
      occurredEndAt: fact.occurredEndAt
    })
  })).slice(0, 32)}`;
}

function attachWorkingSourcesToLongTermFacts(
  longTermFacts: NormalizedMemoryFact[],
  workingFacts: NormalizedMemoryFact[]
) {
  const promotedWorkingFacts = workingFacts.filter((fact) => fact.promoteToLongTerm);
  return longTermFacts.map((longTermFact) => {
    if (longTermFact.sourceWorkingMemoryIds.length) return longTermFact;
    const preparedLongTerm = prepareLongTermFact(longTermFact);
    const matchingWorking = promotedWorkingFacts.filter((workingFact) => {
      const preparedWorking = prepareLongTermFact(workingFact);
      if (preparedLongTerm.eventKey && preparedWorking.eventKey === preparedLongTerm.eventKey) return true;
      return preparedWorking.eventFingerprint === preparedLongTerm.eventFingerprint;
    });
    return matchingWorking.length === 1
      ? { ...longTermFact, sourceWorkingMemoryIds: [matchingWorking[0]!.id] }
      : longTermFact;
  });
}

function attachLongTermMappingsToWorkingFacts(
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
      eventKey: normalizeText(mapped.value.eventKey) || preparedWorking.eventKey
    };
  });
}

function buildLongTermMemoryRecords(
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

function prepareLongTermFact(fact: NormalizedMemoryFact) {
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

function participantsCompatible(record: Record<string, unknown>, fact: NormalizedMemoryFact) {
  const left = normalizeUserIds(record.userIds ?? record.userId).sort();
  const right = uniqueStrings([...(fact.userIds ?? []), ...(fact.userId ? [fact.userId] : [])]).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function eventTimesOverlap(record: Record<string, unknown>, fact: NormalizedMemoryFact) {
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

function compareLongTermRecordAge(left: MemoryRecord, right: MemoryRecord) {
  const leftCreatedAt = Date.parse(normalizeText(left.value.createdAt));
  const rightCreatedAt = Date.parse(normalizeText(right.value.createdAt));
  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }
  return normalizeText(left.value.id).localeCompare(normalizeText(right.value.id));
}

function allocateLongTermId(
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

function earliestValidIso(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function mergeEventEnd(previous: unknown, next: string) {
  const left = normalizeIsoTimestamp(previous);
  if (!left) return next;
  if (!next) return left;
  return Date.parse(left) >= Date.parse(next) ? left : next;
}

export async function clearMemorySource(config: AppConfig, sourceInput: MemorySourceId) {
  const source = sourceById(sourceInput);
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");
  await memoryMutationMutex.runExclusive(() => writeMemoryRecords(memorySourcePath(config, source), []));
}

export async function readAgentTextFile(config: AppConfig, fileName: string, fallback = "") {
  const filePath = resolveAgentFilePath(config, fileName);
  const content = await readOptional(filePath);
  return content.trim() || fallback;
}

export async function ensureAgentTextFile(config: AppConfig, fileName: string, content: string) {
  const filePath = resolveAgentFilePath(config, fileName);
  const current = await readOptional(filePath);
  if (current.trim()) return filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${content.trim()}\n`, "utf8");
  return filePath;
}

export function formatMemoryMatchesForPrompt(matches: MemoryEntry[]) {
  return matches
    .map((item) => {
      const date = item.occurredAt || item.updatedAt || item.createdAt || item.time || "";
      const suffix = date ? ` ${date}` : "";
      const address = item.source === "user_profile" && item.addressName ? ` 称呼：${item.addressName}` : "";
      return `${item.sourceTitle}${suffix}${address}：${item.text}`;
    })
    .join("\n");
}

function toPublicSource(source: SourceDefinition): MemorySource {
  return {
    id: source.id,
    title: source.title,
    fileName: source.fileName,
    editable: source.editable
  };
}

async function readSourceEntries(config: AppConfig, source: SourceDefinition) {
  const filePath = memorySourcePath(config, source);
  const records = await readMemoryRecords(filePath);
  return records.map((record) => toMemoryEntry(source, record)).filter((entry) => entry.text.trim());
}

async function appendUserProfileFacts(
  config: AppConfig,
  source: SourceDefinition,
  facts: NormalizedMemoryFact[],
  metadata: Record<string, unknown>
) {
  const filePath = memorySourcePath(config, source);
  const records = await readMemoryRecords(filePath);
  const nextRecords = mergeUserProfileRecords(config, source, records, facts, metadata);
  await writeMemoryRecords(filePath, nextRecords);
  return nextRecords.map((record) => toMemoryEntry(source, record));
}

function mergeUserProfileRecords(
  config: AppConfig,
  source: SourceDefinition,
  records: MemoryRecord[],
  facts: NormalizedMemoryFact[],
  metadata: Record<string, unknown> = {}
) {
  const profiles = new Map<string, UserProfileAggregate>();
  const looseRecords: MemoryRecord[] = [];
  const replaceFacts = metadata.replaceUserProfileFacts === true;

  for (const record of records) {
    const userIds = profileRecordUserIds(record.value);
    if (!userIds.length) {
      looseRecords.push(record);
      continue;
    }
    for (const userId of userIds) {
      const recordTime = optionalString(record.value.time) ?? optionalString(record.value.createdAt) ?? "";
      const text = stripUserProfileFactPrefix(readMemoryText(source, record.value), userId, optionalString(record.value.userName));
      const profile = ensureUserProfileAggregate(profiles, userId, {
        id: userIds.length === 1 ? normalizeText(record.value.id) || `${source.id}_${userId}` : `${source.id}_${userId}`,
        userName: optionalString(record.value.userName) ?? "",
        addressName: configuredAddressName(config, userId, readAddressName(record.value)),
        createdAt: optionalString(record.value.createdAt) ?? recordTime,
        updatedAt: optionalString(record.value.updatedAt) ?? recordTime,
        time: recordTime,
        source: optionalString(record.value.source) ?? ""
      });
      addUserProfileFacts(profile, splitProfileFactText(text));
    }
  }

  const now = new Date().toISOString();
  const incomingGroups = groupUserProfileFacts(source, facts, metadata, now, looseRecords);
  for (const group of incomingGroups.values()) {
    const profile = ensureUserProfileAggregate(profiles, group.userId, {
      id: `${source.id}_${group.userId}`,
      userName: group.userName,
      addressName: configuredAddressName(config, group.userId, group.addressName),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      time: group.time,
      source: group.source
    });
    if (group.userName) profile.userName = group.userName;
    if (!profile.addressName && group.addressName) profile.addressName = group.addressName;
    profile.updatedAt = latestIsoLike(profile.updatedAt, group.updatedAt);
    profile.time = latestIsoLike(profile.time, group.time);
    profile.source = group.source || profile.source || "sunabot.memory.user_profile";
    if (replaceFacts) replaceUserProfileFacts(profile, group.facts);
    else addUserProfileFacts(profile, group.facts);
  }

  const profileRecords = [...profiles.values()]
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .map((profile) => ({
      index: 0,
      value: userProfileAggregateValue(config, source, profile)
    }));
  return [...looseRecords, ...profileRecords].map((record, index) => ({
    index,
    value: record.value
  }));
}

function groupUserProfileFacts(
  source: SourceDefinition,
  facts: NormalizedMemoryFact[],
  metadata: Record<string, unknown>,
  now: string,
  looseRecords: MemoryRecord[]
) {
  const groups = new Map<string, UserProfileFactGroup>();
  const fallbackSource = normalizeText(metadata.source) || "sunabot.memory.user_profile";

  for (const fact of facts) {
    const userIds = fact.userIds.length ? fact.userIds : fact.userId ? [fact.userId] : [];
    if (!userIds.length) {
      looseRecords.push(toLooseUserProfileRecord(source, looseRecords.length, fact, metadata, now));
      continue;
    }

    for (const userId of userIds) {
      const time = fact.time || fact.createdAt || now;
      const group = groups.get(userId) ?? {
        userId,
        userName: "",
        addressName: "",
        facts: [],
        createdAt: time,
        updatedAt: now,
        time,
        source: fact.source || fallbackSource
      };
      if (fact.userName) group.userName = fact.userName;
      if (!group.addressName && fact.addressName) group.addressName = fact.addressName;
      group.createdAt = earliestIsoLike(group.createdAt, fact.createdAt || time);
      group.updatedAt = latestIsoLike(group.updatedAt, now);
      group.time = latestIsoLike(group.time, time);
      group.source = fact.source || group.source || fallbackSource;
      group.facts.push(...splitProfileFactText(stripUserProfileFactPrefix(fact.fact, userId, fact.userName)));
      groups.set(userId, group);
    }
  }
  return groups;
}

function profileRecordUserIds(value: Record<string, unknown>) {
  return uniqueStrings([
    normalizeUserId(value.userId),
    ...normalizeUserIds(value.userIds)
  ].filter(Boolean));
}

function ensureUserProfileAggregate(
  profiles: Map<string, UserProfileAggregate>,
  userId: string,
  seed: Omit<UserProfileAggregate, "userId" | "facts" | "factKeys">
) {
  const existing = profiles.get(userId);
  if (existing) {
    if (seed.userName) existing.userName = seed.userName;
    if (!existing.addressName && seed.addressName) existing.addressName = seed.addressName;
    existing.createdAt = earliestIsoLike(existing.createdAt, seed.createdAt);
    existing.updatedAt = latestIsoLike(existing.updatedAt, seed.updatedAt);
    existing.time = latestIsoLike(existing.time, seed.time);
    if (seed.source) existing.source = seed.source;
    return existing;
  }

  const profile: UserProfileAggregate = {
    ...seed,
    id: seed.id || `user_profile_${userId}`,
    userId,
    facts: [],
    factKeys: new Set()
  };
  profiles.set(userId, profile);
  return profile;
}

function replaceUserProfileFacts(profile: UserProfileAggregate, facts: string[]) {
  profile.facts = [];
  profile.factKeys = new Set();
  addUserProfileFacts(profile, facts);
}

function addUserProfileFacts(profile: UserProfileAggregate, facts: string[]) {
  for (const fact of facts) {
    const text = normalizeText(fact);
    if (!text) continue;
    const key = normalizeProfileFactKey(text);
    if (profile.factKeys.has(key)) continue;
    profile.factKeys.add(key);
    profile.facts.push(text);
  }
}

function splitProfileFactText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function normalizeProfileFactKey(text: string) {
  return normalizeText(text).replace(/\s+/g, " ").toLowerCase();
}

function stripUserProfileFactPrefix(text: string, userId?: string, userName?: string) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const idPattern = userId ? escapeRegExp(userId) : "\\d{5,}";
  const namePattern = userName ? `(?:[（(]${escapeRegExp(userName)}[）)])?` : "(?:[（(][^）)]*[）)])?";
  const exactPrefix = new RegExp(`^\\s*(?:QQ\\s*)?${idPattern}\\s*${namePattern}\\s*[:：]\\s*`);
  const genericPrefix = /^\s*QQ\s*\d{5,}\s*(?:[（(][^）)]*[）)])?\s*[:：]\s*/;
  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(exactPrefix, "").replace(genericPrefix, "").trim())
    .filter(Boolean)
    .join("\n");
}

function formatUserProfileKey(userId?: string, userName?: string, fallback = "") {
  if (!userId) return fallback || "用户画像";
  return userName ? `QQ ${userId}（${userName}）` : `QQ ${userId}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function userProfileAggregateValue(config: AppConfig, source: SourceDefinition, profile: UserProfileAggregate) {
  const fact = profile.facts.join("\n");
  const key = formatUserProfileKey(profile.userId, profile.userName);
  const value: Record<string, unknown> = {
    id: profile.id,
    key,
    value: fact,
    [source.field]: fact,
    userId: profile.userId,
    userIds: [profile.userId],
    createdAt: profile.createdAt || profile.time || profile.updatedAt || new Date().toISOString(),
    source: profile.source || "sunabot.memory.user_profile"
  };
  if (profile.userName) value.userName = profile.userName;
  const addressName = configuredAddressName(config, profile.userId, profile.addressName);
  value.addressName = addressName;
  if (profile.time) value.time = profile.time;
  if (profile.updatedAt) value.updatedAt = profile.updatedAt;
  return value;
}

function toLooseUserProfileRecord(
  source: SourceDefinition,
  offset: number,
  fact: NormalizedMemoryFact,
  metadata: Record<string, unknown>,
  now: string
) {
  const time = fact.time || fact.createdAt || now;
  return {
    index: offset,
    value: {
      ...metadata,
      id: `${source.id}_${nanoid()}`,
      [source.field]: fact.fact,
      time,
      createdAt: fact.createdAt || time,
      source: fact.source || normalizeText(metadata.source) || "sunabot.memory.user_profile"
    }
  };
}

function buildEventMemoryValue(
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
  delete value.salutation;
  if (fact.time && !fact.occurredAt) value.legacyTime = fact.time;
  value.occurredAt = fact.occurredAt || null;
  value.occurredEndAt = fact.occurredEndAt || null;
  value.observedAt = fact.observedAt || null;
  if (userId) value.userId = userId;
  else delete value.userId;
  if (userIds.length) value.userIds = userIds;
  else delete value.userIds;
  if (fact.userName) value.userName = fact.userName;
  else delete value.userName;
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
  value.eventFingerprint = eventFingerprint;
  if (fact.longTermId) value.longTermId = fact.longTermId;
  else delete value.longTermId;
  if (fact.batchId) value.batchId = fact.batchId;
  else delete value.batchId;
  if (fact.promoteToLongTerm) value.promoteToLongTerm = true;
  else delete value.promoteToLongTerm;
  return value;
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

function parseEventTime(startInput: unknown, endInput?: unknown) {
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

function splitLegacyTimeRange(value: string): [string, string] | undefined {
  if (!value) return undefined;
  for (const separator of ["/", "~", "～"]) {
    const index = value.indexOf(separator);
    if (index > 0) return [value.slice(0, index), value.slice(index + separator.length)];
  }
  const zRange = value.match(/^(.+Z)-(\d{4}-\d{2}-\d{2}T.+Z)$/);
  return zRange ? [zRange[1]!, zRange[2]!] : undefined;
}

function normalizeIsoTimestamp(value: unknown) {
  const text = normalizeText(value);
  if (!text) return "";
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function normalizeEventType(value: unknown) {
  const type = normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return type.slice(0, 64);
}

function normalizeSubjectKey(value: unknown) {
  return normalizeText(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").slice(0, 512);
}

function normalizeFingerprintText(value: unknown) {
  return normalizeText(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function normalizeStringArray(value: unknown) {
  const values = Array.isArray(value) ? value : normalizeText(value).split(/[,，、\s]+/);
  return uniqueStrings(values.map(normalizeText).filter(Boolean));
}

function normalizeAddressName(value: unknown) {
  return normalizeText(value).slice(0, 120);
}

function readAddressName(value: Record<string, unknown>) {
  return normalizeAddressName(value.addressName ?? value.address_name ?? value.salutation);
}

function configuredAddressName(config: AppConfig, userId: string, requested: string) {
  const adminQq = normalizeUserId(config.bot.adminQq);
  if (userId && adminQq && userId === adminQq) {
    return normalizeAddressName(config.bot.adminName) || "猫老师";
  }
  return requested;
}

function isMemoryEventKey(value: string) {
  return /^v\d+:sha256:[a-f0-9]{64}$/.test(value);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function earliestIsoLike(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime <= rightTime ? left : right;
  return left;
}

function latestIsoLike(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime >= rightTime ? left : right;
  return right;
}

function memoryRecordsEqual(left: MemoryRecord[], right: MemoryRecord[]) {
  if (left.length !== right.length) return false;
  return left.every((record, index) => JSON.stringify(record.value) === JSON.stringify(right[index]?.value));
}

function normalizeMemoryFactInputs(facts: MemoryFactInput[]): NormalizedMemoryFact[] {
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

function memorySnapshotToken(records: MemoryRecord[]) {
  const content = records.map((record) => JSON.stringify(record.value)).join("\n");
  return createHash("sha256").update(content).digest("hex");
}

function memoryRecordChanged(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const previousComparable = { ...previous };
  const nextComparable = { ...next };
  delete previousComparable.updatedAt;
  delete nextComparable.updatedAt;
  return JSON.stringify(previousComparable) !== JSON.stringify(nextComparable);
}

function toMemoryEntry(source: SourceDefinition, record: MemoryRecord): MemoryEntry {
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

function readMemoryText(source: SourceDefinition, value: Record<string, unknown>) {
  for (const field of source.fields) {
    const text = normalizeText(value[field]);
    if (text) return text;
  }
  return "";
}

async function readMemoryRecords(filePath: string): Promise<MemoryRecord[]> {
  const binding = memoryStorageBindings.get(filePath);
  if (!binding) throw new Error(`Memory storage is not registered: ${filePath}`);
  return binding.store.readMemory(binding.source).map((value, index) => ({ index, value }));
}

export async function readStrictJsonlFile(filePath: string) {
  const raw = await readOptional(filePath);
  return parseStrictJsonl(raw, filePath).map((record) => structuredClone(record.value));
}

function parseStrictJsonl(raw: string, filePath: string) {
  const records: MemoryRecord[] = [];
  const ids = new Set<string>();
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid JSONL object at ${filePath}:${index + 1}`);
    }
    const record = value as Record<string, unknown>;
    const id = normalizeText(record.id);
    if (id && ids.has(id)) throw new Error(`Duplicate JSONL id ${id} at ${filePath}:${index + 1}`);
    if (id) ids.add(id);
    records.push({ index, value: record });
  }
  return records;
}

async function writeMemoryRecords(filePath: string, records: MemoryRecord[]) {
  const binding = memoryStorageBindings.get(filePath);
  if (!binding) throw new Error(`Memory storage is not registered: ${filePath}`);
  binding.store.replaceMemory(binding.source, records.map((record) => record.value));
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function memorySourcePath(config: AppConfig, source: SourceDefinition) {
  const legacyPath = path.join(memoryWorkspacePath(config), source.legacyFileName);
  const store = applicationDataStore(config);
  store.ensureLegacyMemoryImported(source.id, legacyPath);
  memoryStorageBindings.set(legacyPath, { store, source: source.id });
  return legacyPath;
}

function memoryStore(config: AppConfig, source: SourceDefinition) {
  const storagePath = memorySourcePath(config, source);
  return memoryStorageBindings.get(storagePath)!.store;
}

function memoryWorkspacePath(config: AppConfig) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("Agent workspace is not configured.");
  return workspace;
}

function resolveAgentFilePath(config: AppConfig, fileName: string) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("Agent workspace is not configured.");
  const workspaceRoot = path.resolve(workspace);
  const resolved = path.resolve(workspaceRoot, normalizeText(fileName));
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Agent file must be inside the agent workspace.");
  }
  return resolved;
}

function selectSources(sourceInput: unknown) {
  const sourceText = normalizeText(sourceInput);
  const sourceId = normalizeSourceId(sourceInput);
  if (sourceText && sourceText !== "all" && !sourceId) {
    badRequest("MEMORY_SOURCE_INVALID", "记忆来源无效。", "source");
  }
  if (!sourceId) return sourceDefinitions;
  return [sourceById(sourceId)];
}

function editableSource(sourceInput: unknown) {
  const sourceText = normalizeText(sourceInput);
  const sourceId = normalizeSourceId(sourceInput);
  if (sourceText && (!sourceId || sourceText === "all")) {
    badRequest("MEMORY_SOURCE_INVALID", "记忆来源无效。", "source");
  }
  const source = sourceById(sourceId ?? "working");
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");
  return source;
}

function sourceById(sourceId: MemorySourceId) {
  const source = sourceDefinitions.find((item) => item.id === sourceId);
  if (!source) throw new Error("记忆来源无效。");
  return source;
}

function normalizeSourceId(value: unknown): MemorySourceId | undefined {
  const text = normalizeText(value);
  if (!text || text === "all") return undefined;
  return sourceDefinitions.some((source) => source.id === text) ? text as MemorySourceId : undefined;
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeUserId(value: unknown) {
  const text = normalizeText(value);
  if (!text) return "";
  const match = text.match(/\d{5,}/);
  return match?.[0] ?? text;
}

function normalizeUserIds(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : normalizeText(value)
      .split(/[,\s，、/]+/)
      .filter(Boolean);
  return [...new Set(values.map(normalizeUserId).filter(Boolean))];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function optionalString(value: unknown) {
  const text = normalizeText(value);
  return text || undefined;
}

function normalizeLimit(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 20);
}

function compareMemoryEntries(left: MemoryEntry, right: MemoryEntry) {
  const leftTime = Date.parse(left.occurredAt || left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.occurredAt || right.updatedAt || right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.source.localeCompare(right.source) || left.id.localeCompare(right.id);
}

function bm25Search(query: string, entries: MemoryEntry[], limit: number) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !entries.length) return [];

  const documents = entries.map((entry) => {
    const tokens = tokenize([
      entry.text,
      entry.userId,
      ...(entry.userIds ?? []),
      entry.userName,
      entry.addressName,
      entry.occurredAt,
      entry.occurredEndAt
    ].filter(Boolean).join(" "));
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { entry, tokens, frequencies };
  });

  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    documentFrequency.set(token, documents.filter((document) => document.frequencies.has(token)).length);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = documents.map((document) => {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = document.frequencies.get(token) ?? 0;
      if (!frequency) continue;

      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const lengthNorm = frequency + k1 * (1 - b + b * (document.tokens.length / averageLength));
      score += idf * ((frequency * (k1 + 1)) / lengthNorm);
    }
    return {
      ...document.entry,
      score: Number(score.toFixed(4))
    };
  });

  return scored
    .filter((entry) => (entry.score ?? 0) > 0)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || compareMemoryEntries(left, right))
    .slice(0, limit);
}

function tokenize(input: string) {
  const normalized = input.toLowerCase().normalize("NFKC");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]/g)) {
    tokens.push(match[0]);
  }

  const cjkChars = [...normalized].filter((char) => /[\u4e00-\u9fff]/.test(char));
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    tokens.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
  }

  return tokens.filter((token) => token.length > 0);
}
