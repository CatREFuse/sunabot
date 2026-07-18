import { describe, expect, it, vi } from "vitest";
import {
  buildCronExpression,
  cronExpressionError,
  describeSchedule,
  fromDateTimeLocal,
  parseCronPreset,
  toDateTimeLocal,
  validMentionUserId
} from "./cronSchedule";

describe("cronSchedule", () => {
  it("maps friendly schedules to standard five-part cron expressions", () => {
    expect(buildCronExpression({
      kind: "interval",
      interval: 20,
      minute: 0,
      hour: 9,
      weekDay: 1,
      monthDay: 1
    })).toBe("*/20 * * * *");
    expect(buildCronExpression({
      kind: "weekly",
      interval: 15,
      minute: 30,
      hour: 8,
      weekDay: 5,
      monthDay: 1
    })).toBe("30 8 * * 5");
    expect(buildCronExpression({
      kind: "monthly",
      interval: 15,
      minute: 5,
      hour: 18,
      weekDay: 1,
      monthDay: 12
    })).toBe("5 18 12 * *");
  });

  it("recognizes supported presets and leaves advanced expressions as raw cron", () => {
    expect(parseCronPreset("0 9 * * *")).toMatchObject({ kind: "daily", hour: 9, minute: 0 });
    expect(parseCronPreset("15 * * * *")).toMatchObject({ kind: "hourly", minute: 15 });
    expect(parseCronPreset("0 9 * * 1-5")).toBeNull();
    expect(cronExpressionError("0 9 * *")).toBe("Cron 表达式需包含分、时、日、月、周 5 段");
    expect(cronExpressionError("0 9 * * 1-5")).toBe("");
  });

  it("formats cron and one-time schedules for the task list", () => {
    expect(describeSchedule({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai"
    })).toBe("每天 09:00 · Asia/Shanghai");
    expect(describeSchedule({
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai"
    })).toBe("Cron 0 9 * * 1-5 · Asia/Shanghai");
  });

  it("round-trips a local datetime through an ISO instant", () => {
    vi.useFakeTimers();
    const local = "2026-08-10T09:30";
    const iso = fromDateTimeLocal(local);
    expect(iso).not.toBe("");
    expect(toDateTimeLocal(iso)).toBe(local);
    vi.useRealTimers();
  });

  it("accepts only QQ ids within the JavaScript safe integer range", () => {
    expect(validMentionUserId("9007199254740991")).toBe(true);
    expect(validMentionUserId("9007199254740992")).toBe(false);
    expect(validMentionUserId("07")).toBe(false);
    expect(validMentionUserId("0")).toBe(false);
  });
});
