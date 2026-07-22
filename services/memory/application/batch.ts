import type { AppConfig } from "../../../src/types.js";
import type {
  ApplyMemoryBatchTransactionResult,
  MemoryBatchTransactionInput,
  MemoryFactInput,
  NormalizedMemoryFact,
  ReplaceWorkingMemoryFactsResult,
  WorkingMemorySnapshot
} from "../types.js";
import {
  attachLongTermMappingsToWorkingFacts,
  attachWorkingSourcesToLongTermFacts,
  buildLongTermMemoryRecords,
  buildWorkingMemoryRecords
} from "../domain/eventMergePolicy.js";
import { toMemoryEntry } from "../domain/entryMapper.js";
import {
  computeMemoryEventFingerprint,
  memorySnapshotToken,
  normalizeMemoryFactInputs,
  normalizeText,
  sha256
} from "../domain/normalizers.js";
import { mergeUserProfileRecords } from "../domain/profileMergePolicy.js";
import { badRequest, sourceById } from "./sources.js";
import { memoryMutationMutex } from "./mutationMutex.js";
import { memorySourcePath, memoryStore, readMemoryRecords, writeMemoryRecords } from "./repositoryStorage.js";

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
    memorySourcePath(config, longTermSource);
    memorySourcePath(config, profileSource);
    const snapshot = store.readMemorySnapshot();
    const workingRecords = snapshot.records.working.map((value, index) => ({ index, value }));
    const longTermRecords = snapshot.records.long_term.map((value, index) => ({ index, value }));
    const profileRecords = snapshot.records.user_profile.map((value, index) => ({ index, value }));
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
      baselineRevisions: snapshot.revisions,
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

export function memoryTransactionId(batchId: string) {
  return `memory_txn_${sha256(batchId).slice(0, 32)}`;
}

export function allocateTransactionWorkingId(batchId: string, fact: NormalizedMemoryFact, index: number) {
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
