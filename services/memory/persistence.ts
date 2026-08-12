import type { AppConfig } from "../../packages/contracts/admin/public.js";
import type {
  MemoryRecallStats,
  RecordActualMemoryRecallInput,
  RecordActualMemoryRecallResult,
  ReserveActualMemoryRecallInput,
  ReserveActualMemoryRecallResult
} from "./types.js";

export type MemoryDataSource = "working" | "long_term" | "user_profile";
export type MemoryRecordData = Record<string, unknown>;
export type MemorySourceRevisions = Record<MemoryDataSource, number>;

export interface MemoryRepositoryPort {
  readMemory(source: MemoryDataSource): MemoryRecordData[];
  readMemorySnapshot(): { records: Record<MemoryDataSource, MemoryRecordData[]>; revisions: MemorySourceRevisions };
  replaceMemory(source: MemoryDataSource, records: readonly MemoryRecordData[]): void;
  ensureLegacyMemoryImported(source: MemoryDataSource, filePath: string): void;
  initializeRecallTracking?(recordIds: readonly string[], at?: Date): MemoryRecallStats[];
  reserveActualRecall(input: ReserveActualMemoryRecallInput): ReserveActualMemoryRecallResult;
  recordActualRecall?(input: RecordActualMemoryRecallInput): RecordActualMemoryRecallResult;
  listRecallStats?(recordIds?: readonly string[]): MemoryRecallStats[];
  appendMemoryOperationLog?(record: MemoryRecordData): void;
  readMemoryOperationLogPage?(options: { page: number; pageSize: number }): {
    logs: MemoryRecordData[];
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}

export interface MemoryPersistenceProvider {
  repository(config: Pick<AppConfig, "persona">): MemoryRepositoryPort;
  databasePath(config: Pick<AppConfig, "persona">): string;
}

let provider: MemoryPersistenceProvider | undefined;

export function configureMemoryPersistence(next: MemoryPersistenceProvider) {
  provider = next;
}

export function memoryRepository(config: Pick<AppConfig, "persona">) {
  if (!provider) throw new Error("Memory persistence provider is not configured.");
  return provider.repository(config);
}

export function memoryDatabasePath(config: Pick<AppConfig, "persona">) {
  if (!provider) throw new Error("Memory persistence provider is not configured.");
  return provider.databasePath(config);
}
