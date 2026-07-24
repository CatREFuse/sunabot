import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryPayload } from "../types";
import { useMemory } from "./useMemory";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("./useAdminApi", () => ({ apiRequest }));

const entry: MemoryEntry = {
  id: "memory-1",
  source: "working",
  sourceTitle: "工作记忆",
  fileName: "WORKING_MEMORY.md",
  editable: true,
  key: "memory-1",
  value: "已有记忆",
  text: "已有记忆",
  field: "text"
};
const payload: MemoryPayload = {
  sources: [{ id: "working", title: "工作记忆", fileName: "WORKING_MEMORY.md", editable: true }],
  entries: [entry],
  document: {
    fileName: "WORKING_MEMORY.md",
    content: "# 工作记忆\n\n完整原文",
    revision: "revision-plana"
  }
};

describe("useMemory", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("tracks a zero-result recall and clears recall mode after a mutation", async () => {
    apiRequest.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/memory/recall") return Promise.resolve({ ok: true, query: "missing", matches: [] });
      if (path === "/api/memory" && options?.method === "POST") return Promise.resolve({ ok: true });
      if (path === "/api/memory?source=working") return Promise.resolve(payload);
      throw new Error(`Unexpected request: ${path}`);
    });
    const memory = useMemory();
    await memory.load();
    await memory.recall("missing", "working");

    expect(memory.recallActive.value).toBe(true);
    expect(memory.matches.value).toEqual([]);

    await memory.create({ source: "working", text: "new memory" });
    expect(memory.recallActive.value).toBe(false);
    expect(memory.matches.value).toEqual([]);
    expect(memory.entries.value).toEqual([entry]);
    expect(memory.document.value).toEqual(payload.document);
  });

  it("drops sources and entries outside the supported active set", async () => {
    apiRequest.mockResolvedValue({
      sources: [
        ...payload.sources,
        { id: "retired", title: "旧来源", fileName: "RETIRED.jsonl", editable: false }
      ],
      entries: [
        ...payload.entries,
        { ...entry, id: "retired-1", source: "retired", sourceTitle: "旧来源" }
      ]
    } as unknown as MemoryPayload);
    const memory = useMemory();

    await memory.load();

    expect(memory.sources.value).toEqual(payload.sources);
    expect(memory.entries.value).toEqual(payload.entries);
  });

  it("keeps an older Agent response from replacing the active Agent memory", async () => {
    let resolvePlana!: (value: MemoryPayload) => void;
    let resolveArona!: (value: MemoryPayload) => void;
    const planaRequest = new Promise<MemoryPayload>((resolve) => { resolvePlana = resolve; });
    const aronaRequest = new Promise<MemoryPayload>((resolve) => { resolveArona = resolve; });
    apiRequest
      .mockReturnValueOnce(planaRequest)
      .mockReturnValueOnce(aronaRequest);
    const memory = useMemory();

    const planaLoad = memory.load("working", "plana");
    const planaSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = memory.load("working", "arona");
    const aronaEntry = { ...entry, id: "arona-memory", text: "阿罗娜的记忆" };
    const aronaDocument = { ...payload.document!, content: "# 工作记忆\n\n阿罗娜的完整原文", revision: "revision-arona" };
    resolveArona({ ...payload, entries: [aronaEntry], document: aronaDocument });
    await aronaLoad;
    resolvePlana(payload);
    await planaLoad;

    expect(planaSignal.aborted).toBe(true);
    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/memory?source=working&agentId=plana");
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/memory?source=working&agentId=arona");
    expect(memory.entries.value).toEqual([aronaEntry]);
    expect(memory.document.value).toEqual(aronaDocument);
  });
});
