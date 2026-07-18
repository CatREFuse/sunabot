import type {
  CreateScheduledTaskInput,
  ScheduledTaskSchedule,
  ScheduledTaskTarget,
  UpdateScheduledTaskInput
} from "../scheduling/public.js";

export const CRON_TOOL_NAME = "cron";
export const CRON_TOOL_OPERATIONS = ["create", "get", "list", "update", "delete"] as const;

export type CronToolOperation = (typeof CRON_TOOL_OPERATIONS)[number];

export interface CronToolInput {
  operation: CronToolOperation;
  taskId: string | null;
  revision: number | null;
  name: string | null;
  enabled: boolean | null;
  schedule: ScheduledTaskSchedule | null;
  context: string | null;
  targets: ScheduledTaskTarget[] | null;
}

export interface CronToolPort {
  execute(input: CronToolInput): Promise<unknown>;
}

export const cronTool = {
  type: "function",
  name: CRON_TOOL_NAME,
  description: [
    "Create, read, list, update, or delete proactive scheduled tasks for the current Agent.",
    "This single tool is available only to the administrator in a private chat or administrator Web Chat.",
    "A task runs one Agent callback and fans the same final reply out to every target conversation.",
    "Use conversationId current for the current OneBot conversation, or an existing full conversation ID.",
    "Use a standard five-field crontab expression and IANA time zone for recurring schedules, or an ISO 8601 runAt for a one-time schedule.",
    "For unused fields pass null. Read a task before update or delete and provide its current revision."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: CRON_TOOL_OPERATIONS },
      taskId: { type: ["string", "null"], maxLength: 80 },
      revision: { type: ["integer", "null"], minimum: 1 },
      name: { type: ["string", "null"], maxLength: 120 },
      enabled: { type: ["boolean", "null"] },
      schedule: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { const: "cron" },
              expression: { type: "string", minLength: 1, maxLength: 120 },
              timezone: { type: "string", minLength: 1, maxLength: 80 }
            },
            required: ["kind", "expression", "timezone"]
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { const: "once" },
              runAt: { type: "string", minLength: 1, maxLength: 80 }
            },
            required: ["kind", "runAt"]
          },
          { type: "null" }
        ]
      },
      context: { type: ["string", "null"], maxLength: 32768 },
      targets: {
        anyOf: [
          {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                conversationId: { type: "string", minLength: 1, maxLength: 160 },
                mentionUserIds: {
                  type: "array",
                  maxItems: 20,
                  uniqueItems: true,
                  items: { type: "string", pattern: "^[1-9][0-9]{0,19}$" }
                }
              },
              required: ["conversationId", "mentionUserIds"]
            }
          },
          { type: "null" }
        ]
      }
    },
    required: ["operation", "taskId", "revision", "name", "enabled", "schedule", "context", "targets"]
  },
  strict: true
} as const;

export async function runCronTool(input: unknown, port: CronToolPort) {
  const parsed = parseCronToolInput(input);
  if (!parsed.ok) return parsed;
  return port.execute(parsed.input);
}

export function parseCronToolInput(input: unknown):
  | { ok: true; input: CronToolInput }
  | { ok: false; code: "CRON_INVALID"; error: string; field?: string } {
  if (!isRecord(input)) return invalid("Cron arguments must be an object.");
  const allowed = new Set(["operation", "taskId", "revision", "name", "enabled", "schedule", "context", "targets"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) return invalid("Unsupported cron argument.", extra);
  if (!CRON_TOOL_OPERATIONS.includes(input.operation as CronToolOperation)) {
    return invalid("Unsupported cron operation.", "operation");
  }
  const taskId = nullableText(input.taskId, 80);
  if (taskId === undefined) return invalid("taskId must be a string or null.", "taskId");
  const revision = input.revision === null
    ? null
    : Number.isSafeInteger(input.revision) && Number(input.revision) >= 1
      ? Number(input.revision)
      : undefined;
  if (revision === undefined) return invalid("revision must be a positive integer or null.", "revision");
  const name = nullableText(input.name, 120);
  if (name === undefined) return invalid("name must be a string or null.", "name");
  if (input.enabled !== null && typeof input.enabled !== "boolean") {
    return invalid("enabled must be a boolean or null.", "enabled");
  }
  const context = nullableText(input.context, 32_768, true);
  if (context === undefined) return invalid("context must be a string or null.", "context");
  const schedule = parseSchedule(input.schedule);
  if (!schedule.ok) return invalid(schedule.error, "schedule");
  const targets = parseTargets(input.targets);
  if (!targets.ok) return invalid(targets.error, "targets");

  const parsed: CronToolInput = {
    operation: input.operation as CronToolOperation,
    taskId,
    revision,
    name,
    enabled: input.enabled as boolean | null,
    schedule: schedule.value,
    context,
    targets: targets.value
  };
  const shapeError = validateOperationShape(parsed);
  return shapeError ?? { ok: true, input: parsed };
}

export function cronCreateInput(input: CronToolInput): CreateScheduledTaskInput {
  if (input.operation !== "create" || input.name == null || input.schedule == null ||
      input.context == null || input.targets == null) {
    throw new Error("Cron create input is incomplete.");
  }
  return {
    name: input.name,
    enabled: input.enabled ?? true,
    schedule: input.schedule,
    context: input.context,
    targets: input.targets
  };
}

export function cronUpdateInput(input: CronToolInput): UpdateScheduledTaskInput {
  if (input.operation !== "update" || input.taskId == null || input.revision == null) {
    throw new Error("Cron update input is incomplete.");
  }
  return {
    id: input.taskId,
    expectedRevision: input.revision,
    ...(input.name == null ? {} : { name: input.name }),
    ...(input.enabled == null ? {} : { enabled: input.enabled }),
    ...(input.schedule == null ? {} : { schedule: input.schedule }),
    ...(input.context == null ? {} : { context: input.context }),
    ...(input.targets == null ? {} : { targets: input.targets })
  };
}

function validateOperationShape(input: CronToolInput) {
  const noMutation = input.name === null && input.enabled === null && input.schedule === null &&
    input.context === null && input.targets === null;
  if (input.operation === "list") {
    return input.taskId === null && input.revision === null && noMutation
      ? undefined
      : invalid("list does not accept task fields.", "operation");
  }
  if (input.operation === "get") {
    return input.taskId !== null && input.revision === null && noMutation
      ? undefined
      : invalid("get requires taskId only.", "operation");
  }
  if (input.operation === "delete") {
    return input.taskId !== null && input.revision !== null && noMutation
      ? undefined
      : invalid("delete requires taskId and revision only.", "operation");
  }
  if (input.operation === "create") {
    return input.taskId === null && input.revision === null && input.name !== null &&
      input.schedule !== null && input.context !== null && input.targets !== null
      ? undefined
      : invalid("create requires name, schedule, context, and targets.", "operation");
  }
  const changed = input.name !== null || input.enabled !== null || input.schedule !== null ||
    input.context !== null || input.targets !== null;
  return input.taskId !== null && input.revision !== null && changed
    ? undefined
    : invalid("update requires taskId, revision, and at least one changed field.", "operation");
}

function parseSchedule(value: unknown): { ok: true; value: ScheduledTaskSchedule | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: "schedule must be an object or null." };
  if (value.kind === "cron") {
    if (Object.keys(value).some((key) => !["kind", "expression", "timezone"].includes(key)) ||
        typeof value.expression !== "string" || !value.expression.trim() || value.expression.length > 120 ||
        typeof value.timezone !== "string" || !value.timezone.trim() || value.timezone.length > 80) {
      return { ok: false, error: "A cron schedule requires expression and timezone only." };
    }
    return { ok: true, value: { kind: "cron", expression: value.expression.trim(), timezone: value.timezone.trim() } };
  }
  if (value.kind === "once") {
    if (Object.keys(value).some((key) => !["kind", "runAt"].includes(key)) ||
        typeof value.runAt !== "string" || !value.runAt.trim() || value.runAt.length > 80) {
      return { ok: false, error: "A one-time schedule requires runAt only." };
    }
    return { ok: true, value: { kind: "once", runAt: value.runAt.trim() } };
  }
  return { ok: false, error: "Unsupported schedule kind." };
}

function parseTargets(value: unknown): { ok: true; value: ScheduledTaskTarget[] | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return { ok: false, error: "targets must contain 1 to 20 conversations." };
  }
  const targets: ScheduledTaskTarget[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || Object.keys(item).some((key) => !["conversationId", "mentionUserIds"].includes(key)) ||
        typeof item.conversationId !== "string" || !item.conversationId.trim() ||
        item.conversationId.length > 160 || !Array.isArray(item.mentionUserIds) ||
        item.mentionUserIds.length > 20) {
      return { ok: false, error: `targets[${index}] is invalid.` };
    }
    const mentionUserIds = item.mentionUserIds.map((id) => String(id).trim());
    if (mentionUserIds.some((id) => !/^[1-9]\d{0,19}$/.test(id)) ||
        new Set(mentionUserIds).size !== mentionUserIds.length) {
      return { ok: false, error: `targets[${index}].mentionUserIds is invalid.` };
    }
    targets.push({ conversationId: item.conversationId.trim(), mentionUserIds });
  }
  if (new Set(targets.map((target) => target.conversationId)).size !== targets.length) {
    return { ok: false, error: "Target conversations must be unique." };
  }
  return { ok: true, value: targets };
}

function nullableText(value: unknown, maxLength: number, allowBlank = false) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const normalized = value.trim();
  return normalized || allowBlank ? normalized : undefined;
}

function invalid(error: string, field?: string) {
  return { ok: false as const, code: "CRON_INVALID" as const, error, ...(field ? { field } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
