// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemoryRoutes } from "../../apps/api/plugins/memoryRoutes.js";
import type { MemoryEntry } from "../../services/memory/public.js";
import type { AppConfig } from "../../src/types.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("memory API plugin", () => {
  it("lists, recalls and enriches memory entries", async () => {
    const entry = memoryEntry("memory-1");
    const enrichMemoryEntries = vi.fn((entries: MemoryEntry[]) => entries.map((item) => ({
      ...item,
      userNickname: "老师"
    })));
    const app = Fastify();
    apps.push(app);
    registerMemoryRoutes(app, {
      getConfig: () => ({}) as AppConfig,
      runtime: { enrichMemoryEntries, reload: vi.fn() },
      operations: {
        listMemoryEntries: vi.fn(async () => ({ sources: [], entries: [entry] })),
        recallMemory: vi.fn(async (_config, input) => ({ ok: true as const, query: String(input.query), matches: [entry] }))
      }
    });

    expect((await app.inject({ method: "GET", url: "/api/memory?agentId=plana&source=working" })).json())
      .toMatchObject({ entries: [{ id: "memory-1", userNickname: "老师" }] });
    expect((await app.inject({
      method: "POST",
      url: "/api/memory/recall?agentId=plana",
      payload: { query: "迁移", limit: 3 }
    })).json()).toMatchObject({ ok: true, query: "迁移", matches: [{ id: "memory-1", userNickname: "老师" }] });
    expect(enrichMemoryEntries).toHaveBeenCalledTimes(2);
  });

  it("reloads the runtime after every memory mutation and strips undeclared fields", async () => {
    const entry = memoryEntry("memory-2");
    const reload = vi.fn(async () => undefined);
    const createMemoryEntry = vi.fn(async () => entry);
    const app = Fastify();
    apps.push(app);
    registerMemoryRoutes(app, {
      getConfig: () => ({}) as AppConfig,
      runtime: { enrichMemoryEntries: (entries) => entries, reload },
      operations: {
        createMemoryEntry,
        updateMemoryEntry: vi.fn(async () => entry),
        deleteMemoryEntry: vi.fn(async () => ({ ok: true }))
      }
    });

    expect((await app.inject({ method: "POST", url: "/api/memory?agentId=plana", payload: { source: "working", text: "完成迁移" } })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/memory?agentId=plana", payload: { source: "working", id: "memory-2", text: "已完成" } })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/memory?agentId=plana", payload: { source: "working", id: "memory-2" } })).json())
      .toEqual({ ok: true });
    expect(reload).toHaveBeenCalledTimes(3);

    expect((await app.inject({ method: "POST", url: "/api/memory?agentId=plana", payload: { text: "x", developerNote: "no" } })).statusCode)
      .toBe(200);
    expect(createMemoryEntry).toHaveBeenLastCalledWith(expect.anything(), { text: "x" });
  });

  it("lists bounded Dream history for the selected Agent", async () => {
    const listDreamHistory = vi.fn(async () => ({
      items: [{
        id: "dream-2026-07-20",
        date: "2026-07-20",
        status: "completed" as const,
        scheduledFor: "2026-07-20T04:00:00.000+08:00",
        dreamText: "我沿着熟悉的小路走进一片会发光的海。",
        completedAt: "2026-07-20T04:00:03.000+08:00",
        personalityChanged: false,
        summary: { merged: 2, archived: 1, promoted: 1 }
      }],
      timeZone: "Asia/Shanghai",
      nextScheduledFor: "2026-07-21T04:00:00.000+08:00"
    }));
    const selectedRuntime = {
      enrichMemoryEntries: (entries: MemoryEntry[]) => entries,
      reload: vi.fn(),
      listDreamHistory
    };
    const app = Fastify();
    apps.push(app);
    registerMemoryRoutes(app, {
      getConfig: () => ({}) as AppConfig,
      runtime: selectedRuntime,
      getAgentContext: vi.fn((agentId) => {
        expect(agentId).toBe("arona");
        return { config: {} as AppConfig, runtime: selectedRuntime };
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/dreams?agentId=arona&limit=12"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: "dream-2026-07-20", status: "completed" }],
      timeZone: "Asia/Shanghai"
    });
    expect(listDreamHistory).toHaveBeenCalledWith(12);

    expect((await app.inject({
      method: "GET",
      url: "/api/memory/dreams?agentId=arona&limit=101"
    })).statusCode).toBe(400);
  });

  it("forces the selected Agent Dream through an online account", async () => {
    const forceDream = vi.fn(async () => ({
      ok: true as const,
      notificationQueued: true as const,
      run: {
        id: "dream-manual",
        date: "2026-07-21",
        status: "completed" as const,
        scheduledFor: "2026-07-21T10:00:00.000Z",
        dreamText: "我睡着后走进了一座安静的车站。"
      }
    }));
    const runtime = {
      enrichMemoryEntries: (entries: MemoryEntry[]) => entries,
      reload: vi.fn(),
      forceDream
    };
    const app = Fastify();
    apps.push(app);
    registerMemoryRoutes(app, {
      getConfig: () => ({}) as AppConfig,
      runtime,
      getAgentContext: () => ({ config: {} as AppConfig, runtime }),
      resolveDreamAccountId: vi.fn(async (agentId) => agentId === "arona" ? "arona-main" : undefined)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/memory/dreams/trigger?agentId=arona"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, notificationQueued: true, run: { id: "dream-manual" } });
    expect(forceDream).toHaveBeenCalledWith({ accountId: "arona-main" });
  });

  it("requires an explicit Agent before resolving a manual Dream account", async () => {
    const runtime = {
      enrichMemoryEntries: (entries: MemoryEntry[]) => entries,
      reload: vi.fn(),
      forceDream: vi.fn()
    };
    const app = Fastify();
    apps.push(app);
    registerMemoryRoutes(app, {
      getConfig: () => ({}) as AppConfig,
      runtime,
      resolveDreamAccountId: () => undefined
    });

    const response = await app.inject({ method: "POST", url: "/api/memory/dreams/trigger" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "AGENT_ID_REQUIRED" });
    expect(runtime.forceDream).not.toHaveBeenCalled();
  });
});

function memoryEntry(id: string): MemoryEntry {
  return {
    id,
    source: "working",
    sourceTitle: "工作记忆",
    fileName: "working.json",
    editable: true,
    key: id,
    value: "完成迁移",
    text: "完成迁移",
    field: "fact"
  };
}
