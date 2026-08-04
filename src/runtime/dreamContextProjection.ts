type JsonRecord = Record<string, unknown>;

export const DREAM_CONTEXT_PROJECTION_LIMITS = {
  totalPayloadBytes: 256 * 1024,
  arrays: {
    longTermMemories: 64,
    recallStats: 48,
    personaImpressions: 64,
    identityValues: 128,
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
    workingMemory: 64 * 1024,
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
const PERSONA_IMPRESSION_KINDS = new Set(["habit", "communication_preference", "relationship_tendency"]);
const PERSONA_IMPRESSION_LEVELS = new Set(["observation", "stable", "core"]);
const PERSONA_IMPRESSION_TARGETS = new Set(["PREFERENCE.md", "RELATION.md"]);
const PERSONA_TOPIC_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
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
  const sourceFieldKnowledge = normalizedProjectionSourceText(recordValue(input.persona).air);
  const workingMemory = boundedText(
    input.workingMemory,
    DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.workingMemory
  );
  const longTermMemories = projectMemoryGroup(input.longTermMemories, "longTermMemories");
  const retainedIds = new Set(longTermMemories.map(memoryItemId));
  const sourceMemoryIds = projectMemoryIdList(input.sourceMemoryIds, retainedIds);
  const payload: JsonRecord = {
    schemaVersion: 1,
    seed,
    localDate: requiredDate(input.localDate, "localDate"),
    scheduledFor: boundedRequiredText(input.scheduledFor, "scheduledFor", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    timeZone: boundedRequiredText(input.timeZone, "timeZone", DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone),
    memoryWindow: projectMemoryWindow(input.memoryWindow),
    workingMemory,
    longTermMemories,
    recallStats: projectRecallStats(input.recallStats, new Set(longTermMemories.map(memoryItemId))),
    personaEvidenceIds: projectMemoryIdList(input.personaEvidenceIds, retainedIds),
    fieldKnowledgeEvidenceIds: projectMemoryIdList(input.fieldKnowledgeEvidenceIds, retainedIds),
    fieldKnowledgeWritable: false,
    recentWindowHours: boundedInteger(input.recentWindowHours, 1, 720),
    sourceMemoryIds: sourceMemoryIds.length ? sourceMemoryIds : [...retainedIds],
    userProfiles: projectUserProfiles(input.userProfiles),
    observedConversations: projectConversations(input.observedConversations),
    activeTasks: projectTasks(input.activeTasks),
    plannedDailySchedule: projectDirectorSchedule(input.plannedDailySchedule),
    personaImpressions: projectPersonaImpressions(input.personaImpressions),
    persona: projectPersona(input.persona)
  };
  enforceTotalPayloadLimit(payload);
  synchronizeMemoryReferences(payload);
  const projectedFieldKnowledge = typeof recordValue(payload.persona).air === "string"
    ? String(recordValue(payload.persona).air)
    : "";
  payload.fieldKnowledgeWritable = sourceFieldKnowledge.length > 0
    && projectedFieldKnowledge === sourceFieldKnowledge;
  const byteLength = dreamContextPayloadByteLength(payload);
  if (byteLength > DREAM_CONTEXT_PROJECTION_LIMITS.totalPayloadBytes) {
    throw new Error("Projected Dream context exceeds its total payload limit.");
  }
  return {
    payload,
    byteLength
  };
}

function projectPersonaImpressions(value: unknown) {
  return arrayValue(value)
    .slice(-DREAM_CONTEXT_PROJECTION_LIMITS.arrays.personaImpressions)
    .flatMap((raw) => {
      const record = recordValue(raw);
      const kind = typeof record.kind === "string" && PERSONA_IMPRESSION_KINDS.has(record.kind)
        ? record.kind : null;
      const targetFile = typeof record.targetFile === "string"
        && PERSONA_IMPRESSION_TARGETS.has(record.targetFile) ? record.targetFile : null;
      const level = typeof record.level === "string" && PERSONA_IMPRESSION_LEVELS.has(record.level)
        ? record.level : null;
      const topicKey = typeof record.topicKey === "string"
        && PERSONA_TOPIC_PATTERN.test(record.topicKey) ? record.topicKey : null;
      const statement = typeof record.statement === "string"
        ? boundedText(record.statement, 80) : "";
      if (!kind || !targetFile || !level || !topicKey || !statement) return [];
      const rawId = optionalIdentityValue(record.id);
      return [compactObject({
        id: rawId,
        appliedAt: optionalBoundedText(
          record.appliedAt,
          DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp
        ),
        kind,
        targetFile,
        topicKey,
        level,
        statement
      })];
    });
}

export function dreamContextPayloadByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function projectMemoryGroup(
  value: unknown,
  field: "longTermMemories"
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
      memory: projectMemoryRecord(memory, id, factuality),
      recallStats: projectOptionalRecallStats(item.recallStats, id),
      selection: projectSelection(item.selection)
    };
  });
}

function projectMemoryRecord(
  record: JsonRecord,
  id: string,
  factuality: "factual" | "imagined"
) {
  const projected: JsonRecord = {
    id,
    fact: boundedText(record.fact, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.memoryFact),
    factuality,
    ...projectIdentityFields(record)
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
  for (const field of [
    "conversationId", "contextKey", "eventKey", "causalChainKey", "subjectKey"
  ] as const) {
    const value = optionalIdentityValue(record[field]);
    if (value) projected[field] = value;
  }
  const longTermId = optionalMemoryId(record.longTermId);
  if (longTermId) projected.linkedLongTermId = longTermId;
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

function projectUserProfiles(value: unknown) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.userProfiles).map((raw, index) => {
    const profile = recordValue(raw);
    const rawId = optionalIdentityValue(profile.id) ?? `profile-${index}`;
    const facts = [profile.fact, ...arrayValue(profile.facts)]
      .flatMap((fact) => typeof fact === "string"
        ? [boundedText(fact, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.profileFact)]
        : [])
      .filter(Boolean)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.profileFacts);
    return compactObject({
      id: rawId,
      ...projectIdentityFields(profile),
      facts,
      createdAt: optionalBoundedText(profile.createdAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      updatedAt: optionalBoundedText(profile.updatedAt ?? profile.time, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp)
    });
  });
}

function projectConversations(value: unknown) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.conversations).flatMap((raw, index) => {
    const conversation = recordValue(raw);
    const rawId = optionalIdentityValue(conversation.id) ?? `conversation-${index}`;
    const messages = arrayValue(conversation.messages)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.messagesPerConversation)
      .map(projectConversationMessage);
    if (!messages.length && typeof conversation.text === "string") {
      messages.push({
        role: "event",
        text: boundedText(conversation.text, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.conversationText)
      });
    }
    if (!messages.length) return [];
    const scope = conversation.scope === "private" || conversation.scope === "user_group" || conversation.scope === "bot_group"
      ? conversation.scope : undefined;
    return [compactObject({
      id: rawId,
      scope,
      title: optionalBoundedText(conversation.title, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label),
      messages
    })];
  });
}

function projectConversationMessage(value: unknown) {
  const message = recordValue(value);
  const role = typeof message.role === "string" && MESSAGE_ROLES.has(message.role) ? message.role : "event";
  return compactObject({
    role,
    text: boundedText(message.text, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.conversationText),
    at: optionalBoundedText(message.at, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
    ...(role === "assistant" ? {} : projectIdentityFields(message))
  });
}

function projectTasks(value: unknown) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.activeTasks).map((raw, index) => {
    const task = recordValue(raw);
    const rawId = optionalIdentityValue(task.id) ?? `task-${index}`;
    const status = typeof task.status === "string" && TASK_STATUSES.has(task.status) ? task.status : undefined;
    return compactObject({
      id: rawId,
      name: optionalBoundedText(task.name ?? task.title, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label),
      enabled: typeof task.enabled === "boolean" ? task.enabled : true,
      status,
      schedule: projectTaskSchedule(task.schedule),
      context: optionalBoundedText(task.context, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.taskContext),
      nextRunAt: nullableBoundedText(task.nextRunAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      lastScheduledAt: nullableBoundedText(task.lastScheduledAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
      targets: projectTaskTargets(task.targets)
    });
  });
}

function projectTaskSchedule(value: unknown) {
  const schedule = recordValue(value);
  if (schedule.kind === "cron") {
    return compactObject({
      kind: "cron",
      expression: optionalBoundedText(schedule.expression, 256),
      timeZone: optionalBoundedText(
        schedule.timezone ?? schedule.timeZone,
        DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone
      )
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

function projectTaskTargets(value: unknown) {
  return arrayValue(value).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskTargets).map((raw) => {
    const target = recordValue(raw);
    const conversation = optionalIdentityValue(target.conversationId);
    const mentionUserIds = arrayValue(target.mentionUserIds)
      .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.taskMentions)
      .flatMap((item) => {
        const identity = optionalIdentityValue(item);
        return identity ? [identity] : [];
      });
    return compactObject({
      conversationId: conversation,
      mentionUserIds: uniqueStrings(mentionUserIds)
    });
  });
}

function projectIdentityFields(value: JsonRecord) {
  const projected: JsonRecord = {};
  for (const field of [
    "userId", "userName", "addressName", "senderName", "senderNickname", "senderCard"
  ] as const) {
    const identity = optionalIdentityValue(value[field]);
    if (identity) projected[field] = identity;
  }
  for (const field of ["userIds", "addressNames"] as const) {
    const identities = uniqueStrings(arrayValue(value[field]).flatMap((item) => {
      const identity = optionalIdentityValue(item);
      return identity ? [identity] : [];
    })).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.identityValues);
    if (identities.length) projected[field] = identities;
  }
  return projected;
}

function projectDirectorSchedule(value: unknown) {
  if (value == null) return null;
  const schedule = recordValue(value);
  return compactObject({
    date: optionalBoundedText(schedule.date, 16),
    timeZone: optionalBoundedText(schedule.timeZone, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timezone),
    theme: optionalBoundedText(schedule.theme, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText),
    summary: optionalBoundedText(schedule.summary, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText),
    items: arrayValue(schedule.items).slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorItems).map((raw, index) => {
      const item = recordValue(raw);
      const rawId = optionalIdentityValue(item.id) ?? `schedule-item-${index}`;
      const participants = arrayValue(item.participants)
        .slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.arrays.directorParticipants)
        .flatMap((participant) => {
          const identity = optionalIdentityValue(participant);
          return identity ? [identity] : [];
        });
      const share = recordValue(item.share);
      return compactObject({
        id: rawId,
        startAt: optionalBoundedText(item.startAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
        endAt: optionalBoundedText(item.endAt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
        activity: optionalBoundedText(item.activity, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText),
        location: optionalBoundedText(item.location, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label),
        participants: uniqueStrings(participants),
        intent: optionalBoundedText(item.intent, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText),
        variant: optionalBoundedText(item.variant, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.label),
        share: compactObject({
          enabled: typeof share.enabled === "boolean" ? share.enabled : false,
          at: nullableBoundedText(share.at, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.timestamp),
          textIntent: nullableBoundedText(share.textIntent, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText),
          selfiePrompt: nullableBoundedText(share.selfiePrompt, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.directorText)
        })
      });
    })
  });
}

function projectPersona(value: unknown) {
  const persona = recordValue(value);
  return compactObject({
    id: optionalIdentityValue(persona.id),
    name: optionalIdentityValue(persona.name),
    soul: optionalBoundedText(persona.soul, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection),
    preference: optionalBoundedText(persona.preference, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection),
    user: optionalBoundedText(persona.user, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection),
    relation: optionalBoundedText(persona.relation, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection),
    air: optionalBoundedText(persona.air, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.personaSection)
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
  const longTerm = arrayValue(payload.longTermMemories);
  const ids = new Set(longTerm.map(memoryItemId));
  const longTermIds = new Set(longTerm.map(memoryItemId));
  payload.sourceMemoryIds = arrayValue(payload.sourceMemoryIds).filter((id) => typeof id === "string" && ids.has(id));
  payload.personaEvidenceIds = arrayValue(payload.personaEvidenceIds).filter((id) => typeof id === "string" && ids.has(id));
  payload.fieldKnowledgeEvidenceIds = arrayValue(payload.fieldKnowledgeEvidenceIds)
    .filter((id) => typeof id === "string" && ids.has(id));
  payload.recallStats = arrayValue(payload.recallStats).filter((item) => {
    const record = recordValue(item);
    return typeof record.recordId === "string" && longTermIds.has(record.recordId);
  });
}

function popMemory(payload: JsonRecord) {
  const longTerm = arrayValue(payload.longTermMemories);
  if (!longTerm.length) return false;
  longTerm.pop();
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

function boundedText(value: unknown, maxChars: number) {
  if (typeof value !== "string") return "";
  const text = redactSensitiveText(value.normalize("NFC").trim())
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\r\n?/gu, "\n");
  return [...text].slice(0, maxChars).join("");
}

function normalizedProjectionSourceText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\r\n?/gu, "\n");
}

function redactSensitiveText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, REDACTED_SECRET)
    .replace(/\b(?:(?:proxy-)?authorization\s*:\s*)?(?:basic|bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/giu, REDACTED_SECRET)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED_SECRET)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED_SECRET)
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][_A-Za-z0-9-]{8,}/gu, REDACTED_SECRET)
    .replace(/\b((?:(?:aws[_-]?)?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token))["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${REDACTED_SECRET}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${REDACTED_SECRET}`)
    .replace(/([?&](?:x-amz-(?:algorithm|credential|date|expires|signedheaders|security-token|signature)|x-goog-(?:algorithm|credential|date|expires|signedheaders|signature)|awsaccesskeyid|googleaccessid|key-pair-id|api[_-]?key|access[_-]?token|key|token|secret|password|policy|signature|expires|sig)=)[^&#\s]+/giu, `$1${REDACTED_SECRET}`)
    .replace(/(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/giu, `$1${REDACTED_SECRET}@`)
    .replace(/(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/gu, REDACTED_SECRET)
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
  const text = redactSensitiveText(String(value).normalize("NFC").trim())
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
  return text ? [...text].slice(0, DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.opaqueId).join("") : undefined;
}

function boundedRequiredText(value: unknown, field: string, maxChars: number) {
  const text = boundedText(value, maxChars);
  if (!text) throw new Error(`${field} must be a non-empty string.`);
  return text;
}

function optionalBoundedText(value: unknown, maxChars: number) {
  const text = boundedText(value, maxChars);
  return text || undefined;
}

function nullableBoundedText(value: unknown, maxChars: number) {
  if (value == null) return null;
  return optionalBoundedText(value, maxChars) ?? null;
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
