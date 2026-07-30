import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeSnapshot
} from "../types/knowledge";
import { useKnowledgeBase } from "./useKnowledgeBase";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const nativeDocument: KnowledgeDocument = {
  path: "共享/说明.md",
  format: "markdown",
  sizeBytes: 100,
  chunkCount: 1,
  status: "indexed",
  updatedAt: "2026-07-30T08:00:00.000Z",
  workbench: "native"
};
const dockerDocument: KnowledgeDocument = {
  ...nativeDocument,
  sizeBytes: 200,
  workbench: "docker"
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

  it("loads and searches both Workbench sources", async () => {
    const searchResult: KnowledgeSearchResult = {
      ok: true,
      query: "共享",
      matches: [
        {
          path: nativeDocument.path,
          format: "markdown",
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          content: "Native",
          score: 2,
          workbench: "native"
        },
        {
          path: dockerDocument.path,
          format: "markdown",
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          content: "Docker",
          score: 1,
          workbench: "docker"
        }
      ]
    };
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/knowledge?agentId=plana&workbench=all") {
        return Promise.resolve(snapshot([nativeDocument, dockerDocument]));
      }
      if (path === "/api/knowledge/search?agentId=plana&workbench=all&q=%E5%85%B1%E4%BA%AB&limit=12") {
        return Promise.resolve(searchResult);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const knowledge = useKnowledgeBase();

    await expect(knowledge.load("plana")).resolves.toBe(true);
    expect(knowledge.snapshot.value?.documents).toEqual([nativeDocument, dockerDocument]);
    await expect(knowledge.search("共享", "plana")).resolves.toBe(true);
    expect(knowledge.matches.value.map((match) => match.workbench)).toEqual(["native", "docker"]);
  });

  it("writes new documents to Native and deletes existing documents from their source", async () => {
    let documents = [nativeDocument, dockerDocument];
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/knowledge?agentId=plana&workbench=all" && !init?.method) {
        return Promise.resolve(snapshot(documents));
      }
      if (path === "/api/knowledge/documents?agentId=plana&workbench=native" && init?.method === "POST") {
        return Promise.resolve({ snapshot: snapshot([nativeDocument]) });
      }
      if (path === "/api/knowledge/documents?agentId=plana&workbench=docker" && init?.method === "DELETE") {
        documents = [nativeDocument];
        return Promise.resolve({ snapshot: snapshot([]) });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const knowledge = useKnowledgeBase();

    await knowledge.load("plana");
    await expect(knowledge.upload({ path: "新资料.md", content: "# 新资料" }, "plana")).resolves.toBe(true);
    await expect(knowledge.remove(dockerDocument, "plana")).resolves.toBe(true);
    expect(knowledge.snapshot.value?.documents).toEqual([nativeDocument]);
  });
});
