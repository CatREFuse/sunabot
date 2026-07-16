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

    const list = vi.fn(async () => ({ files: [{ id: "persona.agents" }] }));
    const get = vi.fn(async (id: string) => ({
      id,
      content: id === "conversation.private-reply" ? defaultPromptContent("conversation.private-reply") : "agent"
    }));
    const put = vi.fn(async (id: string, body: unknown) => ({ ok: true, id, body }));
    const resolveToolCapabilities = vi.fn(async () => ({ codex: true, workspaceBash: true }));
    const resolveConversationAssetCapability = vi.fn(async () => true);
    const config = defaultConfig();
    config.bot.tools.overrides = {
      websearch: { enabled: false, description: "Disabled search override." }
    };
    registerAgentToolRoutes(app, {
      agentFiles: { list, get, put } as unknown as AgentFileRepository,
      resolveToolCapabilities,
      resolveConversationAssetCapability,
      getConfig: () => config
    });

    expect((await app.inject({ method: "GET", url: "/api/agent-files" })).json())
      .toEqual({ files: [{ id: "persona.agents" }] });
    expect((await app.inject({ method: "GET", url: "/api/agent-files/persona.agents" })).json())
      .toEqual({ id: "persona.agents", content: "agent" });
    const body = { content: "updated", revision: "rev" };
    expect((await app.inject({ method: "PUT", url: "/api/agent-files/persona.agents", payload: body })).json())
      .toEqual({ ok: true, id: "persona.agents", body });
    expect(put).toHaveBeenCalledWith("persona.agents", body);
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
    expect(tools.find((tool: { name: string }) => tool.name === "codex")).toMatchObject({
      available: true,
      effectiveEnabled: true
    });
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      configuredEnabled: false,
      available: true,
      effectiveEnabled: false
    });
    expect(tools.find((tool: { name: string }) => tool.name === "no_reply")).toMatchObject({
      configuredEnabled: null,
      promptEnabled: true,
      available: true,
      effectiveEnabled: true
    });
    expect(tools.find((tool: { name: string }) => tool.name === "system_config")).toMatchObject({
      configuredEnabled: null,
      promptEnabled: true,
      available: true,
      effectiveEnabled: true,
      execution: "inline"
    });
    expect(tools.find((tool: { name: string }) => tool.name === "send_file")).toMatchObject({
      available: true,
      effectiveEnabled: true,
      execution: "inline"
    });
    expect(tools.find((tool: { name: string }) => tool.name === "read_file")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
    expect(tools.find((tool: { name: string }) => tool.name === "write_file")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
    expect(tools.find((tool: { name: string }) => tool.name === "send_voice_message")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
    expect(resolveToolCapabilities).toHaveBeenCalledOnce();
    expect(resolveConversationAssetCapability).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("conversation.private-reply", config);

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/agent-files",
      "/api/agent-files/:id",
      "/api/system-prompt-files",
      "/api/system-prompt-files/:id",
      "/api/tools"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });

  it("does not advertise Codex when the shared runtime capability is unavailable", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: false, workspaceBash: true })),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "codex")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "Codex CLI 未安装或未登录。"
    });
  });

  it("does not advertise send_file without a live conversation asset capability", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      resolveConversationAssetCapability: vi.fn(async () => false),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "send_file")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前会话不支持文件发送。"
    });
  });

  it("keeps the tool catalog available when the conversation asset resolver fails", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      resolveConversationAssetCapability: vi.fn(async () => {
        throw new Error("injected:conversation-asset-capability");
      }),
      getConfig: () => config
    });

    const response = await app.inject({ method: "GET", url: "/api/tools" });
    expect(response.statusCode).toBe(200);
    const tools = response.json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "send_file")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前会话不支持文件发送。"
    });
  });

  it("reports runtime capability independently from the saved tool switch", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.tools.codex.enabled = false;
    config.bot.bash.enabled = false;
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "codex")).toMatchObject({
      configuredEnabled: false,
      available: true,
      effectiveEnabled: false
    });
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      configuredEnabled: false,
      available: true,
      effectiveEnabled: false
    });
  });

  it.each([true, false])("advertises Bash only after the isolation probe returns %s", async (available) => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: available })),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      available,
      effectiveEnabled: available
    });
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
