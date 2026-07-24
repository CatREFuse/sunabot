import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import type { MemorySourceId, SourceDefinition } from "../types.js";
import { compareMemoryEntries, toMemoryEntry } from "../domain/entryMapper.js";
import { memoryRepository } from "../persistence.js";
import { selectSources, sourceById, sourceDefinitions, toPublicSource } from "./sources.js";
import { memorySourcePath, readMemoryRecords } from "./repositoryStorage.js";
import {
  WORKING_MEMORY_FILE,
  readWorkingMemoryDocument,
  workingMemoryItemToEntry
} from "../workingMemoryDocument.js";

export async function listMemoryEntries(config: AppConfig, sourceInput?: unknown) {
  const sources = selectSources(sourceInput);
  if (sources.length === 1 && sources[0]?.id === "working") {
    const document = await readWorkingMemoryDocument(config);
    return {
      sources: sourceDefinitions.map(toPublicSource),
      entries: document.items.map(workingMemoryItemToEntry)
        .sort((left, right) => compareMemoryEntries(left, right)),
      document: {
        fileName: WORKING_MEMORY_FILE,
        content: document.content,
        revision: document.revision
      }
    };
  }
  const entries = (await Promise.all(sources.map((source) => readSourceEntries(config, source)))).flat();
  return {
    sources: sourceDefinitions.map(toPublicSource),
    entries: entries.sort((left, right) => compareMemoryEntries(left, right))
  };
}

export async function readMemorySourceEntries(config: AppConfig, sourceInput: MemorySourceId) {
  return readSourceEntries(config, sourceById(sourceInput));
}

export async function readSourceEntries(config: AppConfig, source: SourceDefinition) {
  if (source.id === "working") {
    const document = await readWorkingMemoryDocument(config);
    return document.items.map(workingMemoryItemToEntry);
  }
  const filePath = memorySourcePath(config, source);
  const records = await readMemoryRecords(filePath);
  const entries = records.map((record) => toMemoryEntry(source, record)).filter((entry) => entry.text.trim());
  if (source.id !== "long_term" || !entries.length) return entries;

  const repository = memoryRepository(config);
  const recordIds = entries.map((entry) => entry.id);
  const stats = repository.initializeRecallTracking?.(recordIds)
    ?? repository.listRecallStats?.(recordIds)
    ?? [];
  const byId = new Map(stats.map((item) => [item.recordId, item]));
  return entries.map((entry) => {
    const item = byId.get(entry.id);
    return item ? {
      ...entry,
      recallCount: item.recallCount,
      distinctRecallDays: item.distinctRecallDays,
      lastRecalledAt: item.lastRecalledAt ?? undefined,
      recallTrackingStartedAt: item.trackingStartedAt,
      lastReviewedAt: item.lastReviewedAt ?? undefined,
      importance: item.importance ?? undefined,
      futureRelevance: item.futureRelevance ?? undefined,
      emotionalSalience: item.emotionalSalience ?? undefined
    } : entry;
  });
}
