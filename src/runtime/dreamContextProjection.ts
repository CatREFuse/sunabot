import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export const DREAM_CONTEXT_PROJECTION_LIMITS = {
  totalPayloadBytes: 256 * 1024,
  arrays: {
    workingMemories: 24,
    longTermMemories: 24,
    recallStats: 24,
    identityReferences: 128,
    sourceMemoryIds: 128,
    userProfiles: 64,
    profileFacts: 16,
    conversations: 12,
    messagesPerConversation: 16,
    activeTasks: 100,
    taskTargets: 20,
    taskMentions: 20,
    directorItems: 64,
    directorParticipants: 8,
    provenanceIds: 16,
    selectionReasons: 16
  },
  stringChars: {
    opaqueId: 256,
    reference: 72,
    timestamp: 64,
    timezone: 128,
    label: 160,
    memoryFact: 1_200,
    profileFact: 800,
    conversationText: 800,
    taskContext: 1_200,
    directorText: 800,
    personaSection: 6_000
  }
} as const;

const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEED_PATTERN = /^[a-f0-9]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const REDACTED_PATH = "[已隐藏路径]";
const REDACTED_SECRET = "[已隐藏敏感信息]";
const MEMORY_LANES = new Set([
  "recent", "remote", "recall", "salience", "task", "dream", "review", "seeded_mix"
]);
const MEMORY_REASONS = new Set([
  "recent_fragment", "remote_anchor", "never_recalled_tracked", "low_recall", "important",
  "future_relevant", "emotionally_salient", "active_task_or_commitment", "dream_material",
  "review_due", "seeded_association"
]);
const MESSAGE_ROLES = new Set(["user", "assistant", "event"]);
const TASK_STATUSES = new Set(["pending", "running", "generated", "completed", "failed"]);
const MEMORY_TEXT_FIELDS = [
  "eventType", "memoryKind", "occurredAt", "occurredEndAt", "observedAt", "createdAt", "updatedAt",
  "dreamDate", "dreamReviewedAt"
] as const;
const MEMORY_BOOLEAN_FIELDS = [
  "promoteToLongTerm", "explicitRemember", "protected", "protectedFromDream", "pinned",
  "manuallyPinned", "unique", "hasActiveReferences"
] as const;
const MEMORY_SCORE_FIELDS = ["importance", "futureRelevance", "emotionalSalience"] as const;

export interface DreamContextProjectionResult {
  payload: JsonRecord;
  byteLength: number;
}

export function projectDreamContextPayload(value: unknown): JsonRecord {
  return projectDreamContext(value).payload;
}

export function dreamPersonaPromptVariables(value: unknown) {
  const persona = recordValue(recordValue(value).persona);
  return {
    "persona.soul": typeof persona.soul === "string" ? persona.soul : "",
    "persona.preference": typeof persona.preference === "string" ? persona.preference : "",
    "persona.user": typeof persona.user === "string" ? persona.user : "",
    "persona.relation": typeof persona.relation === "string" ? persona.relation : ""
  };
}

export function projectDreamContext(value: unknown): DreamContextProjectionResult {
  const input = requiredRecord(value, "Dream context");
  const seed = requiredSeed(input.seed);
  const identities = buildIdentityIndex(input, seed);
  const workingMemories = projectMemoryGroup(input.workingMemories, "workingMemories", identities, seed);
  const longTermMemories = projectMemoryGroup(input.longTermMemories, "longTermMemories", identities, seed);
  const retainedIds = new Set([...workingMemories, ...longTermMemories].map(memoryItemId));
  const sourceMemoryIds = projectMemoryIdList(input.sourceMemoryIds, retainedIds);
  const payload: JsonRecord = {
    schemaVersion: 1,
    seed,
    localDate: requiredDate(input.localDate, "localDate"),
    scheduledFor: boundedRequiredText(input.scheduledFor, "scheduledFor", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    timeZone: boundedRequiredText(input.timeZone, "timeZone", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone),
    memoryWindow: projectMemoryWindow(input.memoryWindow),
    workingMemories,
    longTermMemories,
    recallStats: projectRecallStats(input.recallStats, new Set(longTermMemories.map(memoryItemId))),
    personaEvidenceIds: projectMemoryIdList(input.personaEvidenceIds, retainedIds),
    sourceMemoryIds: sourceMemoryIds.length ? sourceMemoryIds : [...retainedIds],
    userProfiles: projectUserProfiles(input.userProfiles, identities, seed),
    observedConversations: projectConversations(input.observedConversations, identities, seed),
    activeTasks: projectTasks(input.activeTasks, identities, seed),
    plannedDailySchedule: projectDirectorSchedule(input.plannedDailySchedule, identities, seed),
    persona: projectPersona(input.persona, identities)
  };
  enforceTotalPayloadLimit(payload);
  synchronizeMemoryReferences(payload);
  const byteLength = dreamContextPayloadByteLength(payload);
  if (byteLength > DREAM_CONTEXT_PROJECTION_LIMITS.totalPayloadBytes) {
    throw new Error("Projected Dream context exceeds its total payload limit.");
  }
  return { payload, byteLength };
}

export function dreamContextPayloadByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function projectMemoryGroup(
  value: unknown,
  field: "workingMemories" | "longTermMemories",
  identities: IdentityIndex,
  seed: string
) {
  const limit = DREAM_CONTEXT_PROJECTION_LIMITS.arrays[field];
  return arrayValue(value).slice(0, limit).map((raw, index) => {
    const item = requiredRecord(raw, `${field}[${index}]`);
    const memory = requiredRecord(item.memory, `${field}[${index}].memory`);
    const id = requiredMemoryId(item.id ?? memory.id, `${field}[${index}].id`);
    const factuality = item.factuality === "imagined" || memory.factuality === "imagined"
      || memory.realityStatus === "imagined" ? "imagined" : "factual";
    return {
      id,
      factuality,
      memory: projectMemoryRecord(memory, id, factuality, identities, seed),
      recallStats: projectOptionalRecallStats(item.recallStats, id),
      selection: projectSelection(item.selection)
    };
  });
}

function projectMemoryRecord(
  record: JsonRecord,
  id: string,
  factuality: "factual" | "imagined",
  identities: IdentityIndex,
  seed: string
) {
  const projected: JsonRecord = {
    id,
    fact: boundedText(record.fact, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.memoryFact, identities),
    factuality
  };
  for (const field of MEMORY_TEXT_FIELDS) {
    const text = optionalBoundedText(record[field], textLimitForMemoryField(field));
    if (text) projected[field] = text;
  }
  for (const field of MEMORY_BOOLEAN_FIELDS) {
    if (typeof record[field] === "boolean") projected[field] = record[field];
  }
  for (const field of MEMORY_SCORE_FIELDS) {
    const score = boundedNumber(record[field], 0, 1);
    if (score !== null) projected[field] = score;
  }
  const participantRefs = identities.refsForRecord(record);
  if (participantRefs.length) projected.participantRefs = participantRefs;
  const eventKey = optionalIdentityValue(record.eventKey);
  const causalChainKey = optionalIdentityValue(record.causalChainKey);
  const subjectKey = optionalIdentityValue(record.subjectKey);
  const contextKey = optionalIdentityValue(record.conversationId) ?? optionalIdentityValue(record.contextKey);
  if (eventKey) projected.eventRef = opaqueReference(seed, "event", eventKey);
  if (causalChainKey) projected.causalChainRef = opaqueReference(seed, "causal", causalChainKey);
  if (subjectKey) projected.subjectRef = opaqueReference(seed, "subject", subjectKey);
  if (contextKey) projected.contextRef = opaqueReference(seed, "context", contextKey);
  const longTermId = optionalMemoryId(record.longTermId);
  if (longTermId) projected.linkedLongTermId = longTermId;
  for (const field of ["sourceWorkingMemoryIds", "sourceLongTermMemoryIds"] as const) {
    const ids = projectProvenanceIds(record[field]);
    if (ids.length) projected[field] = ids;
  }
  return projected;
}

function projectSelection(value: unknown) {
  const selection = recordValue(value);
  const lane = typeof selection.lane === "string" && MEMORY_LANES.has(selection.lane)
    ? selection.lane : "seeded_mix";
  const reasons = arrayValue(selection.reasons)
    .filter((reason): reason is string => typeof reason === "string" && MEMORY_REASONS.has(reason))
    .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.selectionReasons);
  const score = boundedNumber(selection.score, 0, 100) ?? 0;
  const rawComponents = recordValue(selection.scoreComponents);
  const scoreComponents: JsonRecord = {};
  for (const field of [
    "recency", "remoteness", "recallNeed", "importance", "futureRelevance", "emotionalSalience",
    "taskRelevance", "dreamMaterial", "reviewNeed", "seededAssociation"
  ]) {
    const number = boundedNumber(rawComponents[field], 0, 1);
    if (number !== null) scoreComponents[field] = number;
  }
  const ageDays = boundedNumber(rawComponents.ageDays, 0, 36_500);
  if (ageDays !== null) scoreComponents.ageDays = ageDays;
  return { lane, reasons, score, scoreComponents };
}

function projectRecallStats(value: unknown, retainedIds: ReadonlySet<string>) {
  return arrayValue(value)
    .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.recallStats)
    .flatMap((raw) => {
      const record = recordValue(raw);
      const id = optionalMemoryId(record.recordId);
      return id && retainedIds.has(id) ? [projectRecallStatsRecord(record, id)] : [];
    });
}

function projectOptionalRecallStats(value: unknown, id: string) {
  if (value == null) return null;
  return projectRecallStatsRecord(recordValue(value), id);
}

function projectRecallStatsRecord(record: JsonRecord, id: string) {
  return {
    recordId: id,
    recallCount: boundedInteger(record.recallCount, 0, Number.MAX_SAFE_INTEGER),
    distinctRecallDays: boundedInteger(record.distinctRecallDays, 0, Number.MAX_SAFE_INTEGER),
    lastRecalledAt: nullableBoundedText(record.lastRecalledAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    trackingStartedAt: optionalBoundedText(record.trackingStartedAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp) ?? "",
    lastReviewedAt: nullableBoundedText(record.lastReviewedAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    importance: nullableBoundedNumber(record.importance, 0, 1),
    futureRelevance: nullableBoundedNumber(record.futureRelevance, 0, 1),
    emotionalSalience: nullableBoundedNumber(record.emotionalSalience, 0, 1)
  };
}

function projectUserProfiles(value: unknown, identities: IdentityIndex, seed: string) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.userProfiles).map((raw, index) => {
    const profile = recordValue(raw);
    const refs = identities.refsForRecord(profile);
    const rawId = optionalIdentityValue(profile.id) ?? `profile-${index}`;
    const facts = [profile.fact, ...arrayValue(profile.facts)]
      .flatMap((fact) => typeof fact === "string" ? [boundedText(fact, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.profileFact, identities)] : [])
      .filter(Boolean)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.profileFacts);
    return compactObject({
      profileRef: opaqueReference(seed, "profile", rawId),
      participantRefs: refs.length ? refs : undefined,
      facts,
      createdAt: optionalBoundedText(profile.createdAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      updatedAt: optionalBoundedText(profile.updatedAt ?? profile.time, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp)
    });
  });
}

function projectConversations(value: unknown, identities: IdentityIndex, seed: string) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.conversations).flatMap((raw, index) => {
    const conversation = recordValue(raw);
    const rawId = optionalIdentityValue(conversation.id) ?? `conversation-${index}`;
    const messages = arrayValue(conversation.messages)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.messagesPerConversation)
      .map((message) => projectConversationMessage(message, identities));
    if (!messages.length && typeof conversation.text === "string") {
      messages.push({
        role: "event",
        text: boundedText(conversation.text, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.conversationText, identities)
      });
    }
    if (!messages.length) return [];
    const scope = conversation.scope === "private" || conversation.scope === "user_group" || conversation.scope === "bot_group"
      ? conversation.scope : undefined;
    return [compactObject({
      contextRef: opaqueReference(seed, "context", rawId),
      scope,
      messages
    })];
  });
}

function projectConversationMessage(value: unknown, identities: IdentityIndex) {
  const message = recordValue(value);
  const role = typeof message.role === "string" && MESSAGE_ROLES.has(message.role) ? message.role : "event";
  const speaker = identities.refForGroup(identityValues(message));
  return compactObject({
    role,
    text: boundedText(message.text, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.conversationText, identities),
    at: optionalBoundedText(message.at, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    speakerRef: role === "assistant" ? undefined : speaker
  });
}

function projectTasks(value: unknown, identities: IdentityIndex, seed: string) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.activeTasks).map((raw, index) => {
    const task = recordValue(raw);
    const rawId = optionalIdentityValue(task.id) ?? `task-${index}`;
    const status = typeof task.status === "string" && TASK_STATUSES.has(task.status) ? task.status : undefined;
    return compactObject({
      taskRef: opaqueReference(seed, "task", rawId),
      name: optionalBoundedText(task.name ?? task.title, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label, identities),
      enabled: typeof task.enabled === "boolean" ? task.enabled : true,
      status,
      schedule: projectTaskSchedule(task.schedule, identities),
      context: optionalBoundedText(task.context, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.taskContext, identities),
      nextRunAt: nullableBoundedText(task.nextRunAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      lastScheduledAt: nullableBoundedText(task.lastScheduledAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      targets: projectTaskTargets(task.targets, identities, seed)
    });
  });
}

function projectTaskSchedule(value: unknown, identities: IdentityIndex) {
  const schedule = recordValue(value);
  if (schedule.kind === "cron") {
    return compactObject({
      kind: "cron",
      expression: optionalBoundedText(schedule.expression, 256),
      timeZone: optionalBoundedText(schedule.timezone, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone)
    });
  }
  if (schedule.kind === "once") {
    return compactObject({
      kind: "once",
      runAt: optionalBoundedText(schedule.runAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp)
    });
  }
  return undefined;
}

function projectTaskTargets(value: unknown, identities: IdentityIndex, seed: string) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskTargets).map((raw) => {
    const target = recordValue(raw);
    const conversation = optionalIdentityValue(target.conversationId);
    const participantRefs = arrayValue(target.mentionUserIds)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskMentions)
      .flatMap((item) => typeof item === "string" || typeof item === "number" ? [identities.ref(String(item))] : []);
    return compactObject({
      contextRef: conversation ? opaqueReference(seed, "context", conversation) : undefined,
      participantRefs: uniqueStrings(participantRefs)
    });
  });
}

function projectDirectorSchedule(value: unknown, identities: IdentityIndex, seed: string) {
  if (value == null) return null;
  const schedule = recordValue(value);
  return compactObject({
    date: optionalBoundedText(schedule.date, 16),
    timeZone: optionalBoundedText(schedule.timeZone, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone),
    theme: optionalBoundedText(schedule.theme, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities),
    summary: optionalBoundedText(schedule.summary, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities),
    items: arrayValue(schedule.items).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorItems).map((raw, index) => {
      const item = recordValue(raw);
      const rawId = optionalIdentityValue(item.id) ?? `schedule-item-${index}`;
      const participantRefs = arrayValue(item.participants)
        .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorParticipants)
        .flatMap((participant) => typeof participant === "string" ? [identities.ref(participant)] : []);
      const share = recordValue(item.share);
      return compactObject({
        itemRef: opaqueReference(seed, "schedule", rawId),
        startAt: optionalBoundedText(item.startAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
        endAt: optionalBoundedText(item.endAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
        activity: optionalBoundedText(item.activity, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities),
        location: optionalBoundedText(item.location, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label, identities),
        participantRefs: uniqueStrings(participantRefs),
        intent: optionalBoundedText(item.intent, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities),
        variant: optionalBoundedText(item.variant, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label, identities),
        share: compactObject({
          enabled: typeof share.enabled === "boolean" ? share.enabled : false,
          at: nullableBoundedText(share.at, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
          textIntent: nullableBoundedText(share.textIntent, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities),
          selfiePrompt: nullableBoundedText(share.selfiePrompt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText, identities)
        })
      });
    })
  });
}

function projectPersona(value: unknown, identities: IdentityIndex) {
  const persona = recordValue(value);
  return compactObject({
    soul: optionalBoundedText(persona.soul, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection, identities),
    preference: optionalBoundedText(persona.preference, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection, identities),
    user: optionalBoundedText(persona.user, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection, identities),
    relation: optionalBoundedText(persona.relation, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection, identities),
    air: optionalBoundedText(persona.air, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection, identities)
  });
}

function projectMemoryWindow(value: unknown) {
  const window = requiredRecord(value, "memoryWindow");
  return {
    start: boundedRequiredText(window.start, "memoryWindow.start", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    end: boundedRequiredText(window.end, "memoryWindow.end", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp)
  };
}

function enforceTotalPayloadLimit(payload: JsonRecord) {
  while (dreamContextPayloadByteLength(payload) > DREAM_CONTEXT_PROJECTION_LIMITS.totalPayloadBytes) {
    const schedule = recordValue(payload.plannedDailySchedule);
    if (popArray(schedule.items)) continue;
    if (popArray(payload.activeTasks)) continue;
    if (popArray(payload.userProfiles)) continue;
    if (popConversation(payload.observedConversations)) continue;
    if (shrinkPersona(recordValue(payload.persona))) continue;
    if (popMemory(payload)) {
      synchronizeMemoryReferences(payload);
      continue;
    }
    throw new Error("Projected Dream context cannot fit within its total payload limit.");
  }
}

function synchronizeMemoryReferences(payload: JsonRecord) {
  const working = arrayValue(payload.workingMemories);
  const longTerm = arrayValue(payload.longTermMemories);
  const ids = new Set([...working, ...longTerm].map(memoryItemId));
  const longTermIds = new Set(longTerm.map(memoryItemId));
  payload.sourceMemoryIds = arrayValue(payload.sourceMemoryIds).filter((id) => typeof id === "string" && ids.has(id));
  payload.personaEvidenceIds = arrayValue(payload.personaEvidenceIds).filter((id) => typeof id === "string" && ids.has(id));
  payload.recallStats = arrayValue(payload.recallStats).filter((item) => {
    const record = recordValue(item);
    return typeof record.recordId === "string" && longTermIds.has(record.recordId);
  });
}

function popMemory(payload: JsonRecord) {
  const working = arrayValue(payload.workingMemories);
  const longTerm = arrayValue(payload.longTermMemories);
  if (!working.length && !longTerm.length) return false;
  if (longTerm.length >= working.length && longTerm.length) longTerm.pop();
  else working.pop();
  return true;
}

function popConversation(value: unknown) {
  const conversations = arrayValue(value);
  const last = recordValue(conversations.at(-1));
  const messages = arrayValue(last.messages);
  if (messages.length > 1) {
    messages.pop();
    return true;
  }
  if (conversations.length) {
    conversations.pop();
    return true;
  }
  return false;
}

function shrinkPersona(persona: JsonRecord) {
  const fields = ["air", "user", "relation", "preference", "soul"];
  const candidates = fields.flatMap((field) => typeof persona[field] === "string" ? [{ field, text: persona[field] }] : []);
  const longest = candidates.sort((a, b) => b.text.length - a.text.length || a.field.localeCompare(b.field))[0];
  if (!longest || [...longest.text].length <= 512) return false;
  persona[longest.field] = [...longest.text].slice(0, Math.max(512, Math.floor([...longest.text].length * 0.75))).join("");
  return true;
}

function popArray(value: unknown) {
  if (!Array.isArray(value) || !value.length) return false;
  value.pop();
  return true;
}

class IdentityIndex {
  private readonly parent = new Map<string, string>();
  private readonly aliases = new Map<string, Set<string>>();
  private canonicalByRoot = new Map<string, string>();
  constructor(private readonly seed: string) {}
  addGroup(values: readonly unknown[]) {
    const keys = values.flatMap((value) => identityAlias(value)).filter(Boolean);
    if (!keys.length) return;
    for (const { key, raw } of keys) {
      if (!this.parent.has(key)) this.parent.set(key, key);
      const variants = this.aliases.get(key) ?? new Set<string>();
      variants.add(raw);
      this.aliases.set(key, variants);
    }
    for (const item of keys.slice(1)) this.union(keys[0]!.key, item.key);
  }
  finalize() {
    const members = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const values = members.get(root) ?? [];
      values.push(key);
      members.set(root, values);
    }
    this.canonicalByRoot = new Map([...members].map(([root, values]) => [root, values.sort(aliasOrder)[0]!]));
  }
  ref(value: unknown) {
    const alias = identityAlias(value)[0];
    const canonical = alias && this.parent.has(alias.key)
      ? this.canonicalByRoot.get(this.find(alias.key)) ?? alias.key
      : alias?.key ?? "unknown";
    return this.refForKey(canonical);
  }
  refForGroup(values: readonly unknown[]) {
    const first = values.flatMap((value) => identityAlias(value))[0];
    return first ? this.ref(first.raw) : undefined;
  }
  refsForRecord(record: JsonRecord) {
    return uniqueStrings(identityValues(record).map((value) => this.ref(value)))
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.identityReferences);
  }
  redact(value: string) {
    let text = value;
    const replacements = [...this.aliases.entries()].flatMap(([key, variants]) => {
      const canonical = this.canonicalByRoot.get(this.find(key)) ?? key;
      const display = `人物-${this.refForKey(canonical).slice(-10)}`;
      return [...variants].map((raw) => ({ raw, display }));
    }).sort((a, b) => b.raw.length - a.raw.length || a.raw.localeCompare(b.raw));
    for (const [index, replacement] of replacements.entries()) {
      const marker = `\u{E000}${index.toString(36)}\u{E001}`;
      text = replaceIdentityLiteral(text, replacement.raw, marker);
      text = text.replaceAll(marker, replacement.display);
    }
    return text;
  }
  private refForKey(key: string) {
    return opaqueReference(this.seed, "person", key);
  }
  private find(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }
  private union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [parent, child] = aliasOrder(leftRoot, rightRoot) <= 0
      ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    this.parent.set(child, parent);
  }
}

function buildIdentityIndex(input: JsonRecord, seed: string) {
  const identities = new IdentityIndex(seed);
  for (const field of ["workingMemories", "longTermMemories"] as const) {
    for (const raw of arrayValue(input[field]).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays[field])) {
      identitiesForRecord(recordValue(recordValue(raw).memory), identities);
    }
  }
  for (const raw of arrayValue(input.userProfiles).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.userProfiles)) {
    identitiesForRecord(recordValue(raw), identities);
  }
  for (const raw of arrayValue(input.observedConversations).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.conversations)) {
    const conversation = recordValue(raw);
    for (const message of arrayValue(conversation.messages).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.messagesPerConversation)) {
      identities.addGroup(identityValues(recordValue(message)));
    }
  }
  for (const raw of arrayValue(input.activeTasks).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.activeTasks)) {
    for (const target of arrayValue(recordValue(raw).targets).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskTargets)) {
      for (const userId of arrayValue(recordValue(target).mentionUserIds).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskMentions)) {
        identities.addGroup([userId]);
      }
    }
  }
  const schedule = recordValue(input.plannedDailySchedule);
  for (const raw of arrayValue(schedule.items).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorItems)) {
    for (const participant of arrayValue(recordValue(raw).participants).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorParticipants)) {
      identities.addGroup([participant]);
    }
  }
  const persona = recordValue(input.persona);
  identities.addGroup([persona.id, persona.name]);
  identities.finalize();
  return identities;
}

function identitiesForRecord(record: JsonRecord, identities: IdentityIndex) {
  const ids = uniqueIdentityValues([record.userId, ...arrayValue(record.userIds)]);
  const names = uniqueIdentityValues([
    record.userName, record.addressName, ...arrayValue(record.addressNames), record.senderName,
    record.senderNickname, record.senderCard
  ]);
  if (ids.length === 1) identities.addGroup([...ids, ...names]);
  else if (ids.length && ids.length === names.length) ids.forEach((id, index) => identities.addGroup([id, names[index]]));
  else {
    ids.forEach((id) => identities.addGroup([id]));
    names.forEach((name) => identities.addGroup([name]));
  }
}

function identityValues(record: JsonRecord) {
  return uniqueIdentityValues([
    record.userId, ...arrayValue(record.userIds), record.userName, record.addressName,
    ...arrayValue(record.addressNames), record.senderName, record.senderNickname, record.senderCard
  ]);
}

function uniqueIdentityValues(values: readonly unknown[]) {
  return uniqueStrings(values.flatMap((value) => typeof value === "string" || typeof value === "number" ? [String(value).trim()] : []).filter(Boolean));
}

function identityAlias(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return [];
  const raw = String(value).normalize("NFKC").trim().slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.opaqueId);
  if (!raw) return [];
  const kind = /^\d+$/u.test(raw) ? "0" : "1";
  return [{ key: `${kind}:${raw.toLowerCase()}`, raw }];
}

function aliasOrder(left: string, right: string) {
  return left.localeCompare(right);
}

function replaceIdentityLiteral(value: string, literal: string, replacement: string) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!escaped) return value;
  if (/^\d+$/u.test(literal)) {
    return value.replace(new RegExp(`(^|[^0-9])${escaped}(?=$|[^0-9])`, "gu"), `$1${replacement}`);
  }
  if (/^[A-Za-z0-9_]+$/u.test(literal)) {
    return value.replace(new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "gu"), `$1${replacement}`);
  }
  return value.replace(new RegExp(escaped, "gu"), replacement);
}

function opaqueReference(seed: string, namespace: string, value: string) {
  const digest = createHash("sha256")
    .update(seed)
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(value.normalize("NFKC").trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return `${namespace}:${digest}`;
}

function boundedText(value: unknown, maxChars: number, identities?: IdentityIndex) {
  if (typeof value !== "string") return "";
  let text = value.normalize("NFC").trim();
  if (identities) text = identities.redact(text);
  text = redactSensitiveText(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\r\n?/gu, "\n");
  return [...text].slice(0, maxChars).join("");
}

function redactSensitiveText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, REDACTED_SECRET)
    .replace(/\b(?:(?:proxy-)?authorization\s*:\s*)?(?:basic|bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/giu, REDACTED_SECRET)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED_SECRET)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED_SECRET)
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}/gu, REDACTED_SECRET)
    .replace(/\b((?:(?:aws[_-]?)?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token))["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${REDACTED_SECRET}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${REDACTED_SECRET}`)
    .replace(/([?&](?:x-amz-(?:algorithm|credential|date|expires|signedheaders|security-token|signature)|x-goog-(?:algorithm|credential|date|expires|signedheaders|signature)|awsaccesskeyid|googleaccessid|key-pair-id|api[_-]?key|access[_-]?token|key|token|secret|password|policy|signature|expires|sig)=)[^&#\s]+/giu, `$1${REDACTED_SECRET}`)
    .replace(/(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/giu, `$1${REDACTED_SECRET}@`)
    .replace(/(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/gu, REDACTED_SECRET)
    .replace(/(?<![\p{L}\p{N}])\d{5,}(?![\p{L}\p{N}])/gu, REDACTED_SECRET)
    .replace(/file:\/\/(?:\/[A-Za-z]:)?[^\s"'<>]+/giu, REDACTED_PATH)
    .replace(/\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+(?:\\[^\s"'<>|?*]+)*/gu, REDACTED_PATH)
    .replace(/(?<![:/])\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9$._-]+(?:\/[^\s"'<>?*]+)*/gu, REDACTED_PATH)
    .replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>|?*]+)?/gu, REDACTED_PATH)
    .replace(/(?<![A-Za-z0-9/*])\/(?:[A-Za-z0-9._~-][A-Za-z0-9._~@%+=:,()-]*)(?:\/[A-Za-z0-9._~@%+=:,()-]+)*/gu, REDACTED_PATH);
}

function projectMemoryIdList(value: unknown, allowed: ReadonlySet<string>) {
  return uniqueStrings(arrayValue(value).flatMap((item) => {
    const id = optionalMemoryId(item);
    return id && allowed.has(id) ? [id] : [];
  })).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.sourceMemoryIds);
}

function projectProvenanceIds(value: unknown) {
  return uniqueStrings(arrayValue(value).flatMap((item) => {
    const id = optionalMemoryId(item);
    return id ? [id] : [];
  })).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.provenanceIds);
}

function memoryItemId(value: unknown) {
  return requiredMemoryId(recordValue(value).id, "memory.id");
}

function textLimitForMemoryField(field: typeof MEMORY_TEXT_FIELDS[number]) {
  if (field === "eventType" || field === "memoryKind") return DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label;
  return DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp;
}

function requiredMemoryId(value: unknown, field: string) {
  const id = optionalMemoryId(value);
  if (!id) throw new Error(`${field} must be a safe opaque memory id.`);
  return id;
}

function optionalMemoryId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!MEMORY_ID_PATTERN.test(id) || containsSecretToken(id)) return undefined;
  return id;
}

function requiredSeed(value: unknown) {
  if (typeof value !== "string" || !SEED_PATTERN.test(value)) {
    throw new Error("Dream context seed must be a SHA-256 digest.");
  }
  return value;
}

function requiredDate(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`${field} must be a local date.`);
  return value;
}

function containsSecretToken(value: string) {
  return /^(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_]/iu.test(value);
}

function optionalIdentityValue(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).normalize("NFKC").trim();
  return text ? [...text].slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.opaqueId).join("") : undefined;
}

function boundedRequiredText(value: unknown, field: string, maxChars: number, identities?: IdentityIndex) {
  const text = boundedText(value, maxChars, identities);
  if (!text) throw new Error(`${field} must be a non-empty string.`);
  return text;
}

function optionalBoundedText(value: unknown, maxChars: number, identities?: IdentityIndex) {
  const text = boundedText(value, maxChars, identities);
  return text || undefined;
}

function nullableBoundedText(value: unknown, maxChars: number, identities?: IdentityIndex) {
  if (value == null) return null;
  return optionalBoundedText(value, maxChars, identities) ?? null;
}

function boundedNumber(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}

function nullableBoundedNumber(value: unknown, min: number, max: number) {
  return value == null ? null : boundedNumber(value, min, max);
}

function boundedInteger(value: unknown, min: number, max: number) {
  const number = boundedNumber(value, min, max) ?? min;
  return Math.trunc(number);
}

function compactObject(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function recordValue(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredRecord(value: unknown, field: string): JsonRecord {
  const record = recordValue(value);
  if (!Object.keys(record).length && (value == null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${field} must be an object.`);
  }
  return record;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}
