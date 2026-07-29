import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import type {
  ApplyMemoryBatchTransactionResult,
  MemoryBatchTransactionInput,
  MemoryFactInput,
  ReplaceWorkingMemoryFactsResult,
  WorkingMemorySnapshot
} from "../types.js";
import {
  buildLongTermMemoryRecords
} from "../domain/eventMergePolicy.js";
import { toMemoryEntry } from "../domain/entryMapper.js";
import {
  computeMemoryEventFingerprint,
  normalizeMemoryFactInputs,
  normalizeText,
  sha256
} from "../domain/normalizers.js";
import { mergeUserProfileRecords } from "../domain/profileMergePolicy.js";
import { badRequest, sourceById } from "./sources.js";
import { memoryMutationMutex } from "./mutationMutex.js";
import { memorySourcePath, memoryStore, readMemoryRecords, writeMemoryRecords } from "./repositoryStorage.js";
import {
  readWorkingMemoryDocument,
  replaceWorkingMemoryDocument,
  workingMemoryItemToEntry,
  workingMemoryItemsFromFactsPreservingDreams
} from "../workingMemoryDocument.js";
import { recordMemoryOperation } from "../operationAudit.js";

export async function readWorkingMemorySnapshot(config: AppConfig): Promise<WorkingMemorySnapshot> {
  return memoryMutationMutex.runExclusive(async () => {
    const snapshot = await readWorkingMemoryDocument(config);
    return {
      token: snapshot.revision,
      entries: snapshot.items.map(workingMemoryItemToEntry)
    };
  });
}

export async function replaceWorkingMemoryFacts(
  config: AppConfig,
  facts: MemoryFactInput[],
  options: {
    expectedSnapshotToken: string;
    metadata?: Record<string, unknown>;
  }
): Promise<ReplaceWorkingMemoryFactsResult> {
  const normalizedFacts = normalizeMemoryFactInputs(facts);

  return memoryMutationMutex.runExclusive(async () => {
    const snapshot = await readWorkingMemoryDocument(config);
    if (snapshot.revision !== options.expectedSnapshotToken) {
      recordMemoryOperation(config, {
        source: "working",
        operation: "replace",
        actor: "memory_pipeline",
        outcome: "conflict",
        beforeCount: snapshot.items.length,
        afterCount: snapshot.items.length,
        changedCount: 0,
        beforeRevision: snapshot.revision,
        batchId: normalizeText(options.metadata?.batchId),
        conversationId: normalizeText(options.metadata?.conversationId),
        conversationScope: normalizeText(options.metadata?.conversationScope),
        reasonCode: "snapshot_conflict"
      });
      return { status: "snapshot_conflict" };
    }
    const nextItems = workingMemoryItemsFromFactsPreservingDreams(
      normalizedFacts,
      snapshot.items,
      options.metadata ?? {},
      (fact, index) => allocateTransactionWorkingId(
        String(options.metadata?.batchId ?? options.metadata?.conversationId ?? "manual"),
        fact,
        index
      )
    );
    const replaced = await replaceWorkingMemoryDocument(config, snapshot.revision, nextItems);
    if (replaced.status === "conflict") {
      recordMemoryOperation(config, {
        source: "working",
        operation: "replace",
        actor: "memory_pipeline",
        outcome: "conflict",
        beforeCount: snapshot.items.length,
        afterCount: snapshot.items.length,
        changedCount: 0,
        beforeRevision: snapshot.revision,
        batchId: normalizeText(options.metadata?.batchId),
        conversationId: normalizeText(options.metadata?.conversationId),
        conversationScope: normalizeText(options.metadata?.conversationScope),
        reasonCode: "revision_conflict"
      });
      return { status: "snapshot_conflict" };
    }
    recordMemoryOperation(config, {
      source: "working",
      operation: "replace",
      actor: "memory_pipeline",
      outcome: replaced.status === "unchanged" ? "unchanged" : "applied",
      recordIds: replaced.current.items.map((item) => item.id),
      beforeCount: snapshot.items.length,
      afterCount: replaced.current.items.length,
      changedCount: replaced.status === "unchanged" ? 0 : replaced.current.items.length,
      beforeRevision: snapshot.revision,
      afterRevision: replaced.current.revision,
      batchId: normalizeText(options.metadata?.batchId),
      conversationId: normalizeText(options.metadata?.conversationId),
      conversationScope: normalizeText(options.metadata?.conversationScope)
    });
    return {
      status: "applied",
      entries: replaced.current.items.map(workingMemoryItemToEntry)
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
    const entries = nextRecords
      .filter((record) => touchedIds.has(normalizeText(record.value.id)))
      .map((record) => toMemoryEntry(source, record));
    recordMemoryOperation(config, {
      source: "long_term",
      operation: "upsert",
      actor: memoryBatchActor(metadata),
      outcome: entries.length ? "applied" : "unchanged",
      recordIds: entries.map((entry) => entry.id),
      batchId: normalizeText(metadata.batchId),
      conversationId: normalizeText(metadata.conversationId),
      conversationScope: normalizeText(metadata.conversationScope),
      beforeCount: records.length,
      afterCount: nextRecords.length,
      changedCount: entries.length
    });
    return entries;
  });
}

export async function applyMemoryBatchTransaction(
  config: AppConfig,
  input: MemoryBatchTransactionInput
): Promise<ApplyMemoryBatchTransactionResult> {
  const batchId = normalizeText(input.batchId);
  if (!batchId) badRequest("MEMORY_INVALID", "记忆批次 ID 为空。", "batchId");
  return memoryMutationMutex.runExclusive(async () => {
    const store = memoryStore(config, sourceById("user_profile"));
    const existing = store.readMemoryBatch(batchId);
    if (existing !== undefined) {
      recordBatchAudit(config, input, {
        working: "unchanged",
        userProfile: "unchanged",
        reasonCode: "batch_already_committed"
      });
      return existing as ApplyMemoryBatchTransactionResult;
    }

    const profileSource = sourceById("user_profile");
    memorySourcePath(config, profileSource);
    const snapshot = store.readMemorySnapshot();
    const profileRecords = snapshot.records.user_profile.map((value, index) => ({ index, value }));
    const workingSnapshot = await readWorkingMemoryDocument(config);
    if (workingSnapshot.revision !== input.expectedWorkingSnapshotToken) {
      recordBatchAudit(config, input, {
        working: "conflict",
        userProfile: "rejected",
        reasonCode: "working_snapshot_conflict",
        beforeWorkingCount: workingSnapshot.items.length
      });
      return { status: "snapshot_conflict" };
    }
    const workingFacts = normalizeMemoryFactInputs(input.workingFacts);
    if (normalizeMemoryFactInputs(input.longTermFacts).length) {
      badRequest(
        "MEMORY_WORKING_PROMOTION_DISABLED",
        "工作记忆暂不自动进入长期记忆。",
        "longTermFacts"
      );
    }

    const metadata = { ...(input.metadata ?? {}), batchId };
    const nextWorkingItems = workingMemoryItemsFromFactsPreservingDreams(
      workingFacts,
      workingSnapshot.items,
      metadata,
      (fact, index) => allocateTransactionWorkingId(batchId, fact, index)
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
      workingEntries: nextWorkingItems.map(workingMemoryItemToEntry),
      userProfileEntries: nextProfileRecords.map((record) => toMemoryEntry(profileSource, record)),
      longTermEntries: []
    };
    const workingCommitted = await replaceWorkingMemoryDocument(
      config,
      workingSnapshot.revision,
      nextWorkingItems
    );
    if (workingCommitted.status === "conflict") {
      recordBatchAudit(config, input, {
        working: "conflict",
        userProfile: "rejected",
        reasonCode: "working_revision_conflict",
        beforeWorkingCount: workingSnapshot.items.length
      });
      return { status: "snapshot_conflict" };
    }
    const committed = store.commitUserProfileBatch({
      batchId,
      expectedUserProfileRevision: snapshot.revisions.user_profile,
      userProfile: nextProfileRecords.map((record) => record.value),
      result
    });
    if (committed.status === "snapshot_conflict") {
      recordBatchAudit(config, input, {
        working: workingCommitted.status === "unchanged" ? "unchanged" : "applied",
        userProfile: "conflict",
        reasonCode: "user_profile_snapshot_conflict",
        beforeWorkingCount: workingSnapshot.items.length,
        afterWorkingCount: workingCommitted.current.items.length,
        beforeProfileCount: profileRecords.length
      });
      return { status: "snapshot_conflict" };
    }
    const committedSnapshot = store.readMemorySnapshot();
    recordBatchAudit(config, input, {
      working: workingCommitted.status === "unchanged" ? "unchanged" : "applied",
      userProfile: committed.status === "existing" ? "unchanged" : "applied",
      reasonCode: committed.status === "existing" ? "batch_already_committed" : undefined,
      beforeWorkingCount: workingSnapshot.items.length,
      afterWorkingCount: workingCommitted.current.items.length,
      beforeProfileCount: profileRecords.length,
      afterProfileCount: nextProfileRecords.length,
      workingRecordIds: workingCommitted.current.items.map((item) => item.id),
      profileRecordIds: nextProfileRecords.map((record) => normalizeText(record.value.id)),
      beforeWorkingRevision: workingSnapshot.revision,
      afterWorkingRevision: workingCommitted.current.revision,
      beforeProfileRevision: String(snapshot.revisions.user_profile),
      afterProfileRevision: String(committedSnapshot.revisions.user_profile)
    });
    return committed.result as ApplyMemoryBatchTransactionResult;
  });
}

export async function recoverMemoryTransactions(config: AppConfig) {
  memoryStore(config, sourceById("long_term"));
  memoryStore(config, sourceById("user_profile"));
  return { recovered: 0 };
}

export async function isMemoryBatchCommitted(config: AppConfig, batchIdInput: unknown) {
  const batchId = normalizeText(batchIdInput);
  return Boolean(batchId && memoryStore(config, sourceById("user_profile")).hasMemoryBatch(batchId));
}

export function memoryTransactionId(batchId: string) {
  return `memory_txn_${sha256(batchId).slice(0, 32)}`;
}

export function allocateTransactionWorkingId(
  batchId: string,
  fact: Pick<MemoryFactInput, "fact" | "userIds" | "occurredAt" | "occurredEndAt">,
  index: number
) {
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

function memoryBatchActor(metadata: Record<string, unknown>) {
  const source = normalizeText(metadata.source);
  return source.includes("dream")
    ? "dream" as const
    : source.includes("ui") || source.includes("admin")
      ? "admin" as const
      : "memory_pipeline" as const;
}

function recordBatchAudit(
  config: AppConfig,
  input: MemoryBatchTransactionInput,
  result: {
    working: "applied" | "unchanged" | "rejected" | "conflict";
    userProfile: "applied" | "unchanged" | "rejected" | "conflict";
    reasonCode?: string;
    beforeWorkingCount?: number;
    afterWorkingCount?: number;
    beforeProfileCount?: number;
    afterProfileCount?: number;
    workingRecordIds?: string[];
    profileRecordIds?: string[];
    beforeWorkingRevision?: string;
    afterWorkingRevision?: string;
    beforeProfileRevision?: string;
    afterProfileRevision?: string;
  }
) {
  const metadata = input.metadata ?? {};
  const common = {
    actor: "memory_pipeline" as const,
    batchId: normalizeText(input.batchId),
    conversationId: normalizeText(metadata.conversationId),
    conversationScope: normalizeText(metadata.conversationScope),
    reasonCode: result.reasonCode
  };
  recordMemoryOperation(config, {
    source: "working",
    operation: "batch_commit",
    outcome: result.working,
    ...common,
    recordIds: result.workingRecordIds,
    beforeCount: result.beforeWorkingCount,
    afterCount: result.afterWorkingCount,
    changedCount: result.working === "applied" ? result.afterWorkingCount : 0,
    beforeRevision: result.beforeWorkingRevision,
    afterRevision: result.afterWorkingRevision
  });
  recordMemoryOperation(config, {
    source: "user_profile",
    operation: "batch_commit",
    outcome: result.userProfile,
    ...common,
    recordIds: result.profileRecordIds,
    beforeCount: result.beforeProfileCount,
    afterCount: result.afterProfileCount,
    changedCount: result.userProfile === "applied" ? result.afterProfileCount : 0,
    beforeRevision: result.beforeProfileRevision,
    afterRevision: result.afterProfileRevision
  });
}
