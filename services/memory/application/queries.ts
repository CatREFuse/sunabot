import type { AppConfig } from "../../../src/types.js";
import type { MemorySourceId, SourceDefinition } from "../types.js";
import { compareMemoryEntries, toMemoryEntry } from "../domain/entryMapper.js";
import { memoryRepository } from "../persistence.js";
import { selectSources, sourceById, sourceDefinitions, toPublicSource } from "./sources.js";
import { memorySourcePath, readMemoryRecords } from "./repositoryStorage.js";

export async function listMemoryEntries(config: AppConfig, sourceInput?: unknown) {
  const sources = selectSources(sourceInput);
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
