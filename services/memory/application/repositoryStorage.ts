import path from "node:path";
import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import { resolveProjectPath } from "../../../packages/platform/projectPaths.js";
import { memoryRepository, type MemoryDataSource, type MemoryRepositoryPort } from "../persistence.js";
import type { MemoryRecord, SourceDefinition } from "../types.js";

export interface MemoryStorageBinding {
  store: MemoryRepositoryPort;
  source: MemoryDataSource;
}

export const memoryStorageBindings = new Map<string, MemoryStorageBinding>();

export async function readMemoryRecords(filePath: string): Promise<MemoryRecord[]> {
  const binding = memoryStorageBindings.get(filePath);
  if (!binding) throw new Error(`Memory storage is not registered: ${filePath}`);
  return binding.store.readMemory(binding.source).map((value, index) => ({ index, value }));
}

export async function writeMemoryRecords(filePath: string, records: MemoryRecord[]) {
  const binding = memoryStorageBindings.get(filePath);
  if (!binding) throw new Error(`Memory storage is not registered: ${filePath}`);
  binding.store.replaceMemory(binding.source, records.map((record) => record.value));
}

export function memorySourcePath(config: AppConfig, source: SourceDefinition) {
  const legacyPath = path.join(memoryWorkspacePath(config), source.legacyFileName);
  const store = memoryRepository(config);
  store.ensureLegacyMemoryImported(source.id, legacyPath);
  memoryStorageBindings.set(legacyPath, { store, source: source.id });
  return legacyPath;
}

export function memoryStore(config: AppConfig, source: SourceDefinition) {
  const storagePath = memorySourcePath(config, source);
  return memoryStorageBindings.get(storagePath)!.store;
}

export function memoryWorkspacePath(config: AppConfig) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("Agent workspace is not configured.");
  return workspace;
}
