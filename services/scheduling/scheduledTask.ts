import {
  normalizeIsoTimestamp,
  normalizeScheduledTaskSchedule,
  type ScheduledTaskSchedule
} from "./schedule.js";

export const MAX_SCHEDULED_TASK_TARGETS = 20;
export const MAX_SCHEDULED_TASK_MENTIONS = 20;
export const MAX_SCHEDULED_TASK_CONTEXT_LENGTH = 32_768;
export const MAX_SCHEDULED_TASK_RESULT_LENGTH = 65_536;
export const DIRECTOR_SCHEDULED_TASK_ID_PREFIX = "director-";

const MAX_TASK_NAME_LENGTH = 120;
const MAX_TASK_ID_LENGTH = 128;
const MAX_WORKER_ID_LENGTH = 128;
const CONVERSATION_ID = /^(?:account:([A-Za-z0-9_-]{1,64}):)?(private|group):([1-9]\d*)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WORKER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

export interface ScheduledTaskTarget {
  conversationId: string;
  mentionUserIds: string[];
}

export interface ScheduledTaskDraft {
  name: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  context: string;
  targets: ScheduledTaskTarget[];
}

export interface ScheduledTask extends ScheduledTaskDraft {
  id: string;
  revision: number;
  permanentRetention: boolean;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  name: string;
  schedule: ScheduledTaskSchedule;
  context: string;
  targets: ScheduledTaskTarget[];
}

export type ScheduledTaskRunStatus = "pending" | "running" | "generated" | "completed" | "failed";

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  taskRevision: number;
  scheduledFor: string;
  status: ScheduledTaskRunStatus;
  snapshot: ScheduledTaskSnapshot;
  resultText: string | null;
  errorText: string | null;
  attempts: number;
  workerId: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  completedAt: string | null;
}

export interface ScheduledTaskValidationOptions {
  isAllowedConversationId?: (conversationId: string) => boolean;
}

export function normalizeScheduledTaskDraft(
  value: ScheduledTaskDraft,
  options: ScheduledTaskValidationOptions = {}
): ScheduledTaskDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled task input must be an object.");
  }
  return {
    name: boundedText(value.name, "name", MAX_TASK_NAME_LENGTH),
    enabled: requiredBoolean(value.enabled, "enabled"),
    schedule: normalizeScheduledTaskSchedule(value.schedule),
    context: boundedContext(value.context),
    targets: normalizeScheduledTaskTargets(value.targets, options)
  };
}

export function normalizeScheduledTaskTargets(
  value: unknown,
  options: ScheduledTaskValidationOptions = {}
): ScheduledTaskTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCHEDULED_TASK_TARGETS) {
    throw new Error(`targets must contain between 1 and ${MAX_SCHEDULED_TASK_TARGETS} conversations.`);
  }
  const targets = new Map<string, { scope: "private" | "group"; mentions: string[]; seen: Set<string> }>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each target must be an object.");
    const parsed = normalizeConversationId(raw.conversationId);
    if (options.isAllowedConversationId && !options.isAllowedConversationId(parsed.id)) {
      throw new Error(`Target conversation does not exist: ${parsed.id}`);
    }
    if (!Array.isArray(raw.mentionUserIds) || raw.mentionUserIds.length > MAX_SCHEDULED_TASK_MENTIONS) {
      throw new Error(`mentionUserIds must contain at most ${MAX_SCHEDULED_TASK_MENTIONS} QQ user IDs.`);
    }
    let target = targets.get(parsed.id);
    if (!target) {
      target = { scope: parsed.scope, mentions: [], seen: new Set<string>() };
      targets.set(parsed.id, target);
    }
    for (const userId of raw.mentionUserIds) {
      const normalized = normalizeQqUserId(userId);
      if (!target.seen.has(normalized)) {
        if (target.mentions.length >= MAX_SCHEDULED_TASK_MENTIONS) {
          throw new Error(`A target may contain at most ${MAX_SCHEDULED_TASK_MENTIONS} unique QQ user IDs.`);
        }
        target.seen.add(normalized);
        target.mentions.push(normalized);
      }
    }
  }
  return [...targets.entries()].map(([conversationId, target]) => {
    if (target.scope === "private" && target.mentions.length) {
      throw new Error(`Private target ${conversationId} cannot contain mentionUserIds.`);
    }
    return { conversationId, mentionUserIds: target.mentions };
  });
}

export function normalizeScheduledTaskId(value: string, field = "taskId") {
  return identifier(value, field, MAX_TASK_ID_LENGTH);
}

export function isDirectorScheduledTaskId(value: string) {
  return typeof value === "string" && value.startsWith(DIRECTOR_SCHEDULED_TASK_ID_PREFIX);
}

export function normalizeScheduledTaskWorkerId(value: string) {
  if (typeof value !== "string") throw new Error("workerId is invalid.");
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_WORKER_ID_LENGTH || !WORKER_IDENTIFIER.test(normalized)) {
    throw new Error("workerId is invalid.");
  }
  return normalized;
}

export function normalizeScheduledTaskResult(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SCHEDULED_TASK_RESULT_LENGTH) {
    throw new Error(`resultText must contain between 1 and ${MAX_SCHEDULED_TASK_RESULT_LENGTH} characters.`);
  }
  return value;
}

export function normalizeScheduledTaskError(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("errorText is required.");
  return value.length <= MAX_SCHEDULED_TASK_RESULT_LENGTH
    ? value
    : value.slice(0, MAX_SCHEDULED_TASK_RESULT_LENGTH);
}

export function scheduledTaskSnapshot(task: ScheduledTask): ScheduledTaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: normalizeScheduledTaskId(task.id),
    taskRevision: positiveInteger(task.revision, "task.revision"),
    name: boundedText(task.name, "task.name", MAX_TASK_NAME_LENGTH),
    schedule: normalizeScheduledTaskSchedule(task.schedule),
    context: boundedContext(task.context),
    targets: normalizeScheduledTaskTargets(task.targets)
  };
}

export function decodeScheduledTaskSnapshot(value: unknown): ScheduledTaskSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored scheduled task snapshot is invalid.");
  }
  const snapshot = value as Record<string, unknown>;
  const keys = Object.keys(snapshot).sort().join(",");
  if (keys !== "context,name,schedule,schemaVersion,targets,taskId,taskRevision" || snapshot.schemaVersion !== 1) {
    throw new Error("Stored scheduled task snapshot is invalid.");
  }
  return {
    schemaVersion: 1,
    taskId: normalizeScheduledTaskId(snapshot.taskId as string),
    taskRevision: positiveInteger(snapshot.taskRevision, "snapshot.taskRevision"),
    name: boundedText(snapshot.name, "snapshot.name", MAX_TASK_NAME_LENGTH),
    schedule: normalizeScheduledTaskSchedule(snapshot.schedule as ScheduledTaskSchedule),
    context: boundedContext(snapshot.context),
    targets: normalizeScheduledTaskTargets(snapshot.targets as ScheduledTaskTarget[])
  };
}

export function normalizeStoredTimestamp(value: unknown, field: string): string {
  return normalizeIsoTimestamp(String(value), field);
}

export function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer.`);
  return Number(value);
}

export function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer.`);
  return Number(value);
}

function normalizeConversationId(value: string) {
  if (typeof value !== "string") throw new Error("target.conversationId must be a full conversation ID.");
  const id = value.trim();
  const match = CONVERSATION_ID.exec(id);
  if (!match || !safePositiveDecimal(match[3]!)) {
    throw new Error("target.conversationId must be a full private or group conversation ID.");
  }
  return { id, scope: match[2] as "private" | "group" };
}

function normalizeQqUserId(value: string) {
  if (typeof value !== "string") throw new Error("mentionUserIds must contain positive QQ user IDs.");
  const id = value.trim();
  if (!safePositiveDecimal(id)) throw new Error("mentionUserIds must contain positive QQ user IDs.");
  return id;
}

function safePositiveDecimal(value: string) {
  if (!POSITIVE_DECIMAL.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function identifier(value: string, field: string, maxLength: number) {
  if (typeof value !== "string") throw new Error(`${field} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !IDENTIFIER.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

function boundedText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`${field} is invalid.`);
  return text;
}

function boundedContext(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_SCHEDULED_TASK_CONTEXT_LENGTH) {
    throw new Error(`context must contain at most ${MAX_SCHEDULED_TASK_CONTEXT_LENGTH} characters.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}
