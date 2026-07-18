import { CronExpressionParser } from "cron-parser";

export interface CronTaskSchedule {
  kind: "cron";
  expression: string;
  timezone: string;
}

export interface OnceTaskSchedule {
  kind: "once";
  runAt: string;
}

export type ScheduledTaskSchedule = CronTaskSchedule | OnceTaskSchedule;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CRON_EXPRESSION_LENGTH = 256;
const MAX_TIMEZONE_LENGTH = 128;

export function normalizeScheduledTaskSchedule(value: ScheduledTaskSchedule): ScheduledTaskSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled task schedule must be an object.");
  }
  if (value.kind === "cron") {
    const expression = normalizeCronExpression(value.expression);
    const timezone = normalizeIanaTimezone(value.timezone);
    assertCronCanAdvance(expression, timezone);
    return { kind: "cron", expression, timezone };
  }
  if (value.kind === "once") {
    return { kind: "once", runAt: normalizeIsoTimestamp(value.runAt, "schedule.runAt") };
  }
  throw new Error("Scheduled task schedule kind must be cron or once.");
}

export function firstScheduledAt(schedule: ScheduledTaskSchedule, now: Date | string): string {
  const normalized = normalizeScheduledTaskSchedule(schedule);
  const current = dateValue(now, "now");
  if (normalized.kind === "once") {
    if (Date.parse(normalized.runAt) <= current.getTime()) {
      throw new Error("One-time scheduled task runAt must be in the future.");
    }
    return normalized.runAt;
  }
  return nextCronAt(normalized, current);
}

export function nextScheduledAt(schedule: ScheduledTaskSchedule, after: Date | string): string | null {
  const normalized = normalizeScheduledTaskSchedule(schedule);
  if (normalized.kind === "once") return null;
  return nextCronAt(normalized, dateValue(after, "after"));
}

export function normalizeIsoTimestamp(value: string, field = "timestamp"): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value.trim())) {
    throw new Error(`${field} must be an ISO timestamp with an explicit timezone.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

export function normalizeIanaTimezone(value: string): string {
  if (typeof value !== "string") throw new Error("schedule.timezone must be an IANA timezone.");
  const timezone = value.trim();
  if (!timezone || timezone.length > MAX_TIMEZONE_LENGTH) {
    throw new Error("schedule.timezone must be an IANA timezone.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error("schedule.timezone must be an IANA timezone.");
  }
}

function normalizeCronExpression(value: string) {
  if (typeof value !== "string") throw new Error("schedule.expression must be a five-field cron expression.");
  const fields = value.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new Error("schedule.expression must contain exactly five cron fields.");
  const expression = fields.join(" ");
  if (expression.length > MAX_CRON_EXPRESSION_LENGTH) {
    throw new Error("schedule.expression is too long.");
  }
  return expression;
}

function assertCronCanAdvance(expression: string, timezone: string) {
  try {
    CronExpressionParser.parse(expression, {
      currentDate: new Date(0),
      tz: timezone
    }).next();
  } catch (error) {
    throw new Error(`schedule.expression is invalid: ${errorMessage(error)}`);
  }
}

function nextCronAt(schedule: CronTaskSchedule, after: Date) {
  try {
    return CronExpressionParser.parse(schedule.expression, {
      currentDate: after,
      tz: schedule.timezone
    }).next().toDate().toISOString();
  } catch (error) {
    throw new Error(`Unable to calculate the next cron occurrence: ${errorMessage(error)}`);
  }
}

function dateValue(value: Date | string, field: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(normalizeIsoTimestamp(value, field));
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date.`);
  return date;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
