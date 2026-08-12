import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeSnapshot
} from "../types/knowledge";
import { useKnowledgeBase } from "./useKnowledgeBase";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const document: KnowledgeDocument = {
  path: "共享/说明.md",
  format: "markdown",
  sizeBytes: 100,
  chunkCount: 1,
  status: "indexed",
  updatedAt: "2026-07-30T08:00:00.000Z"
};

function snapshot(documents: KnowledgeDocument[]): KnowledgeSnapshot {
  return {
    ok: true,
    root: "knowledge",
    documents,
    fileCount: documents.length,
    chunkCount: documents.reduce((sum, document) => sum + document.chunkCount, 0),
    errorCount: 0,
    indexedAt: "2026-07-30T08:00:00.000Z"
  };
}

describe("useKnowledgeBase", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads and searches the Agent Workbench", async () => {
    const searchResult: KnowledgeSearchResult = {
      ok: true,
      query: "共享",
      matches: [
        {
          path: document.path,
          format: "markdown",
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          content: "共享",
          score: 2
        }
      ]
    };
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/knowledge?agentId=plana") {
        return Promise.resolve(snapshot([document]));
      }
      if (path === "/api/knowledge/search?agentId=plana&q=%E5%85%B1%E4%BA%AB&limit=12") {
        return Promise.resolve(searchResult);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const knowledge = useKnowledgeBase();

    await expect(knowledge.load("plana")).resolves.toBe(true);
    expect(knowledge.snapshot.value?.documents).toEqual([document]);
    await expect(knowledge.search("共享", "plana")).resolves.toBe(true);
    expect(knowledge.matches.value).toEqual(searchResult.matches);
  });

  it("writes and deletes documents in the Agent Workbench", async () => {
    let documents = [document];
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/knowledge?agentId=plana" && !init?.method) {
        return Promise.resolve(snapshot(documents));
      }
      if (path === "/api/knowledge/documents?agentId=plana" && init?.method === "POST") {
        return Promise.resolve({ snapshot: snapshot([document]) });
      }
      if (path === "/api/knowledge/documents?agentId=plana" && init?.method === "DELETE") {
        documents = [];
        return Promise.resolve({ snapshot: snapshot([]) });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const knowledge = useKnowledgeBase();

    await knowledge.load("plana");
    await expect(knowledge.upload({ path: "新资料.md", content: "# 新资料" }, "plana")).resolves.toBe(true);
    await expect(knowledge.remove(document, "plana")).resolves.toBe(true);
    expect(knowledge.snapshot.value?.documents).toEqual([]);
  });
});
