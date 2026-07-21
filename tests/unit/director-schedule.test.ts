// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  directorDailyPlanPromptTemplate,
  directorSchedulePromptContext,
  directorScheduleRevisionPromptTemplate,
  isDirectorSchedule,
  normalizeDirectorScheduleDraft,
  parseDirectorScheduleDraft,
  type DirectorScheduleDraftV1,
  type DirectorScheduleV1
} from "../../services/director/public.js";

describe("director schedule contract", () => {
  it("accepts an ordered daily schedule with one to three in-activity shares", () => {
    const draft = validDraft();

    expect(parseDirectorScheduleDraft(JSON.stringify(draft), {
      date: draft.date,
      timeZone: draft.timeZone
    })).toEqual(draft);
  });

  it("rejects overlap, unsupported fields, cross-day timestamps and shares outside their activity", () => {
    expect(() => normalizeDirectorScheduleDraft({
      ...validDraft(),
      unsupported: true
    }, expected())).toThrow("unsupported field");

    const overlap = validDraft();
    overlap.items[1]!.startAt = "2026-07-20T08:30:00+00:00";
    expect(() => normalizeDirectorScheduleDraft(overlap, expected())).toThrow("must not overlap");

    const crossDay = validDraft();
    crossDay.items[2]!.endAt = "2026-07-21T00:10:00+00:00";
    expect(() => normalizeDirectorScheduleDraft(crossDay, expected())).toThrow("must fall on 2026-07-20");

    const outside = validDraft();
    outside.items[1]!.share.at = "2026-07-20T16:30:00+00:00";
    expect(() => normalizeDirectorScheduleDraft(outside, expected())).toThrow("must fall within the item time range");
  });

  it("requires complete selfie share fields and recognizes committed schedules", () => {
    const incomplete = validDraft();
    incomplete.items[1]!.share.selfiePrompt = null;
    expect(() => normalizeDirectorScheduleDraft(incomplete, expected())).toThrow("selfiePrompt must be text");

    const schedule: DirectorScheduleV1 = {
      ...validDraft(),
      revision: 1,
      source: "daily_plan",
      generatedAt: "2026-07-20T07:00:00.000Z",
      updatedAt: "2026-07-20T07:00:00.000Z"
    };
    expect(isDirectorSchedule(schedule)).toBe(true);
    expect(isDirectorSchedule({ ...schedule, source: "unknown" })).toBe(false);
    expect(JSON.parse(directorSchedulePromptContext(schedule))).toMatchObject({
      status: "active",
      schedule: { revision: 1, theme: "认真生活" },
      rules: { scheduleIsCommittedFact: true, callDirectorToRevise: true }
    });
  });

  it("keeps provider schemas compatible while enforcing unique participants locally", () => {
    expect(JSON.stringify([
      directorDailyPlanPromptTemplate(),
      directorScheduleRevisionPromptTemplate()
    ])).not.toContain('"uniqueItems"');

    const duplicate = validDraft();
    duplicate.items[1]!.participants = ["伙伴", "伙伴"];
    expect(() => normalizeDirectorScheduleDraft(duplicate, expected())).toThrow("must be unique");
  });
});

function expected() {
  return { date: "2026-07-20", timeZone: "UTC" };
}

function validDraft(): DirectorScheduleDraftV1 {
  return {
    schemaVersion: 1,
    date: "2026-07-20",
    timeZone: "UTC",
    theme: "认真生活",
    summary: "完成职责，也留出自然休息。",
    items: [
      {
        id: "morning",
        startAt: "2026-07-20T07:00:00+00:00",
        endAt: "2026-07-20T09:00:00+00:00",
        activity: "早间检查",
        location: "工作台",
        participants: [],
        intent: "确认今天的基础状态",
        variant: "顺利日",
        share: { enabled: false, at: null, textIntent: null, selfiePrompt: null }
      },
      {
        id: "afternoon",
        startAt: "2026-07-20T13:00:00+00:00",
        endAt: "2026-07-20T16:00:00+00:00",
        activity: "整理资料",
        location: "窗边桌面",
        participants: ["伙伴"],
        intent: "完成一份清楚的索引",
        variant: "协作日",
        share: {
          enabled: true,
          at: "2026-07-20T15:00:00+00:00",
          textIntent: "分享刚完成的一页资料",
          selfiePrompt: "角色本人坐在窗边桌面前，手里拿着整理好的资料，神情放松，午后自然光"
        }
      },
      {
        id: "night",
        startAt: "2026-07-20T20:00:00+00:00",
        endAt: "2026-07-20T22:00:00+00:00",
        activity: "晚间收束",
        location: "休息区",
        participants: [],
        intent: "归档进展并休息",
        variant: "安静夜晚",
        share: { enabled: false, at: null, textIntent: null, selfiePrompt: null }
      }
    ]
  };
}
