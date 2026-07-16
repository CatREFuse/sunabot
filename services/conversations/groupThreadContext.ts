import { createHash } from "node:crypto";

export const GROUP_THREAD_STATE_SCHEMA_VERSION = 1 as const;
export const GROUP_THREAD_MODEL_OUTPUT_SCHEMA_VERSION = 1 as const;

export const GROUP_THREAD_STATUSES = ["active", "dormant", "closed"] as const;
export type GroupThreadStatus = typeof GROUP_THREAD_STATUSES[number];

export const GROUP_THREAD_RELATIONS = [
  "new",
  "continue",
  "reply",
  "switch",
  "bridge",
  "unresolved"
] as const;
export type GroupThreadRelation = typeof GROUP_THREAD_RELATIONS[number];

/**
 * The thread node accepts the complete ordered context record. It never mutates,
 * removes, or reorders these records; callers pass the same array on to the main model.
 */
export interface GroupThreadMessageRecord {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  sequence?: number;
  userId?: string | number;
  replyMessageIds?: readonly (string | number)[];
}

export interface GroupThreadV1 {
  threadId: string;
  topic: string;
  status: GroupThreadStatus;
  participantUids: string[];
  messageIds: string[];
  anchorMessageId: string;
  lastSequence: number;
}

export interface GroupThreadAssignmentV1 {
  messageId: string;
  sequence: number;
  primaryThreadId: string;
  relatedThreadIds: string[];
  relation: GroupThreadRelation;
  confidence: number;
}

export interface GroupThreadStateV1 {
  schemaVersion: 1;
  revision: number;
  processedThroughSequence: number;
  activeThreadId?: string;
  threads: GroupThreadV1[];
  assignments: GroupThreadAssignmentV1[];
}

export interface GroupThreadContextSnapshotV1 {
  schemaVersion: 1;
  revision: number;
  processedThroughSequence: number;
  activeThreadId?: string;
  omittedThreadCount?: number;
  threads: Array<{
    threadId: string;
    topic: string;
    status: GroupThreadStatus;
    participantUids: string[];
    omittedParticipantCount?: number;
    messageIds: string[];
    omittedMessageCount?: number;
  }>;
  messageAssignments: GroupThreadAssignmentV1[];
}

export interface GroupThreadRuleAssignment {
  messageId: string;
  sequence: number;
  primaryThreadId: string;
  relatedThreadIds: string[];
  relation: "reply" | "bridge";
  confidence: 1;
}

export interface GroupThreadContextError {
  code:
    | "input_invalid"
    | "state_invalid"
    | "model_required"
    | "model_output_invalid";
  message: string;
}

export interface GroupThreadRulePlan<TMessage extends GroupThreadMessageRecord = GroupThreadMessageRecord> {
  passthroughMessages: readonly TMessage[];
  previousState: GroupThreadStateV1;
  newMessages: readonly TMessage[];
  ruleAssignments: GroupThreadRuleAssignment[];
  deferredReplyMessageIds: string[];
  unresolvedMessageIds: string[];
  needsModel: boolean;
  error?: GroupThreadContextError;
}

export interface GroupThreadUpdateResult<TMessage extends GroupThreadMessageRecord = GroupThreadMessageRecord> {
  passthroughMessages: readonly TMessage[];
  state: GroupThreadStateV1;
  snapshot: GroupThreadContextSnapshotV1;
  changed: boolean;
  needsModel: boolean;
  ruleAssignments: GroupThreadRuleAssignment[];
  error?: GroupThreadContextError;
}

export interface GroupThreadModelCandidateV1 {
  threadKey: string;
  existingThreadId?: string;
  topic: string;
  status: GroupThreadStatus;
}

export interface GroupThreadModelAssignmentV1 {
  messageId: string;
  primaryThreadKey: string;
  relatedThreadKeys: string[];
  relation: GroupThreadRelation;
  confidence: number;
}

export interface GroupThreadModelOutputV1 {
  schemaVersion: 1;
  activeThreadKey: string | null;
  threads: GroupThreadModelCandidateV1[];
  messageAssignments: GroupThreadModelAssignmentV1[];
}

export type GroupThreadModelParseResult =
  | { ok: true; value: GroupThreadModelOutputV1 }
  | { ok: false; error: GroupThreadContextError };

export const GROUP_THREAD_MODEL_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "active_thread_key", "threads", "message_assignments"],
  properties: {
    schema_version: { const: 1 },
    active_thread_key: { type: ["string", "null"] },
    threads: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thread_key", "existing_thread_id", "topic", "status"],
        properties: {
          thread_key: { type: "string", minLength: 1, maxLength: 64 },
          existing_thread_id: { type: ["string", "null"] },
          topic: { type: "string", minLength: 8, maxLength: 160 },
          status: { type: "string", enum: GROUP_THREAD_STATUSES }
        }
      }
    },
    message_assignments: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "message_id",
          "primary_thread_key",
          "related_thread_keys",
          "relation",
          "confidence"
        ],
        properties: {
          message_id: { type: "string", minLength: 1 },
          primary_thread_key: { type: "string", minLength: 1, maxLength: 64 },
          related_thread_keys: {
            type: "array",
            maxItems: 2,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 64 }
          },
          relation: { type: "string", enum: GROUP_THREAD_RELATIONS },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
} as const;

export function createEmptyGroupThreadState(): GroupThreadStateV1 {
  return {
    schemaVersion: GROUP_THREAD_STATE_SCHEMA_VERSION,
    revision: 0,
    processedThroughSequence: 0,
    threads: [],
    assignments: []
  };
}

export function createDeterministicGroupThreadId(input: {
  conversationId: string;
  anchorMessageId: string;
  anchorSequence: number;
}) {
  const digest = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    conversationId: input.conversationId,
    anchorMessageId: input.anchorMessageId,
    anchorSequence: input.anchorSequence
  })).digest("hex");
  return `thread:${digest.slice(0, 32)}`;
}

export function isShortSentenceTopic(value: unknown): value is string {
  const topic = cleanText(value);
  const length = Array.from(topic).length;
  return length >= 8 && length <= 160 && !/[\r\n\u0000-\u001f\u007f]/u.test(topic);
}

export function retainGroupThreadStateMessageIndex(
  state: GroupThreadStateV1,
  retainedMessageIds: ReadonlySet<string>
): GroupThreadStateV1 {
  const retainedThreads = state.threads.filter((thread) => (
    thread.threadId === state.activeThreadId || thread.messageIds.some((messageId) => retainedMessageIds.has(messageId))
  ));
  const retainedThreadIds = new Set(retainedThreads.map((thread) => thread.threadId));
  return {
    ...state,
    threads: retainedThreads.map((thread) => ({
      ...thread,
      participantUids: thread.participantUids.slice(-256),
      messageIds: thread.messageIds.filter((messageId) => retainedMessageIds.has(messageId))
    })),
    assignments: state.assignments
      .filter((assignment) => retainedMessageIds.has(assignment.messageId)
        && retainedThreadIds.has(assignment.primaryThreadId)
        && assignment.relatedThreadIds.every((threadId) => retainedThreadIds.has(threadId)))
      .map(cloneAssignment)
  };
}

export function isGroupThreadStateV1(value: unknown): value is GroupThreadStateV1 {
  return !validateState(value as GroupThreadStateV1);
}

export function planGroupThreadContext<TMessage extends GroupThreadMessageRecord>(input: {
  messages: readonly TMessage[];
  previousState?: GroupThreadStateV1;
}): GroupThreadRulePlan<TMessage> {
  const previousState = input.previousState ?? createEmptyGroupThreadState();
  const failure = validatePlanInput(input.messages, previousState);
  if (failure) return failedPlan(input.messages, previousState, failure);

  const newMessages = input.messages.filter((message) => message.sequence! > previousState.processedThroughSequence);
  const knownAssignments = new Map(previousState.assignments.map((assignment) => [assignment.messageId, assignment]));
  const newMessageSequenceById = new Map(newMessages.map((message) => [message.id, message.sequence!]));
  const ruleAssignments: GroupThreadRuleAssignment[] = [];
  const deferredReplyMessageIds: string[] = [];
  const unresolvedMessageIds: string[] = [];

  for (const message of newMessages) {
    if (knownAssignments.has(message.id)) {
      return failedPlan(input.messages, previousState, error("input_invalid", `消息 ${message.id} 已存在于 thread 状态中。`));
    }
    const inherited = inheritedReplyAssignment(message, knownAssignments);
    if (!inherited) {
      const hasEarlierNewReplyTarget = (message.replyMessageIds ?? []).some((messageId) => {
        const targetSequence = newMessageSequenceById.get(cleanText(messageId));
        return targetSequence != null && targetSequence < message.sequence!;
      });
      if (hasEarlierNewReplyTarget) deferredReplyMessageIds.push(message.id);
      else unresolvedMessageIds.push(message.id);
      continue;
    }
    ruleAssignments.push(inherited);
    knownAssignments.set(message.id, inherited);
  }

  return {
    passthroughMessages: input.messages,
    previousState,
    newMessages,
    ruleAssignments,
    deferredReplyMessageIds,
    unresolvedMessageIds,
    needsModel: unresolvedMessageIds.length > 0
  };
}

export function parseGroupThreadModelOutput(value: unknown, input: {
  messages: readonly GroupThreadMessageRecord[];
  previousState?: GroupThreadStateV1;
  requiredMessageIds?: readonly string[];
}): GroupThreadModelParseResult {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parseFailure("模型返回的 thread JSON 无法解析。");
    }
  }
  const root = recordValue(parsed);
  if (!root || !hasExactKeys(root, ["schema_version", "active_thread_key", "threads", "message_assignments"])) {
    return parseFailure("模型返回的 thread 根结构无效。");
  }
  if (root.schema_version !== 1 || !Array.isArray(root.threads) || !Array.isArray(root.message_assignments)) {
    return parseFailure("模型返回的 thread schema 版本或数组字段无效。");
  }
  if (root.threads.length > 16 || root.message_assignments.length > 128) {
    return parseFailure("模型返回的 thread 数量超过限制。");
  }

  const previousState = input.previousState ?? createEmptyGroupThreadState();
  const knownThreadIds = new Set(previousState.threads.map((thread) => thread.threadId));
  const allowedMessageIds = new Set(input.messages.map((message) => cleanText(message.id)).filter(Boolean));
  const threadKeys = new Set<string>();
  const boundExistingThreadIds = new Set<string>();
  const threads: GroupThreadModelCandidateV1[] = [];

  for (const rawThread of root.threads) {
    const item = recordValue(rawThread);
    if (!item || !hasExactKeys(item, ["thread_key", "existing_thread_id", "topic", "status"])) {
      return parseFailure("模型返回的 thread 项结构无效。");
    }
    if (typeof item.thread_key !== "string" || (item.existing_thread_id != null && typeof item.existing_thread_id !== "string")
      || typeof item.topic !== "string") return parseFailure("模型返回的 thread 字段类型无效。");
    const threadKey = validThreadReference(item.thread_key);
    const existingThreadId = item.existing_thread_id == null ? undefined : cleanText(item.existing_thread_id);
    const topic = cleanText(item.topic);
    const status = enumValue(item.status, GROUP_THREAD_STATUSES);
    if (!threadKey || threadKeys.has(threadKey) || !status || !isShortSentenceTopic(topic)) {
      return parseFailure("模型返回的 thread key、topic 或 status 无效。");
    }
    if (existingThreadId && !knownThreadIds.has(existingThreadId)) {
      return parseFailure(`模型引用了未知的已有 thread：${existingThreadId}`);
    }
    if ((knownThreadIds.has(threadKey) && existingThreadId !== threadKey)
      || (existingThreadId && boundExistingThreadIds.has(existingThreadId))) {
      return parseFailure(`模型重复或冲突地绑定了已有 thread：${existingThreadId || threadKey}`);
    }
    threadKeys.add(threadKey);
    if (existingThreadId) boundExistingThreadIds.add(existingThreadId);
    threads.push({ threadKey, ...(existingThreadId ? { existingThreadId } : {}), topic, status });
  }

  const resolvableKeys = new Set([...knownThreadIds, ...threadKeys]);
  const assignments: GroupThreadModelAssignmentV1[] = [];
  const assignmentMessageIds = new Set<string>();
  for (const rawAssignment of root.message_assignments) {
    const item = recordValue(rawAssignment);
    if (!item || !hasExactKeys(item, [
      "message_id",
      "primary_thread_key",
      "related_thread_keys",
      "relation",
      "confidence"
    ]) || typeof item.message_id !== "string" || typeof item.primary_thread_key !== "string"
      || !Array.isArray(item.related_thread_keys) || typeof item.confidence !== "number") {
      return parseFailure("模型返回的 message_assignment 结构无效。");
    }

    const messageId = cleanText(item.message_id);
    const primaryThreadKey = validThreadReference(item.primary_thread_key);
    const relatedThreadKeys = stringArray(item.related_thread_keys);
    const relation = enumValue(item.relation, GROUP_THREAD_RELATIONS);
    const confidence = Number(item.confidence);
    if (!messageId || !allowedMessageIds.has(messageId) || assignmentMessageIds.has(messageId)) {
      return parseFailure(`模型引用了未知或重复的消息：${messageId || "(empty)"}`);
    }
    if (!primaryThreadKey || !resolvableKeys.has(primaryThreadKey) || !relation || !validConfidence(confidence)) {
      return parseFailure(`消息 ${messageId} 的 thread 归属字段无效。`);
    }
    if (relatedThreadKeys.length > 2 || new Set(relatedThreadKeys).size !== relatedThreadKeys.length
      || relatedThreadKeys.includes(primaryThreadKey)
      || relatedThreadKeys.some((key) => !validThreadReference(key) || !resolvableKeys.has(key))) {
      return parseFailure(`消息 ${messageId} 的 related thread 无效。`);
    }
    assignmentMessageIds.add(messageId);
    assignments.push({ messageId, primaryThreadKey, relatedThreadKeys, relation, confidence });
  }

  const requiredMessageIds = new Set(input.requiredMessageIds ?? input.messages.map((message) => message.id));
  if (assignmentMessageIds.size !== requiredMessageIds.size
    || [...requiredMessageIds].some((messageId) => !assignmentMessageIds.has(messageId))
    || [...assignmentMessageIds].some((messageId) => !requiredMessageIds.has(messageId))) {
    return parseFailure("模型没有覆盖全部待分类消息。");
  }

  for (const candidate of threads) {
    if (candidate.existingThreadId) continue;
    if (!assignments.some((assignment) => assignment.primaryThreadKey === candidate.threadKey)) {
      return parseFailure(`新 thread ${candidate.threadKey} 缺少主归属锚点。`);
    }
  }

  if (root.active_thread_key != null && typeof root.active_thread_key !== "string") {
    return parseFailure("模型返回的 active_thread_key 类型无效。");
  }
  const activeThreadKey = root.active_thread_key == null ? undefined : validThreadReference(root.active_thread_key);
  if (root.active_thread_key != null && (!activeThreadKey || !resolvableKeys.has(activeThreadKey))) {
    return parseFailure("模型返回的 active_thread_key 无效。");
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      activeThreadKey: activeThreadKey ?? null,
      threads,
      messageAssignments: assignments
    }
  };
}

export function applyGroupThreadContext<TMessage extends GroupThreadMessageRecord>(input: {
  conversationId: string;
  messages: readonly TMessage[];
  previousState?: GroupThreadStateV1;
  modelOutput?: unknown;
}): GroupThreadUpdateResult<TMessage> {
  const plan = planGroupThreadContext({ messages: input.messages, previousState: input.previousState });
  const unchanged = (failure?: GroupThreadContextError): GroupThreadUpdateResult<TMessage> => ({
    passthroughMessages: input.messages,
    state: plan.previousState,
    snapshot: toGroupThreadContextSnapshot(plan.previousState),
    changed: false,
    needsModel: plan.needsModel,
    ruleAssignments: plan.ruleAssignments,
    ...(failure ? { error: failure } : {})
  });
  if (plan.error) return unchanged(plan.error);
  if (!plan.newMessages.length) return unchanged();
  if (!cleanText(input.conversationId)) return unchanged(error("input_invalid", "conversationId 不能为空。"));

  let modelOutput: GroupThreadModelOutputV1 | undefined;
  if (plan.needsModel) {
    if (input.modelOutput == null) return unchanged(error("model_required", "存在无法通过引用规则归属的消息。"));
    const parsed = parseGroupThreadModelOutput(input.modelOutput, {
      messages: plan.newMessages,
      previousState: plan.previousState,
      requiredMessageIds: plan.unresolvedMessageIds
    });
    if (!parsed.ok) return unchanged(parsed.error);
    modelOutput = parsed.value;
  }

  try {
    const state = mergeThreadState(input.conversationId, plan, modelOutput);
    return {
      passthroughMessages: input.messages,
      state,
      snapshot: toGroupThreadContextSnapshot(state),
      changed: true,
      needsModel: false,
      ruleAssignments: plan.ruleAssignments
    };
  } catch (cause) {
    return unchanged(error("model_output_invalid", cause instanceof Error ? cause.message : String(cause)));
  }
}

export function toGroupThreadContextSnapshot(state: GroupThreadStateV1): GroupThreadContextSnapshotV1 {
  return {
    schemaVersion: 1,
    revision: state.revision,
    processedThroughSequence: state.processedThroughSequence,
    ...(state.activeThreadId ? { activeThreadId: state.activeThreadId } : {}),
    threads: state.threads.map((thread) => ({
      threadId: thread.threadId,
      topic: thread.topic,
      status: thread.status,
      participantUids: [...thread.participantUids],
      messageIds: [...thread.messageIds]
    })),
    messageAssignments: state.assignments.map(cloneAssignment)
  };
}

function mergeThreadState<TMessage extends GroupThreadMessageRecord>(
  conversationId: string,
  plan: GroupThreadRulePlan<TMessage>,
  modelOutput: GroupThreadModelOutputV1 | undefined
): GroupThreadStateV1 {
  const messagesById = new Map(plan.newMessages.map((message) => [message.id, message]));
  const keyToThreadId = new Map(plan.previousState.threads.map((thread) => [thread.threadId, thread.threadId]));
  const modelAssignments = new Map(modelOutput?.messageAssignments.map((assignment) => [assignment.messageId, assignment]) ?? []);

  for (const candidate of modelOutput?.threads ?? []) {
    if (candidate.existingThreadId) {
      keyToThreadId.set(candidate.threadKey, candidate.existingThreadId);
      continue;
    }
    const anchor = plan.newMessages.find((message) => modelAssignments.get(message.id)?.primaryThreadKey === candidate.threadKey);
    if (!anchor) throw new Error(`新 thread ${candidate.threadKey} 缺少有效锚点。`);
    keyToThreadId.set(candidate.threadKey, createDeterministicGroupThreadId({
      conversationId,
      anchorMessageId: anchor.id,
      anchorSequence: anchor.sequence!
    }));
  }

  const provisional = new Map<string, GroupThreadAssignmentV1>(plan.previousState.assignments.map((item) => [item.messageId, item]));
  for (const assignment of modelOutput?.messageAssignments ?? []) {
    provisional.set(assignment.messageId, resolveModelAssignment(assignment, messagesById, keyToThreadId));
  }
  for (const assignment of plan.ruleAssignments) provisional.set(assignment.messageId, cloneAssignment(assignment));

  const finalAssignments: GroupThreadAssignmentV1[] = [];
  for (const message of plan.newMessages) {
    const inherited = inheritedReplyAssignment(message, provisional);
    const assignment = inherited ?? provisional.get(message.id);
    if (!assignment) throw new Error(`消息 ${message.id} 没有有效 thread 归属。`);
    finalAssignments.push(cloneAssignment(assignment));
    provisional.set(message.id, assignment);
  }

  const referencedThreadIds = new Set(finalAssignments.flatMap((assignment) => [
    assignment.primaryThreadId,
    ...assignment.relatedThreadIds
  ]));
  const threads = plan.previousState.threads.map(cloneThread);
  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));

  for (const candidate of modelOutput?.threads ?? []) {
    const threadId = keyToThreadId.get(candidate.threadKey)!;
    const existing = threadById.get(threadId);
    if (existing) {
      existing.topic = candidate.topic;
      existing.status = referencedThreadIds.has(threadId) ? "active" : candidate.status;
      continue;
    }
    if (!referencedThreadIds.has(threadId)) continue;
    const anchor = finalAssignments.find((assignment) => assignment.primaryThreadId === threadId);
    if (!anchor) continue;
    const created: GroupThreadV1 = {
      threadId,
      topic: candidate.topic,
      status: "active",
      participantUids: [],
      messageIds: [],
      anchorMessageId: anchor.messageId,
      lastSequence: anchor.sequence
    };
    threads.push(created);
    threadById.set(threadId, created);
  }

  for (const assignment of finalAssignments) {
    const message = messagesById.get(assignment.messageId)!;
    for (const threadId of [assignment.primaryThreadId, ...assignment.relatedThreadIds]) {
      const thread = threadById.get(threadId);
      if (!thread) throw new Error(`消息 ${assignment.messageId} 引用了不存在的 thread。`);
      thread.status = "active";
      appendUnique(thread.messageIds, assignment.messageId);
      const uid = message.role === "user" ? cleanText(message.userId) : "";
      if (uid) {
        appendUnique(thread.participantUids, uid);
        if (thread.participantUids.length > 256) {
          thread.participantUids.splice(0, thread.participantUids.length - 256);
        }
      }
      thread.lastSequence = Math.max(thread.lastSequence, assignment.sequence);
    }
  }

  const activeThreadId = modelOutput
    ? modelOutput.activeThreadKey == null
      ? undefined
      : keyToThreadId.get(modelOutput.activeThreadKey)
    : finalAssignments.at(-1)?.primaryThreadId ?? plan.previousState.activeThreadId;
  if (modelOutput?.activeThreadKey && !activeThreadId) {
    throw new Error(`active thread ${modelOutput.activeThreadKey} 无法解析。`);
  }
  if (activeThreadId) {
    const activeThread = threadById.get(activeThreadId);
    if (!activeThread) throw new Error(`active thread ${activeThreadId} 不存在。`);
    activeThread.status = "active";
  }
  return {
    schemaVersion: 1,
    revision: plan.previousState.revision + 1,
    processedThroughSequence: plan.newMessages.at(-1)!.sequence!,
    ...(activeThreadId ? { activeThreadId } : {}),
    threads,
    assignments: [...plan.previousState.assignments.map(cloneAssignment), ...finalAssignments]
  };
}

function resolveModelAssignment(
  assignment: GroupThreadModelAssignmentV1,
  messagesById: ReadonlyMap<string, GroupThreadMessageRecord>,
  keyToThreadId: ReadonlyMap<string, string>
): GroupThreadAssignmentV1 {
  const message = messagesById.get(assignment.messageId);
  const primaryThreadId = keyToThreadId.get(assignment.primaryThreadKey);
  const relatedThreadIds = assignment.relatedThreadKeys.map((key) => keyToThreadId.get(key));
  if (!message || !primaryThreadId || relatedThreadIds.some((threadId) => !threadId)) {
    throw new Error(`消息 ${assignment.messageId} 的 thread 引用无法解析。`);
  }
  const resolvedRelatedThreadIds = relatedThreadIds as string[];
  if (resolvedRelatedThreadIds.includes(primaryThreadId)
    || new Set(resolvedRelatedThreadIds).size !== resolvedRelatedThreadIds.length) {
    throw new Error(`消息 ${assignment.messageId} 的 thread 引用在解析后重复。`);
  }
  return {
    messageId: assignment.messageId,
    sequence: message.sequence!,
    primaryThreadId,
    relatedThreadIds: resolvedRelatedThreadIds,
    relation: assignment.relation,
    confidence: assignment.confidence
  };
}

function inheritedReplyAssignment(
  message: GroupThreadMessageRecord,
  knownAssignments: ReadonlyMap<string, Pick<GroupThreadAssignmentV1, "primaryThreadId" | "sequence">>
): GroupThreadRuleAssignment | undefined {
  const inheritedThreadIds = uniqueStrings((message.replyMessageIds ?? [])
    .map((messageId) => knownAssignments.get(cleanText(messageId)))
    .filter((assignment) => assignment && assignment.sequence < message.sequence!)
    .map((assignment) => assignment!.primaryThreadId)
    .filter((threadId): threadId is string => Boolean(threadId)));
  if (!inheritedThreadIds.length) return undefined;
  return {
    messageId: message.id,
    sequence: message.sequence!,
    primaryThreadId: inheritedThreadIds[0]!,
    relatedThreadIds: inheritedThreadIds.slice(1, 3),
    relation: inheritedThreadIds.length > 1 ? "bridge" : "reply",
    confidence: 1
  };
}

function validatePlanInput(messages: readonly GroupThreadMessageRecord[], state: GroupThreadStateV1) {
  const stateFailure = validateState(state);
  if (stateFailure) return stateFailure;
  const seen = new Set<string>();
  let previousSequence = 0;
  for (const message of messages) {
    const id = cleanText(message.id);
    const sequence = message.sequence;
    if (!id || seen.has(id) || !Number.isSafeInteger(sequence) || sequence! <= 0 || sequence! <= previousSequence) {
      return error("input_invalid", "群聊消息必须包含唯一 ID 和严格递增的正整数 sequence。" );
    }
    seen.add(id);
    previousSequence = sequence!;
  }
  return undefined;
}

function validateState(state: GroupThreadStateV1): GroupThreadContextError | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.processedThroughSequence) || state.processedThroughSequence < 0
    || !Array.isArray(state.threads) || !Array.isArray(state.assignments)) {
    return error("state_invalid", "Group thread state 版本或游标无效。");
  }
  const threadIds = new Set<string>();
  for (const thread of state.threads) {
    if (!thread || typeof thread !== "object" || !/^thread:[a-f0-9]{32}$/.test(thread.threadId)
      || threadIds.has(thread.threadId)
      || !isShortSentenceTopic(thread.topic) || !enumValue(thread.status, GROUP_THREAD_STATUSES)
      || !Array.isArray(thread.participantUids) || thread.participantUids.some((uid) => !cleanText(uid))
      || !Array.isArray(thread.messageIds) || thread.messageIds.some((messageId) => !cleanText(messageId))
      || new Set(thread.participantUids).size !== thread.participantUids.length
      || new Set(thread.messageIds).size !== thread.messageIds.length
      || !cleanText(thread.anchorMessageId) || !Number.isSafeInteger(thread.lastSequence) || thread.lastSequence <= 0) {
      return error("state_invalid", "Group thread state 中存在无效 thread。" );
    }
    threadIds.add(thread.threadId);
  }
  if (state.activeThreadId && !threadIds.has(state.activeThreadId)) {
    return error("state_invalid", "Group thread state 的 activeThreadId 不存在。" );
  }
  if (state.activeThreadId && state.threads.find((thread) => thread.threadId === state.activeThreadId)?.status !== "active") {
    return error("state_invalid", "Group thread state 的 activeThreadId 必须指向 active thread。" );
  }
  const messageIds = new Set<string>();
  for (const assignment of state.assignments) {
    if (!assignment || typeof assignment !== "object" || !cleanText(assignment.messageId)
      || messageIds.has(assignment.messageId)
      || !Number.isSafeInteger(assignment.sequence) || assignment.sequence <= 0
      || !threadIds.has(assignment.primaryThreadId)
      || !Array.isArray(assignment.relatedThreadIds)
      || assignment.relatedThreadIds.length > 2
      || new Set(assignment.relatedThreadIds).size !== assignment.relatedThreadIds.length
      || assignment.relatedThreadIds.some((threadId) => !threadIds.has(threadId) || threadId === assignment.primaryThreadId)
      || !enumValue(assignment.relation, GROUP_THREAD_RELATIONS)
      || !validConfidence(assignment.confidence)) {
      return error("state_invalid", "Group thread state 中存在无效消息归属。" );
    }
    messageIds.add(assignment.messageId);
  }
  return undefined;
}

function failedPlan<TMessage extends GroupThreadMessageRecord>(
  messages: readonly TMessage[],
  previousState: GroupThreadStateV1,
  failure: GroupThreadContextError
): GroupThreadRulePlan<TMessage> {
  return {
    passthroughMessages: messages,
    previousState,
    newMessages: [],
    ruleAssignments: [],
    deferredReplyMessageIds: [],
    unresolvedMessageIds: [],
    needsModel: false,
    error: failure
  };
}

function parseFailure(message: string): GroupThreadModelParseResult {
  return { ok: false, error: error("model_output_invalid", message) };
}

function error(code: GroupThreadContextError["code"], message: string): GroupThreadContextError {
  return { code, message };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function validThreadReference(value: unknown) {
  const reference = cleanText(value);
  return /^[A-Za-z0-9._:-]{1,64}$/.test(reference) ? reference : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function enumValue<const TValues extends readonly string[]>(value: unknown, values: TValues): TValues[number] | undefined {
  return typeof value === "string" && values.includes(value) ? value as TValues[number] : undefined;
}

function validConfidence(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function appendUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function cloneThread(thread: GroupThreadV1): GroupThreadV1 {
  return {
    ...thread,
    participantUids: [...thread.participantUids],
    messageIds: [...thread.messageIds]
  };
}

function cloneAssignment<T extends Pick<GroupThreadAssignmentV1,
  "messageId" | "sequence" | "primaryThreadId" | "relatedThreadIds" | "relation" | "confidence"
>>(assignment: T): GroupThreadAssignmentV1 {
  return { ...assignment, relatedThreadIds: [...assignment.relatedThreadIds] };
}
