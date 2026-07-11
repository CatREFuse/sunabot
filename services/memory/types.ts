

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

export interface SourceDefinition extends MemorySource {
  legacyFileName: string;
  field: string;
  fields: string[];
  idPrefix: string;
}

export interface MemoryRecord {
  index: number;
  value: Record<string, unknown>;
}

export interface NormalizedMemoryFact {
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

export interface UserProfileAggregate {
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

export interface UserProfileFactGroup {
  userId: string;
  userName: string;
  addressName: string;
  facts: string[];
  createdAt: string;
  updatedAt: string;
  time: string;
  source: string;
}

export interface MemoryIdentityConfig {
  bot: {
    adminQq: string;
    adminName: string;
  };
}
