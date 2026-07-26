import { formatModelTimestamp } from "../../packages/platform/systemTime.js";
import {
  dreamLocalDate,
  latestDreamScheduleOccurrence
} from "../../services/memory/dream/schedule.js";
import type {
  DreamDirectorScheduleFixture,
  DreamUserTestInput,
  JsonFixtureRecord,
  MemoryCompressionUserTestInput,
  WorkingMemoryFixtureItem
} from "./contracts.js";

export function materializeMemoryCompressionAtRuntime(
  input: MemoryCompressionUserTestInput,
  runtimeNow: Date
) {
  assertRuntimeRebasePolicy(input.timePolicy);
  const fixtureNowMs = Date.parse(input.now);
  const runtimeNowMs = checkedDate(runtimeNow, "USER_TEST_RUNTIME_NOW_INVALID").getTime();
  const offsetMs = runtimeNowMs - fixtureNowMs;
  return {
    input: {
      ...input,
      now: new Date(runtimeNowMs).toISOString(),
      workingMemory: input.workingMemory.map((item) => shiftWorkingMemoryItem(item, offsetMs)),
      longTerm: shiftJsonFixtureRecords(input.longTerm, offsetMs),
      userProfiles: shiftJsonFixtureRecords(input.userProfiles, offsetMs),
      messages: input.messages.map((message) => ({
        ...message,
        at: shiftIsoTimestamp(message.at, offsetMs)
      }))
    },
    timeline: {
      policy: input.timePolicy,
      fixtureNow: new Date(fixtureNowMs).toISOString(),
      runtimeNow: new Date(runtimeNowMs).toISOString(),
      offsetMs
    }
  };
}

export function materializeDreamAtRuntime(
  input: DreamUserTestInput,
  runtimeNow: Date
) {
  assertRuntimeRebasePolicy(input.timePolicy);
  const fixtureNow = checkedDate(input.now, "USER_TEST_DREAM_NOW_INVALID");
  const checkedRuntimeNow = checkedDate(runtimeNow, "USER_TEST_RUNTIME_NOW_INVALID");
  const offsetMs = checkedRuntimeNow.getTime() - fixtureNow.getTime();
  const director = rebaseDirectorSchedule(
    input.directorSchedule,
    fixtureNow,
    checkedRuntimeNow
  );
  return {
    input: {
      ...input,
      now: checkedRuntimeNow.toISOString(),
      workingMemory: input.workingMemory.map((item) => shiftWorkingMemoryItem(item, offsetMs)),
      longTerm: shiftJsonFixtureRecords(input.longTerm, offsetMs),
      userProfiles: shiftJsonFixtureRecords(input.userProfiles, offsetMs),
      conversations: input.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          at: shiftIsoTimestamp(message.at, offsetMs)
        }))
      })),
      activeTasks: input.activeTasks.map((task) => ({
        ...task,
        runAt: shiftIsoTimestamp(task.runAt, offsetMs)
      })),
      directorSchedule: director.schedule
    },
    timeline: {
      policy: input.timePolicy,
      fixtureNow: fixtureNow.toISOString(),
      runtimeNow: checkedRuntimeNow.toISOString(),
      offsetMs,
      dreamScheduleDate: director.targetDreamDate,
      directorScheduleDate: director.schedule?.date ?? null
    }
  };
}

export function rebaseDreamTemplateToFixture(
  template: DreamUserTestInput,
  fixtureNowValue: string
) {
  assertRuntimeRebasePolicy(template.timePolicy);
  const fixtureNow = checkedDate(template.now, "USER_TEST_DREAM_NOW_INVALID");
  const targetNow = checkedDate(fixtureNowValue, "USER_TEST_DREAM_NOW_INVALID");
  const offsetMs = targetNow.getTime() - fixtureNow.getTime();
  const director = rebaseDirectorSchedule(
    template.directorSchedule,
    fixtureNow,
    targetNow
  );
  return {
    activeTasks: template.activeTasks.map((task) => ({
      ...task,
      runAt: shiftIsoTimestamp(task.runAt, offsetMs)
    })),
    directorSchedule: director.schedule
  };
}

function rebaseDirectorSchedule(
  schedule: DreamDirectorScheduleFixture | null,
  fixtureNow: Date,
  targetNow: Date
) {
  const timeZone = schedule?.timeZone;
  const fixtureDreamDate = latestDreamScheduleOccurrence({
    now: fixtureNow,
    ...(timeZone ? { timeZone } : {})
  }).localDate;
  const targetDreamDate = latestDreamScheduleOccurrence({
    now: targetNow,
    ...(timeZone ? { timeZone } : {})
  }).localDate;
  if (schedule == null) {
    return {
      schedule: null,
      fixtureDreamDate,
      targetDreamDate
    };
  }
  if (schedule.date !== fixtureDreamDate) {
    throw new Error("USER_TEST_DREAM_DIRECTOR_DATE_MISMATCH");
  }
  const items = schedule.items.map((item) => {
    assertDirectorItemDate(item.startAt, schedule);
    assertDirectorItemDate(item.endAt, schedule);
    if (item.share.at != null) assertDirectorItemDate(item.share.at, schedule);
    return {
      ...item,
      startAt: mapWallClockToDate(item.startAt, targetDreamDate, schedule.timeZone),
      endAt: mapWallClockToDate(item.endAt, targetDreamDate, schedule.timeZone),
      share: {
        ...item.share,
        at: item.share.at == null
          ? null
          : mapWallClockToDate(item.share.at, targetDreamDate, schedule.timeZone)
      }
    };
  });
  return {
    schedule: {
      ...schedule,
      date: targetDreamDate,
      items
    },
    fixtureDreamDate,
    targetDreamDate
  };
}

function assertDirectorItemDate(value: string, schedule: DreamDirectorScheduleFixture) {
  if (dreamLocalDate(new Date(value), schedule.timeZone) !== schedule.date) {
    throw new Error("USER_TEST_DREAM_DIRECTOR_DATE_MISMATCH");
  }
}

function mapWallClockToDate(value: string, targetDate: string, timeZone: string) {
  const source = checkedDate(value, "USER_TEST_DREAM_DIRECTOR_TIME_INVALID");
  const parts = dateTimeParts(source, timeZone);
  const local = `${targetDate}T${parts.hour}:${parts.minute}:${parts.second}.${String(
    source.getUTCMilliseconds()
  ).padStart(3, "0")}`;
  const localAsUtc = Date.parse(`${local}Z`);
  let candidate = localAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    candidate = localAsUtc - timeZoneOffsetMs(new Date(candidate), timeZone);
  }
  const rendered = formatModelTimestamp(candidate, timeZone);
  if (!rendered.startsWith(local)) {
    throw new Error("USER_TEST_DREAM_DIRECTOR_TIME_INVALID");
  }
  return rendered;
}

function dateTimeParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = dateTimeParts(date, timeZone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return localAsUtc - (date.getTime() - date.getUTCMilliseconds());
}

function shiftWorkingMemoryItem(
  item: WorkingMemoryFixtureItem,
  offsetMs: number
): WorkingMemoryFixtureItem {
  return {
    ...item,
    occurredAt: shiftIsoTimestamp(item.occurredAt, offsetMs),
    ...(item.recordedAt == null ? {} : {
      recordedAt: shiftIsoTimestamp(item.recordedAt, offsetMs)
    }),
    ...(item.occurredEndAt == null ? {} : {
      occurredEndAt: shiftIsoTimestamp(item.occurredEndAt, offsetMs)
    }),
    ...(item.dreamDate == null ? {} : {
      dreamDate: shiftCalendarDate(item.dreamDate, offsetMs)
    }),
    ...(item.dreamReviewedAt == null ? {} : {
      dreamReviewedAt: shiftIsoTimestamp(item.dreamReviewedAt, offsetMs)
    })
  };
}

function shiftJsonFixtureRecords(records: readonly JsonFixtureRecord[], offsetMs: number) {
  return records.map((record) => shiftJsonFixtureValue(record, "", offsetMs) as JsonFixtureRecord);
}

function shiftJsonFixtureValue(value: unknown, key: string, offsetMs: number): unknown {
  if (typeof value === "string" && temporalFixtureKey(key) && Number.isFinite(Date.parse(value))) {
    return /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? shiftCalendarDate(value, offsetMs)
      : shiftIsoTimestamp(value, offsetMs);
  }
  if (Array.isArray(value)) {
    return value.map((item) => shiftJsonFixtureValue(item, key, offsetMs));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    shiftJsonFixtureValue(item, childKey, offsetMs)
  ]));
}

function shiftIsoTimestamp(value: string, offsetMs: number) {
  return new Date(Date.parse(value) + offsetMs).toISOString();
}

function shiftCalendarDate(value: string, offsetMs: number) {
  return new Date(Date.parse(`${value}T12:00:00.000Z`) + offsetMs).toISOString().slice(0, 10);
}

function temporalFixtureKey(key: string) {
  return /(?:^at$|At$|time$|timestamp$|date$)/iu.test(key);
}

function assertRuntimeRebasePolicy(value: string) {
  if (value !== "rebase_to_runtime") {
    throw new Error("USER_TEST_BRANCH_FIXED_TIME_REQUIRES_CONTROLLED_CLOCK");
  }
}

function checkedDate(value: Date | string, code: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date;
}
