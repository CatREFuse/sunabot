export const USER_TEST_CASE_MARKER = "<!-- sunabot-user-test-case:v1 -->";

export type UserTestCaseKind = "conversation" | "memory_compression" | "dream";
export type UserTestVerdict = "pass" | "fail" | "blocked" | "inconclusive";

export interface UserTestQualityCriterion {
  id: string;
  description: string;
  minimumScore: number;
}

export interface UserTestExpectedOutput {
  requiredTools?: string[];
  forbiddenTools?: string[];
  forbiddenSuccessfulTools?: string[];
  requiredAvailableTools?: string[];
  forbiddenAvailableTools?: string[];
  requiredText?: string[];
  forbiddenText?: string[];
  providerPrompt?: ProviderPromptExpectation;
  requiredOutboundKinds?: Array<"message" | "asset" | "poke">;
  forbiddenOutboundKinds?: Array<"message" | "asset" | "poke">;
  requiredInboundAttachments?: ExpectedInboundAttachment[];
  minimumOutboundCount?: number;
  maximumOutboundCount?: number;
}

export interface ProviderPromptExpectation {
  promptFamily: string;
  orderedText: string[];
  forbiddenText?: string[];
}

export interface ExpectedInboundAttachment {
  messageId: string;
  index: number;
  name: string;
  status: "ready" | "partial" | "unsupported" | "too_large" | "failed";
  acquisitionStatus?: "pending" | "acquired" | "failed";
  parseStatus?: "not_started" | "pending" | "ready" | "partial" | "unsupported" | "parse_failed";
  blobSha256?: string;
  blobSizeBytes?: number;
  blobMimeType?: string;
  format?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  pageCount?: number;
  handle?: string;
}

export interface ConversationFixtureFile {
  backend: "native" | "docker";
  path: string;
  content: string;
}

export interface ConversationFixtureAttachmentSource {
  fileId: string;
  name: string;
  contentBase64: string;
}

export interface ConversationFixtureMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  userId?: number;
  senderName?: string;
}

export interface ConversationFixtureState {
  workingMemory?: WorkingMemoryFixtureItem[];
  longTerm?: JsonFixtureRecord[];
  userProfiles?: JsonFixtureRecord[];
  air?: string;
  resetKnowledge?: Array<"native" | "docker">;
  workbenchFiles?: ConversationFixtureFile[];
  attachmentSources?: ConversationFixtureAttachmentSource[];
  conversationMessages?: ConversationFixtureMessage[];
}

export interface ConversationUserTestInput {
  actor: "admin_private" | "user_private" | "admin_group" | "user_group";
  event: Record<string, unknown>;
  accountId: string;
  selfId: string;
  replyEnabled?: boolean;
  forwardMessages?: Record<string, unknown>;
  fixture?: ConversationFixtureState;
}

export interface WorkingMemoryFixtureItem {
  id: string;
  content: string;
  occurredAt: string;
  recordedAt?: string;
  timeZone?: string;
  conversationId: string;
  conversationScope: "private" | "user_group" | "bot_group";
  conversationTitle?: string;
  sourceKind?: "model_merge" | "add_workmemory" | "admin" | "dream";
  batchId?: string;
  userId?: string;
  userIds?: string[];
  userName?: string;
  addressNames?: string[];
  occurredEndAt?: string;
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  causalChainKey?: string;
  sourceMemoryIds?: string[];
  memoryKind?: string;
  realityStatus?: string;
  factuality?: string;
  dreamRunId?: string;
  dreamDate?: string;
  dreamReviewedAt?: string;
}

export type JsonFixtureRecord = Record<string, unknown>;
export type BranchFixtureTimePolicy = "fixed" | "rebase_to_runtime";

export interface MemoryCompressionUserTestInput {
  timePolicy: BranchFixtureTimePolicy;
  now: string;
  workingMemory: WorkingMemoryFixtureItem[];
  longTerm: JsonFixtureRecord[];
  userProfiles: JsonFixtureRecord[];
  conversation: {
    id: string;
    scope: "private" | "user_group" | "bot_group";
    title: string;
    userId?: number;
    groupId?: number;
  };
  messages: Array<{
    id: string;
    sequence: number;
    role: "user" | "assistant";
    text: string;
    at: string;
    userId?: number;
    senderName?: string;
    imageCount?: number;
    quoteCount?: number;
  }>;
}

export interface DreamPersonaFixture {
  name: string;
  soul: string;
  preference: string;
  user: string;
  relation: string;
  air: string;
}

export interface DreamActiveTaskFixture {
  id: string;
  name: string;
  runAt: string;
  context: string;
  targetConversationId: string;
  mentionUserIds: string[];
}

export interface DreamDirectorScheduleFixture {
  schemaVersion: 1;
  date: string;
  timeZone: string;
  theme: string;
  summary: string;
  items: Array<{
    id: string;
    startAt: string;
    endAt: string;
    activity: string;
    location: string;
    participants: string[];
    intent: string;
    variant: string;
    share: {
      enabled: boolean;
      at: string | null;
      textIntent: string | null;
      selfiePrompt: string | null;
    };
  }>;
}

export interface DreamUserTestInput {
  timePolicy: BranchFixtureTimePolicy;
  now: string;
  workingMemory: WorkingMemoryFixtureItem[];
  longTerm: JsonFixtureRecord[];
  userProfiles: JsonFixtureRecord[];
  persona: DreamPersonaFixture;
  conversations: Array<{
    id: string;
    scope: "private" | "user_group" | "bot_group";
    title: string;
    userId: number;
    groupId?: number;
    messages: Array<{
      id: string;
      sequence: number;
      role: "user" | "assistant";
      text: string;
      at: string;
      userId?: number;
      senderName?: string;
      imageCount?: number;
      quoteCount?: number;
    }>;
  }>;
  activeTasks: DreamActiveTaskFixture[];
  directorSchedule: DreamDirectorScheduleFixture | null;
}

export interface SanitizedBranchSampleV2 {
  schemaVersion: 2;
  kind: "sunabot.user-test.sanitized-branch-sample";
  redaction: {
    version: "sunabot-user-test-v2";
    irreversible: true;
    mappingPersisted: false;
    timestampPolicy: "relative-shifted-utc-minute";
    freeTextReviewRequired: true;
  };
  integrity: {
    canonicalization: "json-stringify-v1";
    payloadSha256: string;
  };
  fixture: {
    now: string;
    messageSelection: {
      source: number;
      productionEligible: number;
      included: number;
      mediaSegments: number;
      quoteSegments: number;
      excluded: {
        internal: number;
        failed: number;
        running: number;
        other: number;
        segmentOnly: number;
      };
    };
    workingMemory: WorkingMemoryFixtureItem[];
    longTerm: JsonFixtureRecord[];
    userProfiles: JsonFixtureRecord[];
    persona: DreamPersonaFixture;
    conversations: DreamUserTestInput["conversations"];
  };
}

export interface UserTestCase {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: UserTestCaseKind;
  goal: string;
  input: ConversationUserTestInput | MemoryCompressionUserTestInput | DreamUserTestInput;
  expected: UserTestExpectedOutput;
  quality: {
    criteria: UserTestQualityCriterion[];
  };
}

export interface HarnessAssertion {
  id: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  evidence?: string;
}

export interface HarnessToolCallObservation {
  name: string;
  callId?: string;
  stage?: string;
  status: "succeeded" | "failed" | "pending" | "unknown";
  request?: unknown;
  response?: unknown;
}

export interface HarnessObservation {
  inbound?: unknown;
  outbound: unknown[];
  inboundAttachments?: HarnessInboundAttachmentObservation[];
  attachmentResolutions?: HarnessAttachmentResolutionObservation[];
  tools: string[];
  toolCalls: HarnessToolCallObservation[];
  requestLogs: unknown[];
  branch?: unknown;
}

export interface HarnessInboundAttachmentObservation {
  messageId: string;
  index: number;
  name: string;
  status: string;
  acquisitionStatus?: string;
  parseStatus?: string;
  blobSha256?: string;
  blobSizeBytes?: number;
  blobMimeType?: string;
  format?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  pageCount?: number;
  handle?: string;
}

export interface HarnessAttachmentResolutionObservation {
  accountId?: string;
  fileId?: string;
  file?: string;
  strategy: "resolve" | "fallback";
  outcome: "resolved" | "missing" | "account_mismatch";
}

export interface UserTestRunReport {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  caseDigest: string;
  sourceRevision: string;
  kind: UserTestCaseKind;
  startedAt: string;
  finishedAt: string;
  workspaceMode: "isolated";
  execution: {
    status: "passed" | "failed" | "blocked";
    assertions: HarnessAssertion[];
    error?: string;
  };
  observation: HarnessObservation;
  quality: {
    status: "pending_review" | "reviewed";
    criteria: UserTestQualityCriterion[];
  };
  verdict: UserTestVerdict;
}

export interface UserTestQualityReview {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  reviewer: string;
  reviewedAt: string;
  criteria: Array<{
    id: string;
    score: number;
    evidence: string;
  }>;
  verdict: UserTestVerdict;
  summary: string;
}

export interface SealedUserTestReport extends UserTestRunReport {
  quality: UserTestRunReport["quality"] & {
    status: "reviewed";
    review: UserTestQualityReview;
  };
}

export interface UserTestReleaseManifest {
  schemaVersion: 1;
  suiteId: string;
  sourceRevision: string;
  cases: Array<{
    caseDocument: string;
    reports: string[];
    minimumIndependentRuns: number;
  }>;
}
