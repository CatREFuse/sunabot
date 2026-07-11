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

    expect((await app.inject({ method: "GET", url: "/api/memory?source=working" })).json())
      .toMatchObject({ entries: [{ id: "memory-1", userNickname: "老师" }] });
    expect((await app.inject({
      method: "POST",
      url: "/api/memory/recall",
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

    expect((await app.inject({ method: "POST", url: "/api/memory", payload: { source: "working", text: "完成迁移" } })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/memory", payload: { source: "working", id: "memory-2", text: "已完成" } })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/memory", payload: { source: "working", id: "memory-2" } })).json())
      .toEqual({ ok: true });
    expect(reload).toHaveBeenCalledTimes(3);

    expect((await app.inject({ method: "POST", url: "/api/memory", payload: { text: "x", developerNote: "no" } })).statusCode)
      .toBe(200);
    expect(createMemoryEntry).toHaveBeenLastCalledWith(expect.anything(), { text: "x" });
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
