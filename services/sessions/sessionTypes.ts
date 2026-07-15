import type { CodexProcessIdentity } from "../../packages/contracts/tools/codex.js";

export type SessionEventStatus = "pending" | "running" | "completed" | "dead";
export type TurnStatus =
  | "running"
  | "replied"
  | "no_reply"
  | "deferred"
  | "failed"
  | "timed_out"
  | "interrupted";
export type ToolJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "needs_input"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";
export type OutboxStatus =
  | "pending"
  | "sending"
  | "sent_remote"
  | "sent"
  | "dead"
  | "delivery_unknown";

export interface SessionStoreOptions {
  databasePath: string;
  clock?: () => number;
  idFactory?: () => string;
  defaultLeaseMs?: number;
  recoverOnOpen?: "expired" | "all";
}

export interface SessionStateRecord {
  sessionId: string;
  nextEventSequence: number;
  completedEventSequence: number;
  nextOutboxSequence: number;
  completedOutboxSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEventRecord {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  dedupeKey?: string;
  payload: unknown;
  status: SessionEventStatus;
  attempts: number;
  availableAt: number;
  createdAt: number;
  claimedAt?: number;
  finishedAt?: number;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  eventId: string;
  attempt: number;
  status: TurnStatus;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  startedAt: number;
  finishedAt?: number;
}

export interface ToolJobRecord {
  id: string;
  sessionId: string;
  originEventId: string;
  originTurnId: string;
  providerCallId: string;
  toolName: string;
  taskKind?: string;
  originalRequest: unknown;
  arguments: unknown;
  status: ToolJobStatus;
  attempts: number;
  attemptToken?: string;
  processIdentity?: CodexProcessIdentity;
  availableAt: number;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  ackOutboxId: string;
  completionEventId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface OutboxRecord {
  id: string;
  sessionId: string;
  sequence: number;
  originTurnId: string;
  kind: string;
  dedupeKey?: string;
  payload: unknown;
  deliveryPartition: string;
  partitionSequence: number;
  status: OutboxStatus;
  attempts: number;
  settleAttempts: number;
  availableAt: number;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  remoteReceipt?: unknown;
  completedSettleSteps: string[];
  uncertainSettleStep?: string;
  createdAt: number;
  transportStartedAt?: number;
  remoteSentAt?: number;
  sentAt?: number;
  finishedAt?: number;
}

export interface EnqueueSessionEventInput {
  sessionId: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  availableAt?: number;
}

export interface EnqueueSessionEventResult {
  event: SessionEventRecord;
  inserted: boolean;
}

export interface ClaimOptions {
  workerId: string;
  leaseMs?: number;
  sessionId?: string;
  deliveryPartition?: string;
  excludedDeliveryPartitions?: readonly string[];
}

export interface ClaimedTurn {
  event: SessionEventRecord;
  turn: TurnRecord;
}

export interface OutboxDraft {
  kind: string;
  payload: unknown;
  deliveryPartition?: string;
  dedupeKey?: string;
  availableAt?: number;
}

export interface FinishTurnInput {
  turnId: string;
  workerId: string;
  outcome: Exclude<TurnStatus, "running" | "deferred" | "interrupted">;
  result?: unknown;
  error?: unknown;
  outbox?: OutboxDraft[];
}

export interface FinishTurnResult {
  turn: TurnRecord;
  outbox: OutboxRecord[];
  duplicate: boolean;
}

export interface DeferTurnInput {
  turnId: string;
  workerId: string;
  job: {
    id?: string;
    providerCallId: string;
    toolName: string;
    taskKind?: string;
    originalRequest: unknown;
    arguments: unknown;
    availableAt?: number;
  };
  acknowledgement: OutboxDraft;
  result?: unknown;
}

export interface DeferTurnResult {
  turn: TurnRecord;
  job: ToolJobRecord;
  acknowledgement: OutboxRecord;
  duplicate: boolean;
}

export interface CompleteToolJobInput {
  jobId: string;
  workerId?: string;
  attempt?: number;
  attemptToken?: string;
  status: Exclude<ToolJobStatus, "queued" | "running">;
  result?: unknown;
  error?: unknown;
}

export interface CompleteToolJobResult {
  job: ToolJobRecord;
  event: SessionEventRecord;
  inserted: boolean;
}

export interface FinishOutboxInput {
  outboxId: string;
  workerId: string;
  outcome: "sent" | "dead" | "delivery_unknown" | "retry";
  result?: unknown;
  error?: unknown;
  availableAt?: number;
}

export interface ReplayUnknownOutboxInput {
  outboxId: string;
  confirmedNotSent: true;
}

export interface ResolveUnknownSettleInput {
  outboxId: string;
  settleStep: string;
  confirmed: "applied" | "not_applied";
}

export interface RecoveryResult {
  turns: number;
  toolJobs: number;
  outbox: number;
}

export type SqlRow = Record<string, unknown>;
