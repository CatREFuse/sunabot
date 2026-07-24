import type {
  DirectorScheduleDraftV1,
  DirectorScheduleItemV1,
  DirectorScheduleShareV1,
  DirectorScheduleV1
} from "./types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseDirectorScheduleDraft(
  text: string,
  expected: { date: string; timeZone: string }
): DirectorScheduleDraftV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Director schedule is not valid JSON: ${errorMessage(error)}`);
  }
  return normalizeDirectorScheduleDraft(value, expected);
}

export function normalizeDirectorScheduleDraft(
  value: unknown,
  expected: { date: string; timeZone: string }
): DirectorScheduleDraftV1 {
  return normalizeDirectorSchedule(value, expected, 1);
}

function normalizeDirectorSchedule(
  value: unknown,
  expected: { date: string; timeZone: string },
  minimumShares: 0 | 1
): DirectorScheduleDraftV1 {
  const record = strictRecord(value, "Director schedule must be an object.");
  exactKeys(record, ["schemaVersion", "date", "timeZone", "theme", "summary", "items"], "schedule");
  if (record.schemaVersion !== 1) throw new Error("Director schedule schemaVersion must be 1.");
  const date = requiredDate(record.date, "date");
  const timeZone = boundedText(record.timeZone, "timeZone", 80);
  if (date !== expected.date) throw new Error(`Director schedule date must be ${expected.date}.`);
  if (timeZone !== expected.timeZone) {
    throw new Error(`Director schedule timeZone must be ${expected.timeZone}.`);
  }
  if (!Array.isArray(record.items) || record.items.length < 3 || record.items.length > 16) {
    throw new Error("Director schedule items must contain 3 to 16 entries.");
  }
  const items = record.items.map((item, index) => normalizeItem(item, index, { date, timeZone }));
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) throw new Error("Director schedule item ids must be unique.");
  for (let index = 1; index < items.length; index += 1) {
    if (Date.parse(items[index - 1]!.startAt) > Date.parse(items[index]!.startAt)) {
      throw new Error("Director schedule items must be ordered by startAt.");
    }
    if (Date.parse(items[index - 1]!.endAt) > Date.parse(items[index]!.startAt)) {
      throw new Error("Director schedule items must not overlap.");
    }
  }
  const shares = items.filter((item) => item.share.enabled);
  if (shares.length < minimumShares || shares.length > 3) {
    throw new Error("Director schedule must contain 1 to 3 daily shares.");
  }
  return {
    schemaVersion: 1,
    date,
    timeZone,
    theme: boundedText(record.theme, "theme", 120),
    summary: boundedText(record.summary, "summary", 500),
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
      timeZone: boundedText(record.timeZone, "timeZone", 80)
    }, source === "character_revision" ? 0 : 1);
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
  exactKeys(
    record,
    ["id", "startAt", "endAt", "activity", "location", "participants", "intent", "variant", "share"],
    `items[${index}]`
  );
  const id = boundedText(record.id, `items[${index}].id`, 48);
  if (!ITEM_ID_PATTERN.test(id)) throw new Error(`items[${index}].id is invalid.`);
  const startAt = requiredOffsetTimestamp(record.startAt, `items[${index}].startAt`, expected);
  const endAt = requiredOffsetTimestamp(record.endAt, `items[${index}].endAt`, expected);
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new Error(`items[${index}].endAt must be after startAt.`);
  }
  if (!Array.isArray(record.participants) || record.participants.length > 8) {
    throw new Error(`items[${index}].participants must contain at most 8 names.`);
  }
  const participants = record.participants.map((item, participantIndex) => (
    boundedText(item, `items[${index}].participants[${participantIndex}]`, 80)
  ));
  if (new Set(participants).size !== participants.length) {
    throw new Error(`items[${index}].participants must be unique.`);
  }
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
    activity: boundedText(record.activity, `items[${index}].activity`, 240),
    location: boundedText(record.location, `items[${index}].location`, 120),
    participants,
    intent: boundedText(record.intent, `items[${index}].intent`, 300),
    variant: boundedText(record.variant, `items[${index}].variant`, 120),
    share
  };
}

function normalizeShare(
  value: unknown,
  index: number,
  expected: { date: string; timeZone: string }
): DirectorScheduleShareV1 {
  const record = strictRecord(value, `items[${index}].share must be an object.`);
  exactKeys(record, ["enabled", "at", "textIntent", "selfiePrompt"], `items[${index}].share`);
  if (typeof record.enabled !== "boolean") throw new Error(`items[${index}].share.enabled must be boolean.`);
  if (!record.enabled) {
    if (record.at !== null || record.textIntent !== null || record.selfiePrompt !== null) {
      throw new Error(`items[${index}].share fields must be null when disabled.`);
    }
    return { enabled: false, at: null, textIntent: null, selfiePrompt: null };
  }
  return {
    enabled: true,
    at: requiredOffsetTimestamp(record.at, `items[${index}].share.at`, expected),
    textIntent: boundedText(record.textIntent, `items[${index}].share.textIntent`, 500),
    selfiePrompt: boundedText(record.selfiePrompt, `items[${index}].share.selfiePrompt`, 800)
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

function boundedText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

function strictRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], field: string) {
  const expected = new Set(keys);
  const unexpected = Object.keys(record).find((key) => !expected.has(key));
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (unexpected) throw new Error(`${field} contains unsupported field ${unexpected}.`);
  if (missing) throw new Error(`${field} is missing field ${missing}.`);
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
