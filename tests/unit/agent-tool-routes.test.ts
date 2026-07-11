// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentToolRoutes } from "../../apps/api/plugins/agentToolRoutes.js";
import type { AgentFileRepository } from "../../src/admin/agentFiles.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("agent and tool API plugin", () => {
  it("registers schemas and delegates Agent file operations", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const list = vi.fn(async () => ({ files: [{ id: "AGENTS" }] }));
    const get = vi.fn(async (id: string) => ({ id, content: "agent" }));
    const put = vi.fn(async (id: string, body: unknown) => ({ ok: true, id, body }));
    registerAgentToolRoutes(app, {
      agentFiles: { list, get, put } as unknown as AgentFileRepository
    });

    expect((await app.inject({ method: "GET", url: "/api/agent-files" })).json())
      .toEqual({ files: [{ id: "AGENTS" }] });
    expect((await app.inject({ method: "GET", url: "/api/agent-files/AGENTS" })).json())
      .toEqual({ id: "AGENTS", content: "agent" });
    const body = { content: "updated", revision: "rev" };
    expect((await app.inject({ method: "PUT", url: "/api/agent-files/AGENTS", payload: body })).json())
      .toEqual({ ok: true, id: "AGENTS", body });
    expect(put).toHaveBeenCalledWith("AGENTS", body);
    expect((await app.inject({ method: "GET", url: "/api/tools" })).json().tools)
      .toEqual(expect.any(Array));

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/agent-files",
      "/api/agent-files/:id",
      "/api/tools"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
