import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDirector } from "./useDirector";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({
  apiRequest,
  ApiRequestError: class extends Error {
    status = 409;
  }
}));

describe("useDirector", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads the selected Agent decision history and saves the total switch", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/config?agentId=plana" && !init?.method) {
        return Promise.resolve(envelope(false, "rev-1"));
      }
      if (path === "/api/director/schedules?page=1&pageSize=14&agentId=plana") {
        return Promise.resolve({
          schedules: [{ date: "2026-07-23", theme: "整理", summary: "整理资料", items: [] }],
          pagination: { page: 1, pageSize: 14, total: 1, pageCount: 1 }
        });
      }
      if (path === "/api/conversations?agentId=plana") {
        return Promise.resolve({ conversations: [conversation()] });
      }
      if (path === "/api/config/director?agentId=plana" && init?.method === "PATCH") {
        return Promise.resolve(envelope(true, "rev-2"));
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const director = useDirector();

    expect(await director.load("plana")).toBe(true);
    expect(director.enabled.value).toBe(false);
    expect(director.schedules.value).toEqual([
      expect.objectContaining({ date: "2026-07-23", summary: "整理资料" })
    ]);
    expect(director.conversations.value).toEqual([
      expect.objectContaining({ id: "group:7", directorEventsEnabled: false })
    ]);
    expect(await director.setEnabled("plana", true)).toBe(true);
    expect(director.enabled.value).toBe(true);
    expect(director.message.value).toBe("导演系统已开启");
  });

  it("keeps the loaded switch revision when decision history fails", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/config?agentId=plana" && !init?.method) {
        return Promise.resolve(envelope(false, "rev-1"));
      }
      if (path === "/api/director/schedules?page=1&pageSize=14&agentId=plana") {
        return Promise.reject(new Error("每日决策读取失败"));
      }
      if (path === "/api/conversations?agentId=plana") {
        return Promise.resolve({ conversations: [conversation()] });
      }
      if (path === "/api/config/director?agentId=plana" && init?.method === "PATCH") {
        return Promise.resolve(envelope(true, "rev-2"));
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const director = useDirector();

    expect(await director.load("plana")).toBe(false);
    expect(director.revision.value).toBe("rev-1");
    expect(director.message.value).toBe("每日决策读取失败");
    expect(await director.setEnabled("plana", true)).toBe(true);
    expect(director.enabled.value).toBe(true);
  });

  it("loads existing conversations as closed and enables one director target", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/config?agentId=plana" && !init?.method) {
        return Promise.resolve(envelope(false, "rev-1"));
      }
      if (path === "/api/director/schedules?page=1&pageSize=14&agentId=plana") {
        return Promise.resolve({
          schedules: [],
          pagination: { page: 1, pageSize: 14, total: 0, pageCount: 1 }
        });
      }
      if (path === "/api/conversations?agentId=plana") {
        return Promise.resolve({ conversations: [conversation()] });
      }
      if (path === "/api/conversations/reply?agentId=plana" && init?.method === "PUT") {
        return Promise.resolve({
          conversation: { ...conversation(), directorEventsEnabled: true }
        });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const director = useDirector();

    expect(await director.load("plana")).toBe(true);
    expect(director.conversations.value[0]?.directorEventsEnabled).toBe(false);
    expect(await director.setConversationEnabled("plana", "group:7", true)).toBe(true);
    expect(JSON.parse(String(apiRequest.mock.calls.at(-1)?.[1]?.body))).toEqual({
      id: "group:7",
      directorEventsEnabled: true
    });
    expect(director.conversations.value[0]?.directorEventsEnabled).toBe(true);
  });

  it("keeps decisions and conversations visible when config loading fails", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/config?agentId=plana") {
        return Promise.reject(new Error("导演系统状态读取失败"));
      }
      if (path === "/api/director/schedules?page=1&pageSize=14&agentId=plana") {
        return Promise.resolve({
          schedules: [{ date: "2026-07-23", theme: "整理", summary: "整理资料", items: [] }],
          pagination: { page: 1, pageSize: 14, total: 1, pageCount: 1 }
        });
      }
      if (path === "/api/conversations?agentId=plana") {
        return Promise.resolve({ conversations: [conversation()] });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const director = useDirector();

    expect(await director.load("plana")).toBe(false);
    expect(director.revision.value).toBe("");
    expect(director.schedules.value).toHaveLength(1);
    expect(director.conversations.value).toHaveLength(1);
    expect(await director.setEnabled("plana", true)).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it("does not send a switch update before config has loaded", async () => {
    const director = useDirector();

    expect(await director.setEnabled("plana", true)).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(director.message.value).toBe("导演系统状态尚未加载");
  });
});

function envelope(enabled: boolean, revision: string) {
  return {
    config: { bot: { director: { enabled } } },
    revision,
    fieldStates: {}
  };
}

function conversation() {
  return {
    id: "group:7",
    scope: "user_group" as const,
    title: "讨论群",
    userId: 1,
    groupId: 7,
    directorEventsEnabled: false,
    messageCount: 1,
    lastAt: "2026-07-23T08:00:00.000Z",
    lastText: "hello",
    messages: []
  };
}
