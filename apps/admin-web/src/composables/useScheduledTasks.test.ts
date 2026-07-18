import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../types";
import type { ScheduledTask, ScheduledTasksResponse } from "../types/scheduledTasks";
import { useScheduledTasks } from "./useScheduledTasks";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

describe("useScheduledTasks", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("uses an explicit Agent id and ignores a late task response after switching Agents", async () => {
    const koharu = deferred<ScheduledTasksResponse>();
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/scheduled-tasks?agentId=koharu") return koharu.promise;
      if (path === "/api/conversations?agentId=koharu") return Promise.resolve({ conversations: [] });
      if (path === "/api/scheduled-tasks?agentId=plana") return Promise.resolve({ tasks: [task("plana-task", "普拉娜任务")] });
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [conversation("private:7")] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    const first = data.load("koharu");
    const firstSignal = apiRequest.mock.calls.find(([path]) => path.includes("koharu"))?.[1]?.signal as AbortSignal;
    await data.load("plana");
    koharu.resolve({ tasks: [task("koharu-task", "小春任务")] });
    await first;

    expect(firstSignal.aborted).toBe(true);
    expect(data.tasks.value.map((item) => item.id)).toEqual(["plana-task"]);
    expect(data.conversations.value.map((item) => item.id)).toEqual(["private:7"]);
  });

  it("keeps loading active until the newest same-Agent refresh completes", async () => {
    const first = deferred<ScheduledTasksResponse>();
    const second = deferred<ScheduledTasksResponse>();
    let taskRead = 0;
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [] });
      if (path === "/api/scheduled-tasks?agentId=plana") {
        taskRead += 1;
        return taskRead === 1 ? first.promise : second.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    const earlier = data.load("plana");
    const latest = data.load("plana");
    first.resolve({ tasks: [task("stale", "过期任务")] });
    await earlier;
    expect(data.loading.value).toBe(true);

    second.resolve({ tasks: [task("current", "当前任务")] });
    await latest;
    expect(data.loading.value).toBe(false);
    expect(data.tasks.value.map((item) => item.id)).toEqual(["current"]);
  });

  it("creates, updates, toggles and deletes through the canonical task endpoints", async () => {
    const responses: ScheduledTask[][] = [
      [],
      [task("daily", "每日提醒", 1)],
      [task("daily", "每日汇报", 2)],
      [{ ...task("daily", "每日汇报", 3), enabled: false }],
      []
    ];
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [] });
      if (path === "/api/scheduled-tasks?agentId=plana" && !init?.method) {
        return Promise.resolve({ tasks: responses.shift() ?? [] });
      }
      if (path.startsWith("/api/scheduled-tasks") && init?.method) return Promise.resolve(undefined);
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();
    await data.load("plana");

    const createInput = {
      name: " 每日提醒 ",
      enabled: true,
      context: " 提醒提交日报 ",
      schedule: { kind: "cron" as const, expression: "0   9 * * *", timezone: " Asia/Shanghai " },
      targets: [{ conversationId: " group:10001 ", mentionUserIds: ["7", "7", "8"] }]
    };
    expect(await data.save("plana", createInput)).toBe(true);
    const createBody = JSON.parse(String(apiRequest.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(createBody).toEqual({
      name: "每日提醒",
      enabled: true,
      context: "提醒提交日报",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
      targets: [{ conversationId: "group:10001", mentionUserIds: ["7", "8"] }]
    });
    expect(createBody).not.toHaveProperty("revision");

    const existing = data.tasks.value[0]!;
    expect(await data.save("plana", { ...existing, name: "每日汇报" }, existing)).toBe(true);
    const putCallsAfterUpdate = apiRequest.mock.calls.filter(([, init]) => init?.method === "PUT");
    const update = putCallsAfterUpdate[0];
    expect(update?.[0]).toBe("/api/scheduled-tasks/daily?agentId=plana");
    expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({ name: "每日汇报", revision: 1 });

    expect(await data.setEnabled("plana", data.tasks.value[0]!, false)).toBe(true);
    const toggle = apiRequest.mock.calls.filter(([, init]) => init?.method === "PUT")[1];
    expect(JSON.parse(String(toggle?.[1]?.body))).toMatchObject({ enabled: false, revision: 2 });
    expect(data.tasks.value[0]?.enabled).toBe(false);
    expect(await data.remove("plana", data.tasks.value[0]!)).toBe(true);
    const deletion = apiRequest.mock.calls.find(([path, init]) => path === "/api/scheduled-tasks/daily?agentId=plana" && init?.method === "DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({ revision: 3 });
    expect(data.tasks.value).toEqual([]);
  });
});

function task(id: string, name: string, revision = 1): ScheduledTask {
  return {
    id,
    revision,
    name,
    enabled: true,
    context: "任务上下文",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
    targets: [{ conversationId: "group:10001", mentionUserIds: ["7"] }],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function conversation(id: string): ConversationRecord {
  return {
    id,
    scope: "private",
    title: "猫老师",
    userId: 7,
    messageCount: 0,
    lastAt: "2026-07-19T00:00:00.000Z",
    lastText: "",
    messages: []
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
