import { CronExpressionParser } from "cron-parser";
import { normalizeIanaTimezone, normalizeIsoTimestamp } from "../../scheduling/public.js";
import type { DreamRunScheduleInput, DreamScheduleOccurrence } from "./types.js";

export const DREAM_SCHEDULE_CRON = "0 4 * * *";
const SCHEDULED_TRIGGER_WINDOW_MS = 60 * 1_000;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function dreamSystemTimeZone() {
  return normalizeIanaTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

export function latestDreamScheduleOccurrence(
  input: Omit<DreamRunScheduleInput, "existingLocalDates"> = {}
): DreamScheduleOccurrence {
  const now = dateValue(input.now ?? new Date());
  const timeZone = normalizeIanaTimezone(input.timeZone ?? dreamSystemTimeZone());
  const scheduled = CronExpressionParser.parse(DREAM_SCHEDULE_CRON, {
    currentDate: new Date(now.getTime() + 1),
    tz: timeZone
  }).prev().toDate();
  return {
    localDate: dreamLocalDate(scheduled, timeZone),
    scheduledAt: scheduled.toISOString(),
    timeZone,
    trigger: now.getTime() - scheduled.getTime() < SCHEDULED_TRIGGER_WINDOW_MS ? "scheduled" : "catch_up"
  };
}

export function dreamLocalDate(value: Date, timeZone = dreamSystemTimeZone()) {
  const date = dateValue(value);
  const normalizedTimeZone = normalizeIanaTimezone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function resolveDueDreamRun(input: DreamRunScheduleInput = {}): DreamScheduleOccurrence | null {
  const occurrence = latestDreamScheduleOccurrence(input);
  const existingLocalDates = input.existingLocalDates ?? [];
  for (const value of existingLocalDates) validateLocalDate(value);
  return new Set(existingLocalDates).has(occurrence.localDate) ? null : occurrence;
}

function validateLocalDate(value: string) {
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
    throw new Error("existingLocalDates must contain calendar dates.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("existingLocalDates must contain calendar dates.");
  }
}

function dateValue(value: Date | string) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(normalizeIsoTimestamp(value, "now"));
  if (!Number.isFinite(date.getTime())) throw new Error("now must be a valid date.");
  return date;
}
