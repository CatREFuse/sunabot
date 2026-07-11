import type { AppConfig } from "../../../src/types.js";
import type { MemorySourceId, SourceDefinition } from "../types.js";
import { compareMemoryEntries, toMemoryEntry } from "../domain/entryMapper.js";
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
  return records.map((record) => toMemoryEntry(source, record)).filter((entry) => entry.text.trim());
}
