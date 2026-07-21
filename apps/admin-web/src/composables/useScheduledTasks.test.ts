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
      if (path === "/api/scheduled-tasks?category=all&page=1&pageSize=20&agentId=koharu") return koharu.promise;
      if (path === "/api/conversations?agentId=koharu") return Promise.resolve({ conversations: [] });
      if (path === "/api/scheduled-tasks?category=all&page=1&pageSize=20&agentId=plana") {
        return Promise.resolve(page([task("plana-task", "普拉娜任务")]));
      }
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [conversation("private:7")] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    const first = data.load("koharu");
    const firstSignal = apiRequest.mock.calls.find(([path]) => path.includes("koharu"))?.[1]?.signal as AbortSignal;
    await data.load("plana");
    koharu.resolve(page([task("koharu-task", "小春任务")]));
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
      if (path === "/api/scheduled-tasks?category=all&page=1&pageSize=20&agentId=plana") {
        taskRead += 1;
        return taskRead === 1 ? first.promise : second.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    const earlier = data.load("plana");
    const latest = data.load("plana");
    first.resolve(page([task("stale", "过期任务")]));
    await earlier;
    expect(data.loading.value).toBe(true);

    second.resolve(page([task("current", "当前任务")]));
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
      if (path === "/api/scheduled-tasks?category=all&page=1&pageSize=20&agentId=plana" && !init?.method) {
        return Promise.resolve(page(responses.shift() ?? []));
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

  it("queries categories and pages on the server and resets the page when the tab changes", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [] });
      if (path.includes("category=all&page=1")) return Promise.resolve(page([task("all", "全部任务")], 1, 42));
      if (path.includes("category=all&page=2")) return Promise.resolve(page([task("page-2", "第二页任务")], 2, 42));
      if (path.includes("category=director&page=1")) {
        return Promise.resolve(page([{ ...task("director-task", "导演任务"), director: true }], 1, 1));
      }
      if (path.includes("category=archived&page=1")) {
        return Promise.resolve(page([{ ...task("archived", "归档任务"), archived: true }], 1, 1));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    await data.load("plana");
    expect(data.pagination.value).toMatchObject({ page: 1, pageSize: 20, total: 42, pageCount: 3 });
    await data.changePage("plana", 2);
    expect(data.tasks.value[0]?.id).toBe("page-2");
    await data.selectCategory("plana", "director");
    expect(data.category.value).toBe("director");
    expect(data.tasks.value[0]).toMatchObject({ id: "director-task", director: true });
    await data.selectCategory("plana", "archived");
    expect(data.category.value).toBe("archived");
    expect(data.pagination.value.page).toBe(1);
    expect(data.tasks.value[0]).toMatchObject({ id: "archived", archived: true });
  });

  it("updates permanent retention with only the revision and requested value", async () => {
    const archived = { ...task("archived", "归档任务", 4), archived: true };
    let reads = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations?agentId=plana") return Promise.resolve({ conversations: [] });
      if (path.includes("/api/scheduled-tasks?category=all") && !init?.method) {
        reads += 1;
        return Promise.resolve(page([{ ...archived, permanentRetention: reads > 1 }]));
      }
      if (path === "/api/scheduled-tasks/archived?agentId=plana" && init?.method === "PUT") {
        return Promise.resolve(undefined);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const data = useScheduledTasks();

    await data.load("plana");
    expect(await data.setPermanentRetention("plana", data.tasks.value[0]!, true)).toBe(true);
    const retention = apiRequest.mock.calls.find(([path, init]) => path.includes("/archived?") && init?.method === "PUT");
    expect(JSON.parse(String(retention?.[1]?.body))).toEqual({ permanentRetention: true, revision: 4 });
    expect(data.tasks.value[0]?.permanentRetention).toBe(true);
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
    permanentRetention: false,
    archived: false,
    director: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function page(tasks: ScheduledTask[], currentPage = 1, total = tasks.length): ScheduledTasksResponse {
  return {
    tasks,
    pagination: {
      page: currentPage,
      pageSize: 20,
      total,
      pageCount: Math.max(1, Math.ceil(total / 20))
    }
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
