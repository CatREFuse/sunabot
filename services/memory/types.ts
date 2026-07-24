

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
  addressNames?: string[];
  /** @deprecated Legacy single-value compatibility alias. */
  addressName?: string;
  userNickname?: string;
  groupCards?: Array<{ groupId: number; card: string; lastSeenAt: string }>;
  sourceWorkingMemoryIds?: string[];
  sourceCandidateIds?: string[];
  sourceMemoryIds?: string[];
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  causalChainKey?: string;
  eventFingerprint?: string;
  longTermId?: string;
  batchId?: string;
  recordedAt?: string;
  timeZone?: string;
  conversationId?: string;
  conversationScope?: string;
  conversationTitle?: string;
  sourceKind?: "model_merge" | "add_workmemory" | "admin" | "dream";
  memoryKind?: string;
  realityStatus?: string;
  factuality?: string;
  dreamRunId?: string;
  dreamDate?: string;
  dreamReviewedAt?: string;
  promoteToLongTerm?: boolean;
  score?: number;
  recallCount?: number;
  distinctRecallDays?: number;
  lastRecalledAt?: string;
  recallTrackingStartedAt?: string;
  lastReviewedAt?: string;
  importance?: number;
  futureRelevance?: number;
  emotionalSalience?: number;
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
  addressNames?: string[];
  /** @deprecated Legacy single-value compatibility input. */
  addressName?: string;
  address_name?: string;
  salutation?: string;
  sourceWorkingMemoryIds?: string[];
  sourceCandidateIds?: string[];
  sourceMemoryIds?: string[];
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  causalChainKey?: string;
  eventFingerprint?: string;
  longTermId?: string;
  batchId?: string;
  memoryKind?: string;
  realityStatus?: string;
  factuality?: string;
  dreamRunId?: string;
  dreamDate?: string;
  dreamReviewedAt?: string;
  promoteToLongTerm?: boolean;
}

export interface WorkingMemorySnapshot {
  token: string;
  entries: MemoryEntry[];
}

export type ReplaceWorkingMemoryFactsResult =
  | { status: "applied"; entries: MemoryEntry[] }
  | { status: "snapshot_conflict" };

export interface MemoryBatchTransactionInput {
  batchId: string;
  expectedWorkingSnapshotToken: string;
  workingFacts: MemoryFactInput[];
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
  | { status: "snapshot_conflict" };

export interface MemoryRecallInput {
  query?: unknown;
  source?: unknown;
  limit?: unknown;
}

export interface MemoryRecallUsage {
  kind: "model_context";
  recallKey: string;
  recalledAt?: Date;
  localDate?: string;
}

export interface MemoryRecallStats {
  recordId: string;
  recallCount: number;
  distinctRecallDays: number;
  lastRecalledAt: string | null;
  lastRecallLocalDate: string | null;
  trackingStartedAt: string;
  lastReviewedAt: string | null;
  importance: number | null;
  futureRelevance: number | null;
  emotionalSalience: number | null;
}

export interface RecordActualMemoryRecallInput {
  recordId: string;
  recallKey: string;
  localDate: string;
  at?: Date;
}

export interface ReserveActualMemoryRecallInput {
  recordId: string;
  recallKey: string;
  at?: Date;
}

export interface ReserveActualMemoryRecallResult {
  reserved: boolean;
  recordPresent: boolean;
}

export interface RecordActualMemoryRecallResult {
  recorded: boolean;
  recordPresent: boolean;
  stats: MemoryRecallStats;
}

export interface MemoryWriteInput {
  source?: unknown;
  id?: unknown;
  text?: unknown;
  userId?: unknown;
  userName?: unknown;
  addressNames?: unknown;
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
  addressNames: string[];
  occurredAt: string;
  occurredEndAt: string;
  observedAt: string;
  updatedAt: string;
  sourceWorkingMemoryIds: string[];
  sourceCandidateIds: string[];
  eventType: string;
  subjectKey: string;
  eventKey: string;
  causalChainKey: string;
  eventFingerprint: string;
  longTermId: string;
  batchId: string;
  promoteToLongTerm: boolean;
}

export interface UserProfileAggregate {
  id: string;
  userId: string;
  userName: string;
  addressNames: string[];
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
  addressNames: string[];
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
