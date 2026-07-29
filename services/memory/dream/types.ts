export type DreamFactuality = "factual" | "imagined";

export interface DreamNarrativeV1 {
  text: string;
  factuality: "imagined";
}

export interface DreamCanonicalMemoryV1 {
  fact: string;
}

export interface DreamLongTermReviewV1 {
  sourceIds: string[];
  action: "retain" | "rewrite" | "merge" | "archive";
  canonical: DreamCanonicalMemoryV1 | null;
  importance: number;
  futureRelevance: number;
  emotionalSalience: number;
  confidence: number;
  reason: string;
}

export interface DreamWorkingReviewV1 {
  sourceIds: string[];
  action: "retain" | "rewrite" | "merge" | "promote" | "discard";
  canonical: DreamCanonicalMemoryV1 | null;
  confidence: number;
  reason: string;
}

export type DreamPersonaAdjustmentKind =
  | "habit"
  | "communication_preference"
  | "relationship_tendency";

export type DreamPersonaTargetFile = "PREFERENCE.md" | "RELATION.md";

export interface DreamPersonaAdjustmentV1 {
  kind: DreamPersonaAdjustmentKind;
  targetFile: DreamPersonaTargetFile;
  statement: string;
  evidenceMemoryIds: string[];
}

export interface DreamFieldKnowledgeV1 {
  content: string;
  evidenceMemoryIds: string[];
}

export interface DreamModelOutputV1 {
  schemaVersion: 1;
  dream: DreamNarrativeV1;
  longTermReviews: DreamLongTermReviewV1[];
  workingReviews: DreamWorkingReviewV1[];
  personaAdjustment: DreamPersonaAdjustmentV1 | null;
  fieldKnowledge?: DreamFieldKnowledgeV1 | null;
  rawOutput?: string;
}

export interface DreamModelOutputExpectations {
  longTermMemoryIds: readonly string[];
  workingMemoryIds: readonly string[];
  personaEvidenceIds: readonly string[];
  fieldKnowledgeEvidenceIds?: readonly string[];
}

export interface DreamLongTermArchiveCandidate {
  recallCount: number;
  distinctRecallDays: number;
  lastRecalledAt: string | null;
  trackingStartedAt: string;
  importance: number;
  futureRelevance: number;
  emotionalSalience: number;
  hasActiveReferences: boolean;
  protectedFromDream: boolean;
  manuallyPinned: boolean;
  unique: boolean;
}

export type DreamArchiveRejectionReason =
  | "invalid_candidate"
  | "dormancy_too_short"
  | "importance_too_high"
  | "future_relevance_too_high"
  | "emotional_salience_too_high"
  | "active_reference"
  | "protected"
  | "manually_pinned"
  | "unique";

export interface DreamArchivePolicyResult {
  eligible: boolean;
  reasons: DreamArchiveRejectionReason[];
}

export interface DreamPersonaEvidence {
  id: string;
  eventId: string;
  context: string;
  occurredAt: string;
  factuality: DreamFactuality;
  impactScore: number;
}

export type DreamPersonaRejectionReason =
  | "unsupported_adjustment"
  | "unsafe_adjustment"
  | "insufficient_evidence"
  | "missing_evidence"
  | "imagined_evidence"
  | "insufficient_impact"
  | "insufficient_independent_events"
  | "insufficient_contexts"
  | "invalid_evidence_time"
  | "insufficient_time_span"
  | "invalid_cooldown"
  | "cooldown_active";

export interface DreamPersonaPolicyResult {
  eligible: boolean;
  reasons: DreamPersonaRejectionReason[];
}

export interface DreamScheduleOccurrence {
  localDate: string;
  scheduledAt: string;
  timeZone: string;
  trigger: "scheduled" | "catch_up";
}

export interface DreamRunScheduleInput {
  now?: Date | string;
  timeZone?: string;
  existingLocalDates?: readonly string[];
}

export type DreamHistoryStatus = "pending" | "running" | "generated" | "completed" | "failed";

export interface DreamHistoryItem {
  id: string;
  date: string;
  status: DreamHistoryStatus;
  scheduledFor: string;
  dreamText?: string;
  completedAt?: string;
  personalityChanged?: boolean;
  summary?: {
    merged: number;
    archived: number;
    promoted: number;
  };
}

export interface DreamHistoryEnvelope {
  items: DreamHistoryItem[];
  timeZone: string;
  nextScheduledFor?: string;
}
