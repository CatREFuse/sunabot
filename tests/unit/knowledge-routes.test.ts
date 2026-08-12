import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerKnowledgeRoutes } from "../../apps/api/plugins/knowledgeRoutes.js";

describe("knowledge routes", () => {
  it("scopes list, search, upload, reindex and delete to the requested Agent", async () => {
    const service = {
      list: vi.fn(async () => ({ ok: true, documents: [] })),
      reindex: vi.fn(async () => ({ ok: true, documents: [] })),
      search: vi.fn(async (input) => ({ ok: true, query: input.query, matches: [] })),
      uploadMarkdown: vi.fn(async (input) => ({ ok: true, document: input })),
      deleteDocument: vi.fn(async (path) => ({ ok: true, path }))
    };
    const getService = vi.fn(() => service);
    const app = Fastify();
    registerKnowledgeRoutes(app, { getService });

    expect((await app.inject({ method: "GET", url: "/api/knowledge?agentId=arona" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/knowledge/search?agentId=arona&q=路线&limit=4" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/knowledge/reindex?agentId=arona" })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/knowledge/documents?agentId=arona",
      payload: { path: "手册/开始.md", content: "正文" }
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "DELETE",
      url: "/api/knowledge/documents?agentId=arona",
      payload: { path: "手册/开始.md" }
    })).statusCode).toBe(200);

    expect(getService).toHaveBeenCalledTimes(5);
    expect(getService).toHaveBeenCalledWith("arona");
    expect(service.search).toHaveBeenCalledWith({ query: "路线", limit: 4 });
    expect(service.uploadMarkdown).toHaveBeenCalledWith({ path: "手册/开始.md", content: "正文" });
    expect(service.deleteDocument).toHaveBeenCalledWith("手册/开始.md");
    await app.close();
  });

  it("rejects retired Workbench source query parameters", async () => {
    const service = {
      list: vi.fn(async () => ({ ok: true, documents: [] })),
      reindex: vi.fn(async () => ({ ok: true, documents: [] })),
      search: vi.fn(async (input) => ({ ok: true, query: input.query, matches: [] })),
      uploadMarkdown: vi.fn(async (input) => ({ ok: true, document: input })),
      deleteDocument: vi.fn(async (path) => ({ ok: true, path }))
    };
    const getService = vi.fn(() => service);
    const app = Fastify();
    registerKnowledgeRoutes(app, { getService });

    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge?agentId=arona&workbench=docker"
    });

    expect(response.statusCode).toBe(400);
    expect(getService).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns canonical list and search results without source locations", async () => {
    const snapshot = (path: string) => ({
      ok: true as const,
      root: "knowledge" as const,
      documents: [{
        path,
        format: "markdown" as const,
        sizeBytes: 24,
        chunkCount: 1,
        status: "indexed" as const,
        updatedAt: "2026-07-30T08:00:00.000Z"
      }],
      fileCount: 1,
      chunkCount: 1,
      errorCount: 0,
      indexedAt: "2026-07-30T08:00:00.000Z"
    });
    const service = {
      list: vi.fn(async () => snapshot("canonical.md")),
      reindex: vi.fn(async () => snapshot("canonical.md")),
      search: vi.fn(async () => ({
        ok: true,
        query: "统一工作区",
        matches: [{
          path: "canonical.md",
          format: "markdown" as const,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          content: "Canonical",
          score: 2
        }]
      })),
      uploadMarkdown: vi.fn(),
      deleteDocument: vi.fn()
    };
    const app = Fastify();
    registerKnowledgeRoutes(app, { getService: () => service });

    const list = await app.inject({
      method: "GET",
      url: "/api/knowledge?agentId=plana"
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({
      fileCount: 1,
      chunkCount: 1,
      documents: [{ path: "canonical.md" }]
    });
    expect(list.json().documents[0]).not.toHaveProperty("workbench");

    const search = await app.inject({
      method: "GET",
      url: "/api/knowledge/search?agentId=plana&q=统一工作区&limit=2"
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().matches).toEqual([expect.objectContaining({ path: "canonical.md" })]);
    expect(search.json().matches[0]).not.toHaveProperty("workbench");
    await app.close();
  });

  it("rejects invalid search and upload payloads before service execution", async () => {
    const service = {
      list: vi.fn(), reindex: vi.fn(), search: vi.fn(), uploadMarkdown: vi.fn(), deleteDocument: vi.fn()
    };
    const app = Fastify();
    registerKnowledgeRoutes(app, { getService: () => service });

    expect((await app.inject({ method: "GET", url: "/api/knowledge/search?q=" })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/knowledge/documents",
      payload: { path: "note.md" }
    })).statusCode).toBe(400);
    expect(service.search).not.toHaveBeenCalled();
    expect(service.uploadMarkdown).not.toHaveBeenCalled();
    await app.close();
  });
});
