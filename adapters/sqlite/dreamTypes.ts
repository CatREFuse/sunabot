export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
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

export interface RecordActualRecallInput {
  recordId: string;
  recallKey: string;
  localDate: string;
  at?: Date;
}

export interface ReserveActualRecallInput {
  recordId: string;
  recallKey: string;
  at?: Date;
}

export interface ReserveActualRecallResult {
  reserved: boolean;
  recordPresent: boolean;
}

export interface RecordActualRecallResult {
  recorded: boolean;
  recordPresent: boolean;
  stats: MemoryRecallStats;
}

export interface RecordMemoryReviewInput {
  recordId: string;
  importance: number;
  futureRelevance: number;
  emotionalSalience: number;
  at?: Date;
}

export type DreamRunStatus = "running" | "generated" | "consolidated" | "completed" | "failed";
export type DreamPersonaStatus = "pending" | "none" | "proposed" | "applied" | "skipped" | "failed";

export interface DreamRun {
  id: string;
  localDate: string;
  scheduledFor: string;
  timeZone: string;
  window: {
    start: string;
    end: string;
  };
  status: DreamRunStatus;
  workerId: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  seed: string;
  inputDigest: string;
  input: JsonObject;
  output: JsonObject | null;
  dreamText: string | null;
  workingMemoryId: string | null;
  persona: JsonObject | null;
  personaStatus: DreamPersonaStatus;
  result: JsonObject | null;
  errorCode: string | null;
  errorText: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  consolidatedAt: string | null;
  personaUpdatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface ClaimDailyDreamRunInput {
  id?: string;
  localDate: string;
  scheduledFor: string;
  timeZone: string;
  window: {
    start: string;
    end: string;
  };
  workerId: string;
  leaseMs: number;
  seed: string;
  inputDigest: string;
  input: JsonObject;
  force?: boolean;
  now?: Date;
}

export interface DreamRunClaimResult {
  status: "created" | "recovered" | "busy" | "existing";
  run: DreamRun;
}

export interface DreamMemoryArchive {
  recordId: string;
  runId: string;
  data: JsonObject;
  reason: string;
  archivedAt: string;
  purgeAfter: string;
}

export interface DreamConsolidationArchiveInput {
  recordId: string;
  data: JsonObject;
  reason: string;
  recallSnapshot: {
    recallCount: number;
    trackingStartedAt: string;
  };
}

export interface DreamRecallLineageInput {
  targetId: string;
  sourceIds: readonly string[];
}

export interface DreamMemoryReviewInput {
  recordId: string;
  sourceIds: readonly string[];
  importance: number;
  futureRelevance: number;
  emotionalSalience: number;
}

export interface CommitDreamConsolidationInput {
  runId: string;
  workerId: string;
  expectedWorkingDigest: string;
  expectedLongTermDigest: string;
  workingMemoryId: string;
  working: readonly JsonObject[];
  longTerm: readonly JsonObject[];
  archives: readonly DreamConsolidationArchiveInput[];
  recallLineages: readonly DreamRecallLineageInput[];
  reviews: readonly DreamMemoryReviewInput[];
  result: JsonObject;
  now?: Date;
}

export type DreamConsolidationCommitResult =
  | { status: "committed" | "existing"; run: DreamRun }
  | {
      status: "snapshot_conflict";
      sources: Array<"working" | "long_term">;
      actualWorkingDigest: string;
      actualLongTermDigest: string;
    }
  | { status: "lease_lost"; run: DreamRun }
  | { status: "result_conflict"; run: DreamRun };

export interface SqliteDreamStoreOptions {
  clock?: () => Date;
  idFactory?: () => string;
}
