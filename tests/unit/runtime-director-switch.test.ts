import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SunaRuntime } from "../../src/runtime.js";
import type { ConversationRecord } from "../../src/types.js";
import { RuntimeDirector } from "../../src/runtime/director.js";
import { runtime_setConversationReplyEnabled } from "../../src/runtime/lifecycle.js";
import { conversationDirectorEventsEnabled } from "../../src/runtime/messagingAttachmentHelpers.js";

const repository = vi.hoisted(() => ({
  director: {
    read: vi.fn(),
    list: vi.fn(() => ({ schedules: [], pagination: { page: 1, pageSize: 14, total: 0, pageCount: 1 } })),
    listTaskLinks: vi.fn(() => [{
      scheduleDate: "2026-07-23",
      revision: 1,
      itemId: "share",
      taskId: "director-plana-20260723-share-r1-c1",
      runAt: "2026-07-23T12:00:00.000Z",
      createdAt: "2026-07-23T07:00:00.000Z"
    }]),
    linkTask: vi.fn(),
    deleteTaskLink: vi.fn()
  },
  scheduledTasks: {
    get: vi.fn(() => ({
      id: "director-plana-20260723-share-r1-c1",
      revision: 1,
      nextRunAt: "2026-07-23T12:00:00.000Z"
    })),
    create: vi.fn((draft) => ({ ...draft, revision: 1 })),
    delete: vi.fn(() => ({ status: "deleted" }))
  }
}));

vi.mock("../../adapters/sqlite/applicationDataStore.js", () => ({
  applicationDataStore: () => repository
}));

describe("RuntimeDirector switch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes every runtime capability and pending share while disabled", async () => {
    const wake = vi.fn();
    const host = {
      config: {
        bot: { director: { enabled: false } },
        persona: { defaultAgentId: "plana", name: "Plana" }
      },
      scheduledTasks: { wake },
      conversationRecords: new Map()
    } as unknown as SunaRuntime;
    const director = new RuntimeDirector(host);

    await expect(director.promptContext(new Date("2026-07-23T08:00:00.000Z"))).resolves.toBe("");
    expect(director.toolPort()).toBeUndefined();
    await expect(director.ensureToday(new Date("2026-07-23T08:00:00.000Z"), true)).resolves.toBeUndefined();
    director.configChanged(true);

    expect(repository.director.read).not.toHaveBeenCalled();
    expect(repository.scheduledTasks.delete).toHaveBeenCalledWith(
      "director-plana-20260723-share-r1-c1",
      1
    );
    expect(repository.director.deleteTaskLink).toHaveBeenCalledWith("director-plana-20260723-share-r1-c1");
    expect(wake).toHaveBeenCalledOnce();
  });

  it("reconciles future shares to conversations with the director event switch enabled", () => {
    repository.director.read.mockReturnValueOnce(schedule());
    repository.director.listTaskLinks.mockReturnValueOnce([]);
    const wake = vi.fn();
    const host = {
      config: {
        bot: { director: { enabled: true } },
        persona: { defaultAgentId: "plana", name: "Plana" }
      },
      scheduledTasks: { wake },
      conversationRecords: new Map([
        ["private:1", conversation("private:1", true, false)],
        ["private:2", conversation("private:2", false, true)],
        ["group:3", conversation("group:3", true, true)],
        ["private:4", conversation("private:4", undefined, true)]
      ])
    } as unknown as SunaRuntime;
    const director = new RuntimeDirector(host);

    director.targetsChanged(new Date("2026-07-23T08:00:00.000Z"));

    expect(repository.scheduledTasks.create).toHaveBeenCalledWith(expect.objectContaining({
      targets: [
        { conversationId: "group:3", mentionUserIds: [] },
        { conversationId: "private:1", mentionUserIds: [] }
      ]
    }));
    expect(repository.director.linkTask).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("treats existing records without the director event field as closed", () => {
    expect(conversationDirectorEventsEnabled(undefined)).toBe(false);
    expect(conversationDirectorEventsEnabled({})).toBe(false);
    expect(conversationDirectorEventsEnabled({ directorEventsEnabled: false })).toBe(false);
    expect(conversationDirectorEventsEnabled({ directorEventsEnabled: true })).toBe(true);
  });

  it("persists a conversation target change and asks the director to reconcile", () => {
    const record = conversation("private:9", undefined, true);
    const targetsChanged = vi.fn();
    const persistConversationRecords = vi.fn();
    const host = {
      config: { bot: { orchestrator: { recentMessageWindowMs: 60_000 } } },
      upsertConversationRecordForReplySetting: vi.fn(() => record),
      cancelAmbientReply: vi.fn(),
      persistConversationRecords,
      publicConversationRecord: vi.fn((value) => value),
      director: { targetsChanged },
      replyGates: { invalidateConversation: vi.fn() },
      ambientIdleTimers: new Map(),
      activeDirectControllers: new Map()
    } as unknown as SunaRuntime;

    const updated = runtime_setConversationReplyEnabled.call(host, {
      id: "private:9",
      directorEventsEnabled: true
    });

    expect(updated).toMatchObject({ id: "private:9", directorEventsEnabled: true });
    expect(persistConversationRecords).toHaveBeenCalledOnce();
    expect(targetsChanged).toHaveBeenCalledOnce();
  });
});

function conversation(
  id: string,
  directorEventsEnabled: boolean | undefined,
  replyEnabled: boolean
): ConversationRecord {
  const groupId = id.startsWith("group:") ? Number(id.split(":")[1]) : undefined;
  return {
    id,
    scope: groupId ? "user_group" : "private",
    title: id,
    userId: groupId ? 0 : Number(id.split(":")[1]),
    groupId,
    replyEnabled,
    ...(directorEventsEnabled === undefined ? {} : { directorEventsEnabled }),
    messageCount: 0,
    lastAt: "2026-07-23T08:00:00.000Z",
    lastText: "",
    messages: []
  };
}

function schedule() {
  return {
    schemaVersion: 1,
    date: "2026-07-23",
    timeZone: "Asia/Shanghai",
    theme: "日常",
    summary: "下午分享",
    revision: 1,
    source: "daily_plan",
    generatedAt: "2026-07-22T23:00:00.000Z",
    updatedAt: "2026-07-22T23:00:00.000Z",
    items: [{
      id: "share",
      startAt: "2026-07-23T19:00:00+08:00",
      endAt: "2026-07-23T21:00:00+08:00",
      activity: "整理资料",
      location: "工作台",
      participants: [],
      intent: "分享进展",
      variant: "普通日",
      share: {
        enabled: true,
        at: "2026-07-23T20:00:00+08:00",
        textIntent: "分享整理结果",
        selfiePrompt: "角色在工作台前展示整理结果"
      }
    }]
  };
}
