import type {
  DirectorScheduleDraftV1,
  DirectorScheduleItemV1,
  DirectorScheduleShareV1,
  DirectorScheduleV1
} from "./types.js";
import { modelContentText, parseModelJson } from "../../packages/contracts/model/modelContent.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseDirectorScheduleDraft(
  text: string,
  expected: { date: string; timeZone: string }
): DirectorScheduleDraftV1 {
  return normalizeDirectorScheduleDraft(parseModelJson(text), expected);
}

export function normalizeDirectorScheduleDraft(
  value: unknown,
  expected: { date: string; timeZone: string }
): DirectorScheduleDraftV1 {
  return normalizeDirectorSchedule(value, expected);
}

function normalizeDirectorSchedule(
  value: unknown,
  expected: { date: string; timeZone: string }
): DirectorScheduleDraftV1 {
  const record = strictRecord(value, "Director schedule must be an object.");
  const date = requiredDate(record.date, "date");
  const timeZone = requiredText(record.timeZone, "timeZone");
  if (date !== expected.date) throw new Error(`Director schedule date must be ${expected.date}.`);
  if (timeZone !== expected.timeZone) {
    throw new Error(`Director schedule timeZone must be ${expected.timeZone}.`);
  }
  if (!Array.isArray(record.items)) {
    throw new Error("Director schedule items must be an array.");
  }
  const items = record.items.map((item, index) => normalizeItem(item, index, { date, timeZone }))
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) throw new Error("Director schedule item ids must be unique.");
  for (let index = 1; index < items.length; index += 1) {
    if (Date.parse(items[index - 1]!.endAt) > Date.parse(items[index]!.startAt)) {
      throw new Error("Director schedule items must not overlap.");
    }
  }
  return {
    schemaVersion: 1,
    date,
    timeZone,
    theme: requiredText(record.theme, "theme"),
    summary: requiredText(record.summary, "summary"),
    items
  };
}

export function isDirectorSchedule(value: unknown): value is DirectorScheduleV1 {
  try {
    const record = strictRecord(value, "Director schedule must be an object.");
    const source = record.source;
    if (source !== "daily_plan" && source !== "character_revision") return false;
    const draftValue = {
      schemaVersion: record.schemaVersion,
      date: record.date,
      timeZone: record.timeZone,
      theme: record.theme,
      summary: record.summary,
      items: record.items
    };
    const draft = normalizeDirectorSchedule(draftValue, {
      date: requiredDate(record.date, "date"),
      timeZone: requiredText(record.timeZone, "timeZone")
    });
    return Boolean(
      draft
      && Number.isSafeInteger(record.revision)
      && Number(record.revision) >= 1
      && validTimestamp(record.generatedAt)
      && validTimestamp(record.updatedAt)
    );
  } catch {
    return false;
  }
}

export function directorLocalDate(now = new Date(), timeZone = directorTimeZone()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function directorLocalHour(now = new Date(), timeZone = directorTimeZone()) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false
  }).format(now);
  const hour = Number(value === "24" ? "0" : value);
  return Number.isFinite(hour) ? hour : 0;
}

export function directorTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function directorSchedulePromptContext(schedule: DirectorScheduleV1 | undefined) {
  if (!schedule) return JSON.stringify({ schemaVersion: 1, status: "unavailable", schedule: null });
  return JSON.stringify({
    schemaVersion: 1,
    status: "active",
    schedule: {
      date: schedule.date,
      timeZone: schedule.timeZone,
      revision: schedule.revision,
      theme: schedule.theme,
      summary: schedule.summary,
      items: schedule.items
    },
    rules: {
      scheduleIsCommittedFact: true,
      callDirectorToRevise: true,
      doNotInventCompletedEvents: true
    }
  });
}

function normalizeItem(
  value: unknown,
  index: number,
  expected: { date: string; timeZone: string }
): DirectorScheduleItemV1 {
  const record = strictRecord(value, `items[${index}] must be an object.`);
  const id = requiredText(record.id, `items[${index}].id`);
  if (!ITEM_ID_PATTERN.test(id)) throw new Error(`items[${index}].id is invalid.`);
  const startAt = requiredOffsetTimestamp(record.startAt, `items[${index}].startAt`, expected);
  const endAt = requiredOffsetTimestamp(record.endAt, `items[${index}].endAt`, expected);
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new Error(`items[${index}].endAt must be after startAt.`);
  }
  if (!Array.isArray(record.participants)) {
    throw new Error(`items[${index}].participants must be an array.`);
  }
  const participants = record.participants.map((item, participantIndex) => (
    requiredText(item, `items[${index}].participants[${participantIndex}]`)
  ));
  const share = normalizeShare(record.share, index, expected);
  if (
    share.enabled
    && share.at
    && (Date.parse(share.at) < Date.parse(startAt) || Date.parse(share.at) > Date.parse(endAt))
  ) {
    throw new Error(`items[${index}].share.at must fall within the item time range.`);
  }
  return {
    id,
    startAt,
    endAt,
    activity: requiredText(record.activity, `items[${index}].activity`),
    location: requiredText(record.location, `items[${index}].location`),
    participants,
    intent: requiredText(record.intent, `items[${index}].intent`),
    variant: requiredText(record.variant, `items[${index}].variant`),
    share
  };
}

function normalizeShare(
  value: unknown,
  index: number,
  expected: { date: string; timeZone: string }
): DirectorScheduleShareV1 {
  const record = strictRecord(value, `items[${index}].share must be an object.`);
  if (typeof record.enabled !== "boolean") throw new Error(`items[${index}].share.enabled must be boolean.`);
  if (!record.enabled) {
    return { enabled: false, at: null, textIntent: null, selfiePrompt: null };
  }
  return {
    enabled: true,
    at: requiredOffsetTimestamp(record.at, `items[${index}].share.at`, expected),
    textIntent: requiredText(record.textIntent, `items[${index}].share.textIntent`),
    selfiePrompt: requiredText(record.selfiePrompt, `items[${index}].share.selfiePrompt`)
  };
}

function requiredOffsetTimestamp(
  value: unknown,
  field: string,
  expected: { date: string; timeZone: string }
) {
  if (typeof value !== "string" || !OFFSET_TIMESTAMP_PATTERN.test(value) || !validTimestamp(value)) {
    throw new Error(`${field} must be an ISO 8601 timestamp with an explicit UTC offset.`);
  }
  if (directorLocalDate(new Date(value), expected.timeZone) !== expected.date) {
    throw new Error(`${field} must fall on ${expected.date} in ${expected.timeZone}.`);
  }
  return value;
}

function requiredDate(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must be a calendar date.`);
  }
  return value;
}

function requiredText(value: unknown, field: string) {
  if (value == null) throw new Error(`${field} must be text.`);
  return modelContentText(value).trim();
}

function strictRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}


function validTimestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
