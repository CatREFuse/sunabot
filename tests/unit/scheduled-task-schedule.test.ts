// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  firstScheduledAt,
  nextScheduledAt,
  normalizeScheduledTaskSchedule
} from "../../services/scheduling/public.js";

describe("scheduled task schedules", () => {
  it("normalizes a standard five-field cron and calculates its next zoned occurrence", () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: "  0   9  * * 1-5 ",
      timezone: "Asia/Shanghai"
    });
    expect(schedule).toEqual({
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai"
    });
    expect(firstScheduledAt(schedule, "2026-07-19T00:30:00.000Z"))
      .toBe("2026-07-20T01:00:00.000Z");
    expect(nextScheduledAt(schedule, "2026-07-20T01:00:00.000Z"))
      .toBe("2026-07-21T01:00:00.000Z");
  });

  it("rejects six-field cron expressions, invalid fields, and unknown IANA timezones", () => {
    expect(() => normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: "0 0 9 * * 1-5",
      timezone: "Asia/Shanghai"
    })).toThrow("exactly five");
    expect(() => normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: "61 9 * * *",
      timezone: "Asia/Shanghai"
    })).toThrow("invalid");
    expect(() => normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Mars/Olympus_Mons"
    })).toThrow("IANA timezone");
  });

  it("canonicalizes one-time ISO timestamps and rejects past first occurrences", () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: "once",
      runAt: "2026-07-20T09:30:00+08:00"
    });
    expect(schedule).toEqual({ kind: "once", runAt: "2026-07-20T01:30:00.000Z" });
    expect(firstScheduledAt(schedule, "2026-07-20T01:29:59.999Z"))
      .toBe("2026-07-20T01:30:00.000Z");
    expect(nextScheduledAt(schedule, "2026-07-20T01:29:59.999Z")).toBeNull();
    expect(() => firstScheduledAt(schedule, "2026-07-20T01:30:00.000Z"))
      .toThrow("future");
    expect(() => normalizeScheduledTaskSchedule({ kind: "once", runAt: "2026-07-20" }))
      .toThrow("ISO timestamp");
  });

  it("uses timezone-aware DST progression without creating a second precision schedule", () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: "30 2 * * *",
      timezone: "America/New_York"
    });
    expect(firstScheduledAt(schedule, "2026-03-08T05:00:00.000Z"))
      .toBe("2026-03-08T07:30:00.000Z");
    expect(nextScheduledAt(schedule, "2026-03-08T07:30:00.000Z"))
      .toBe("2026-03-09T06:30:00.000Z");
  });
});
