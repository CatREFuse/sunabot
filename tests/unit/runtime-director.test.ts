// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorScheduleV1 } from "../../services/director/public.js";
import type { ConversationRecord } from "../../src/types.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { RuntimeDirector } from "../../src/runtime/director.js";

const repository = vi.hoisted(() => ({
  director: {
    read: vi.fn(),
    listTaskLinks: vi.fn(),
    linkTask: vi.fn(),
    deleteTaskLink: vi.fn()
  },
  scheduledTasks: {
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock("../../adapters/sqlite/applicationDataStore.js", () => ({
  applicationDataStore: () => repository
}));

vi.mock("../../src/requestLog.js", () => ({
  appendRequestLog: vi.fn(async () => undefined)
}));

const storedTasks = new Map<string, any>();

describe("RuntimeDirector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedTasks.clear();
    repository.director.read.mockReturnValue(schedule());
    repository.director.listTaskLinks.mockReturnValue([]);
    repository.scheduledTasks.get.mockImplementation((id) => storedTasks.get(id));
    repository.scheduledTasks.create.mockImplementation((input) => {
      const existing = storedTasks.get(input.id);
      if (existing) return existing;
      const task = {
        ...input,
        id: input.id,
        revision: 1,
        nextRunAt: input.schedule.runAt,
        lastScheduledAt: null,
        createdAt: "2026-07-20T07:00:00.000Z",
        updatedAt: "2026-07-20T07:00:00.000Z"
      };
      storedTasks.set(task.id, task);
      return task;
    });
    repository.scheduledTasks.delete.mockImplementation((id) => {
      storedTasks.delete(id);
      return { status: "deleted" };
    });
  });

  it("reconciles one-time selfie shares across every enabled QQ conversation in bounded chunks", async () => {
    const wake = vi.fn();
    const records = new Map<string, ConversationRecord>();
    for (let index = 1; index <= 23; index += 1) {
      const id = `group:${20_000 + index}`;
      records.set(id, { id, replyEnabled: true } as ConversationRecord);
    }
    records.set("group:29999", { id: "group:29999", replyEnabled: false } as ConversationRecord);
    records.set("web:admin", { id: "web:admin", replyEnabled: true } as ConversationRecord);
    const host = {
      config: { persona: { defaultAgentId: "plana", name: "普拉娜" } },
      conversationRecords: records,
      scheduledTasks: { wake }
    } as unknown as SunaRuntime;
    const director = new RuntimeDirector(host);

    await expect(director.ensureToday(new Date("2026-07-20T07:00:00.000Z"))).resolves.toMatchObject({
      revision: 1,
      date: "2026-07-20"
    });

    expect(repository.scheduledTasks.create).toHaveBeenCalledTimes(2);
    const drafts = repository.scheduledTasks.create.mock.calls.map(([draft]) => draft);
    expect(drafts.map((draft) => draft.id)).toEqual([
      "director-plana-20260720-afternoon-r1-c1",
      "director-plana-20260720-afternoon-r1-c2"
    ]);
    expect(drafts.map((draft) => draft.targets.length)).toEqual([20, 3]);
    expect(drafts.flatMap((draft) => draft.targets).map((target) => target.conversationId))
      .toEqual(Array.from({ length: 23 }, (_, index) => `group:${20_001 + index}`));
    expect(drafts[0]!.schedule).toEqual({ kind: "once", runAt: "2026-07-20T15:00:00+00:00" });
    expect(drafts[0]!.context).toContain("必须调用 selfie 工具");
    expect(drafts[0]!.context).toContain('<director_daily_share_output_contract version="2">');
    expect(drafts[0]!.context).toContain("不得出现或暗示任何定时、计划、规划");
    expect(drafts[0]!.context).toContain("图片生成成功前不得发送任何用户可见消息");
    expect(drafts[0]!.context).toContain("禁止调用 assistant_text");
    expect(drafts[0]!.context).toContain("不得提供 dispatch_message");
    expect(drafts[0]!.context).toContain("简短文字、自拍和其他需发布内容一起提交");
    expect(drafts[0]!.context).toContain("图片生成失败时不要发送无图文字替代");
    expect(drafts[0]!.context).not.toContain("scheduleDate");
    expect(drafts[0]!.context).not.toContain("scheduleRevision");
    expect(drafts[0]!.context).not.toContain("shareAt");
    expect(repository.director.linkTask).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("replaces a future deterministic chunk when the enabled conversation set changes", async () => {
    const records = new Map<string, ConversationRecord>();
    for (let index = 1; index <= 21; index += 1) {
      const id = `group:${20_000 + index}`;
      records.set(id, { id, replyEnabled: true } as ConversationRecord);
    }
    const host = {
      config: { persona: { defaultAgentId: "plana", name: "普拉娜" } },
      conversationRecords: records,
      scheduledTasks: { wake: vi.fn() }
    } as unknown as SunaRuntime;
    const director = new RuntimeDirector(host);
    const now = new Date("2026-07-20T07:00:00.000Z");

    await director.ensureToday(now);
    records.set("group:20022", { id: "group:20022", replyEnabled: true } as ConversationRecord);
    await director.ensureToday(now);

    expect(repository.scheduledTasks.delete).toHaveBeenCalledWith(
      "director-plana-20260720-afternoon-r1-c2",
      1
    );
    expect(storedTasks.get("director-plana-20260720-afternoon-r1-c2")?.targets).toHaveLength(2);
  });
});

function schedule(): DirectorScheduleV1 {
  return {
    schemaVersion: 1,
    date: "2026-07-20",
    timeZone: "UTC",
    revision: 1,
    source: "daily_plan",
    generatedAt: "2026-07-20T07:00:00.000Z",
    updatedAt: "2026-07-20T07:00:00.000Z",
    theme: "稳定日",
    summary: "完成职责并分享一件小事。",
    items: [
      item("morning", "07:00", "09:00"),
      item("afternoon", "13:00", "16:00", true),
      item("night", "20:00", "22:00")
    ]
  };
}

function item(id: string, start: string, end: string, share = false) {
  return {
    id,
    startAt: `2026-07-20T${start}:00+00:00`,
    endAt: `2026-07-20T${end}:00+00:00`,
    activity: id === "afternoon" ? "整理资料" : `${id} activity`,
    location: "什亭之箱",
    participants: [],
    intent: "保持今天的生活连续性",
    variant: "稳定日",
    share: share
      ? {
          enabled: true,
          at: "2026-07-20T15:00:00+00:00",
          textIntent: "分享完成的资料",
          selfiePrompt: "普拉娜坐在什亭之箱工作台前展示整理好的资料，白发侧辫，红色光环，午后柔光"
        }
      : { enabled: false, at: null, textIntent: null, selfiePrompt: null }
  } as DirectorScheduleV1["items"][number];
}
