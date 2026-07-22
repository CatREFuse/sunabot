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
    const resolveSkillToolCapabilities = vi.fn(async () => ({
      activate: true,
      readResource: true,
      runScript: false,
      skillIds: ["approved"]
    }));
    const config = defaultConfig();
    config.bot.tools.overrides = {
      websearch: { enabled: false, description: "Disabled search override." }
    };
    registerAgentToolRoutes(app, {
      agentFiles: { list, get, put } as unknown as AgentFileRepository,
      resolveToolCapabilities,
      resolveConversationAssetCapability,
      resolveSkillToolCapabilities,
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
      effectiveEnabled: false,
      accessLabel: "全部 QQ 会话 Docker",
      bashEnvironments: {
        docker: { started: true }
      }
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
    expect(tools.find((tool: { name: string }) => tool.name === "call_director")).toMatchObject({
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
      effectiveEnabled: false,
      unavailabilityKind: "session",
      accessLabel: "管理员 QQ 私聊可用"
    });
    expect(tools.find((tool: { name: string }) => tool.name === "write_file")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      unavailabilityKind: "session",
      accessLabel: "管理员 QQ 私聊可用"
    });
    expect(tools.find((tool: { name: string }) => tool.name === "send_voice_message")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
    expect(tools.find((tool: { name: string }) => tool.name === "activate_skill")).toMatchObject({
      available: true,
      effectiveEnabled: true,
      parameters: { properties: { skillId: { enum: ["approved"] } } }
    });
    expect(tools.find((tool: { name: string }) => tool.name === "read_skill_resource")).toMatchObject({
      available: true,
      effectiveEnabled: true
    });
    expect(tools.find((tool: { name: string }) => tool.name === "run_skill_script")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前环境没有可用的 Skill 脚本审计执行器。"
    });
    expect(resolveToolCapabilities.mock.calls.map(([backend]) => backend)).toEqual(["docker"]);
    expect(resolveConversationAssetCapability).toHaveBeenCalledOnce();
    expect(resolveSkillToolCapabilities).toHaveBeenCalledOnce();
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
    expect(tools.find((tool: { name: string }) => tool.name === "activate_skill")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前环境未启用 Skill 激活能力。"
    });
  });

  it("keeps Skill inventory isolated between Agent tool catalogs", async () => {
    const app = Fastify();
    apps.push(app);
    const configA = defaultConfig();
    const configB = defaultConfig();
    const agentFiles = {
      get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
    } as unknown as AgentFileRepository;
    const contextFor = (agentId: string) => ({
      config: agentId === "agent-a" ? configA : configB,
      agentFiles,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      resolveSkillToolCapabilities: vi.fn(async () => ({
        activate: true,
        readResource: true,
        runScript: false,
        skillIds: agentId === "agent-a" ? ["agent-a-skill"] : []
      }))
    });
    registerAgentToolRoutes(app, {
      agentFiles,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      getConfig: () => configA,
      getAgentContext: contextFor
    });

    const toolsA = (await app.inject({ method: "GET", url: "/api/tools?agentId=agent-a" })).json().tools;
    const toolsB = (await app.inject({ method: "GET", url: "/api/tools?agentId=agent-b" })).json().tools;
    expect(toolsA.find((tool: { name: string }) => tool.name === "activate_skill")).toMatchObject({
      available: true,
      effectiveEnabled: true,
      parameters: { properties: { skillId: { enum: ["agent-a-skill"] } } }
    });
    expect(toolsB.find((tool: { name: string }) => tool.name === "activate_skill")).toMatchObject({
      available: true,
      effectiveEnabled: false,
      parameters: { properties: { skillId: { enum: [] } } }
    });
    expect(toolsB.find((tool: { name: string }) => tool.name === "read_skill_resource")).toMatchObject({
      available: true,
      effectiveEnabled: false
    });
  });

  it("projects the selected Agent Voice capability into its tool catalog", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    const agentFiles = {
      get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
    } as unknown as AgentFileRepository;
    const getAgentContext = (agentId: string) => ({
      config,
      agentFiles,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      resolveConversationAssetCapability: vi.fn(async () => true),
      resolveVoiceCapability: vi.fn(async () => agentId === "koharu"
        ? { enabled: true, languages: ["ja"] as const, defaultLanguage: "ja" as const }
        : { enabled: false, languages: [] as const, defaultLanguage: "ja" as const })
    });
    registerAgentToolRoutes(app, {
      agentFiles,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      getConfig: () => config,
      getAgentContext
    });

    const koharuTools = (await app.inject({ method: "GET", url: "/api/tools?agentId=koharu" })).json().tools;
    const planaTools = (await app.inject({ method: "GET", url: "/api/tools?agentId=plana" })).json().tools;
    expect(koharuTools.find((tool: { name: string }) => tool.name === "send_voice_message")).toMatchObject({
      available: true,
      effectiveEnabled: true,
      parameters: { required: ["text"], properties: { text: expect.any(Object) } }
    });
    expect(koharuTools.find((tool: { name: string }) => tool.name === "send_voice_message")
      .parameters.properties).not.toHaveProperty("language");
    expect(planaTools.find((tool: { name: string }) => tool.name === "send_voice_message")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前 Agent 未配置可用的在线音色。"
    });
  });

  it("fails the Voice catalog capability closed when profile resolution is unavailable", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({ codex: true, workspaceBash: true })),
      resolveConversationAssetCapability: vi.fn(async () => false),
      resolveVoiceCapability: vi.fn(async () => {
        throw new Error("injected private Voice profile path");
      }),
      getConfig: () => config
    });

    const response = await app.inject({ method: "GET", url: "/api/tools" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("private Voice profile path");
    expect(response.json().tools.find((tool: { name: string }) => tool.name === "send_voice_message"))
      .toMatchObject({ available: false, effectiveEnabled: false });
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

  it.each([
    { docker: true, available: true },
    { docker: false, available: false }
  ])("advertises Docker=$docker Bash status", async ({ docker, available }) => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    const resolveToolCapabilities = vi.fn(async () => ({
      codex: true,
      workspaceBash: docker,
      ...(docker ? {} : {
        workspaceBashReason: "BASH_DOCKER_ISOLATION_UNAVAILABLE" as const
      })
    }));
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities,
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    const bash = tools.find((tool: { name: string }) => tool.name === "workspace_bash");
    expect(bash).toMatchObject({
      available,
      effectiveEnabled: available,
      accessLabel: "全部 QQ 会话 Docker",
      accessDescription: "QQ 私聊与群聊使用 Docker Bash；Web Chat 不可用。",
      bashEnvironments: {
        docker: {
          started: docker,
          ...(!docker ? { reasonCode: "BASH_DOCKER_ISOLATION_UNAVAILABLE" } : {})
        }
      },
      ...(!available ? {
        unavailabilityKind: "runtime",
        runtimeReasonCode: "BASH_DOCKER_ISOLATION_UNAVAILABLE",
        availabilityReason: "Docker Bash 环境未启动。"
      } : {})
    });
    expect(bash.description).toContain(`Docker Bash ${docker ? "已启动" : "未启动"}`);
    expect(resolveToolCapabilities.mock.calls.map(([backend]) => backend)).toEqual(["docker"]);
  });

  it("reports the independent Bash audit failure without exposing diagnostics", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({
        codex: true,
        workspaceBash: false,
        workspaceBashReason: "BASH_AUDIT_UNAVAILABLE" as const
      })),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      available: false,
      runtimeReasonCode: "BASH_AUDIT_UNAVAILABLE",
      availabilityReason: "Bash 对抗审批 Agent 不可用。",
      bashEnvironments: {
        docker: { started: false, reasonCode: "BASH_AUDIT_UNAVAILABLE" }
      }
    });
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
