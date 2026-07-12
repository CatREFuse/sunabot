// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentToolRoutes } from "../../apps/api/plugins/agentToolRoutes.js";
import type { AgentFileRepository } from "../../src/admin/agentFiles.js";
import { defaultConfig } from "../../src/config.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { AGENT_TOOL_NAMES } from "../../src/types.js";

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
    const get = vi.fn(async (id: string) => ({
      id,
      content: id === "conversation.reply" ? defaultPromptContent("conversation.reply") : "agent"
    }));
    const put = vi.fn(async (id: string, body: unknown) => ({ ok: true, id, body }));
    const config = defaultConfig();
    config.bot.tools.overrides = {
      websearch: { enabled: false, description: "Disabled search override." }
    };
    registerAgentToolRoutes(app, {
      agentFiles: { list, get, put } as unknown as AgentFileRepository,
      getConfig: () => config
    });

    expect((await app.inject({ method: "GET", url: "/api/agent-files" })).json())
      .toEqual({ files: [{ id: "AGENTS" }] });
    expect((await app.inject({ method: "GET", url: "/api/agent-files/AGENTS" })).json())
      .toEqual({ id: "AGENTS", content: "agent" });
    const body = { content: "updated", revision: "rev" };
    expect((await app.inject({ method: "PUT", url: "/api/agent-files/AGENTS", payload: body })).json())
      .toEqual({ ok: true, id: "AGENTS", body });
    expect(put).toHaveBeenCalledWith("AGENTS", body);
    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(AGENT_TOOL_NAMES);
    expect(tools.find((tool: { name: string }) => tool.name === "websearch")).toMatchObject({
      description: "Disabled search override.",
      descriptionSource: "override",
      configuredEnabled: false,
      promptEnabled: true,
      enabled: false,
      available: true,
      effectiveEnabled: false,
      execution: "inline",
      parameters: expect.any(Object)
    });
    expect(get).toHaveBeenCalledWith("conversation.reply", config);

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
