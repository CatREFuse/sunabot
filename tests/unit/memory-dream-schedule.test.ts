// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  latestDreamScheduleOccurrence,
  resolveDueDreamRun
} from "../../services/memory/dream/public.js";

describe("Dream 04:00 schedule", () => {
  it("selects the latest 04:00 occurrence in the configured IANA timezone", () => {
    expect(latestDreamScheduleOccurrence({
      now: "2026-07-21T20:30:00.000Z",
      timeZone: "Asia/Shanghai"
    })).toEqual({
      localDate: "2026-07-22",
      scheduledAt: "2026-07-21T20:00:00.000Z",
      timeZone: "Asia/Shanghai",
      trigger: "catch_up"
    });
  });

  it("uses the previous local day before 04:00 and treats an exact 04:00 tick as scheduled", () => {
    expect(latestDreamScheduleOccurrence({
      now: "2026-07-21T19:00:00.000Z",
      timeZone: "Asia/Shanghai"
    }).localDate).toBe("2026-07-21");
    expect(latestDreamScheduleOccurrence({
      now: "2026-07-21T20:00:00.000Z",
      timeZone: "Asia/Shanghai"
    })).toMatchObject({
      localDate: "2026-07-22",
      scheduledAt: "2026-07-21T20:00:00.000Z",
      trigger: "scheduled"
    });
  });

  it("returns only the most recent missed run and is idempotent by local date", () => {
    const due = resolveDueDreamRun({
      now: "2026-07-25T12:00:00.000Z",
      timeZone: "Asia/Shanghai",
      existingLocalDates: ["2026-07-20"]
    });
    expect(due?.localDate).toBe("2026-07-25");
    expect(resolveDueDreamRun({
      now: "2026-07-25T12:00:00.000Z",
      timeZone: "Asia/Shanghai",
      existingLocalDates: ["2026-07-25"]
    })).toBeNull();
  });

  it("keeps 04:00 local time across daylight-saving changes and rejects invalid timezones", () => {
    expect(latestDreamScheduleOccurrence({
      now: "2026-03-08T09:00:00.000Z",
      timeZone: "America/New_York"
    })).toMatchObject({
      localDate: "2026-03-08",
      scheduledAt: "2026-03-08T08:00:00.000Z"
    });
    expect(() => latestDreamScheduleOccurrence({
      now: "2026-07-20T00:00:00.000Z",
      timeZone: "Mars/Olympus_Mons"
    })).toThrow("IANA timezone");
  });
});
