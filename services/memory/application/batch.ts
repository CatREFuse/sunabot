import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import type { MemoryFactInput } from "../types.js";
import {
  buildLongTermMemoryRecords
} from "../domain/eventMergePolicy.js";
import { toMemoryEntry } from "../domain/entryMapper.js";
import {
  normalizeMemoryFactInputs,
  normalizeText
} from "../domain/normalizers.js";
import { sourceById } from "./sources.js";
import { memoryMutationMutex } from "./mutationMutex.js";
import { memorySourcePath, readMemoryRecords, writeMemoryRecords } from "./repositoryStorage.js";
import { recordMemoryOperation } from "../operationAudit.js";

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

function memoryBatchActor(metadata: Record<string, unknown>) {
  const source = normalizeText(metadata.source);
  return source.includes("dream")
    ? "dream" as const
    : source.includes("ui") || source.includes("admin")
      ? "admin" as const
      : "admin" as const;
}
