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
    expect(getService).toHaveBeenCalledWith("arona", "native");
    expect(service.search).toHaveBeenCalledWith({ query: "路线", limit: 4 });
    expect(service.uploadMarkdown).toHaveBeenCalledWith({ path: "手册/开始.md", content: "正文" });
    expect(service.deleteDocument).toHaveBeenCalledWith("手册/开始.md");
    await app.close();
  });

  it("routes Docker Workbench knowledge operations independently", async () => {
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

    expect(response.statusCode).toBe(200);
    expect(getService).toHaveBeenCalledWith("arona", "docker");
    await app.close();
  });

  it("merges Native and Docker list and search results with source locations", async () => {
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
    const services = {
      native: {
        list: vi.fn(async () => snapshot("native.md")),
        reindex: vi.fn(async () => snapshot("native.md")),
        search: vi.fn(async () => ({
          ok: true,
          query: "双工作区",
          matches: [{
            path: "native.md",
            format: "markdown" as const,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            content: "Native",
            score: 2
          }]
        })),
        uploadMarkdown: vi.fn(),
        deleteDocument: vi.fn()
      },
      docker: {
        list: vi.fn(async () => snapshot("docker.md")),
        reindex: vi.fn(async () => snapshot("docker.md")),
        search: vi.fn(async () => ({
          ok: true,
          query: "双工作区",
          matches: [{
            path: "docker.md",
            format: "markdown" as const,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            content: "Docker",
            score: 3
          }]
        })),
        uploadMarkdown: vi.fn(),
        deleteDocument: vi.fn()
      }
    };
    const app = Fastify();
    registerKnowledgeRoutes(app, {
      getService: (_agentId, backend) => services[backend]
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/knowledge?agentId=plana&workbench=all"
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({
      fileCount: 2,
      chunkCount: 2,
      documents: [
        { path: "native.md", workbench: "native" },
        { path: "docker.md", workbench: "docker" }
      ]
    });

    const search = await app.inject({
      method: "GET",
      url: "/api/knowledge/search?agentId=plana&workbench=all&q=双工作区&limit=2"
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().matches).toEqual([
      expect.objectContaining({ path: "docker.md", workbench: "docker" }),
      expect.objectContaining({ path: "native.md", workbench: "native" })
    ]);
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
