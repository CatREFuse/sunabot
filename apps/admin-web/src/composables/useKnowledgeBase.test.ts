import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSnapshot } from "../types/knowledge";
import { useKnowledgeBase } from "./useKnowledgeBase";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function snapshot(path: string): KnowledgeSnapshot {
  return {
    ok: true,
    root: "knowledge",
    documents: [{
      path,
      format: "markdown",
      sizeBytes: 64,
      chunkCount: 2,
      status: "indexed",
      updatedAt: "2026-07-20T10:00:00.000Z"
    }],
    fileCount: 1,
    chunkCount: 2,
    errorCount: 0,
    indexedAt: "2026-07-20T10:00:00.000Z"
  };
}

describe("useKnowledgeBase", () => {
  beforeEach(() => apiRequest.mockReset());

  it("aborts the previous Agent request and ignores its late response", async () => {
    const plana = deferred<KnowledgeSnapshot>();
    const arona = deferred<KnowledgeSnapshot>();
    apiRequest.mockReturnValueOnce(plana.promise).mockReturnValueOnce(arona.promise);
    const data = useKnowledgeBase();

    const planaLoad = data.load("plana");
    const planaSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = data.load("arona");

    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/knowledge?agentId=plana");
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/knowledge?agentId=arona");
    expect(planaSignal.aborted).toBe(true);
    arona.resolve(snapshot("arona.md"));
    await aronaLoad;
    plana.resolve(snapshot("plana.md"));
    await planaLoad;

    expect(data.snapshot.value?.documents[0]?.path).toBe("arona.md");
  });

  it("applies upload and delete responses only to the active Agent", async () => {
    apiRequest
      .mockResolvedValueOnce({ snapshot: snapshot("手册/开始.md") })
      .mockResolvedValueOnce({ snapshot: { ...snapshot("unused.md"), documents: [], fileCount: 0, chunkCount: 0 } });
    const data = useKnowledgeBase();

    await data.upload({ path: "手册/开始.md", content: "正文" }, "plana");
    expect(data.snapshot.value?.documents[0]?.path).toBe("手册/开始.md");
    await data.remove("手册/开始.md", "plana");
    expect(data.snapshot.value?.documents).toEqual([]);
    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/knowledge/documents?agentId=plana");
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/knowledge/documents?agentId=plana");
  });
});
