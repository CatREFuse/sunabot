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
      accessLabel: "仅管理员 QQ 私聊",
      executionBackend: "native"
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
    expect(resolveToolCapabilities).toHaveBeenCalledOnce();
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
      availabilityReason: "当前 Agent 未配置可用的语音参考音频。"
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
    const bash = tools.find((tool: { name: string }) => tool.name === "workspace_bash");
    expect(bash).toMatchObject({
      available,
      effectiveEnabled: available,
      accessLabel: "仅管理员 QQ 私聊",
      executionBackend: "native",
      ...(!available ? {
        unavailabilityKind: "runtime",
        runtimeReasonCode: "BASH_NATIVE_ISOLATION_UNAVAILABLE",
        availabilityReason: "Native 后端未通过强隔离检查，Bash 已安全关闭。可在“命令执行”切换 Docker 后端后重新检查。"
      } : {})
    });
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
      availabilityReason: "独立 Bash 审计不可用，Bash 已安全关闭。"
    });
  });

  it.each([
    {
      backend: "native" as const,
      reason: "BASH_WORKBENCH_UNAVAILABLE" as const,
      message: "当前 Agent workbench 不可用，Bash 已安全关闭。"
    },
    {
      backend: "docker" as const,
      reason: "BASH_DOCKER_ISOLATION_UNAVAILABLE" as const,
      message: "Docker 后端未通过强隔离检查，Bash 已安全关闭。"
    }
  ])("maps $reason to a safe Bash catalog status", async ({ backend, reason, message }) => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    config.bot.bash.adminPrivateBackend = backend;
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities: vi.fn(async () => ({
        codex: true,
        workspaceBash: false,
        workspaceBashReason: reason
      })),
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      available: false,
      executionBackend: backend,
      runtimeReasonCode: reason,
      availabilityReason: message
    });
  });

  it("marks every session unavailable when the administrator identity gate is disabled", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    config.bot.bash.adminOnly = false;
    const resolveToolCapabilities = vi.fn(async () => ({ codex: true, workspaceBash: true }));
    registerAgentToolRoutes(app, {
      agentFiles: {
        get: vi.fn(async () => ({ content: defaultPromptContent("conversation.private-reply") }))
      } as unknown as AgentFileRepository,
      resolveToolCapabilities,
      getConfig: () => config
    });

    const tools = (await app.inject({ method: "GET", url: "/api/tools" })).json().tools;
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      configuredEnabled: true,
      available: false,
      effectiveEnabled: false,
      unavailabilityKind: "session",
      accessLabel: "所有会话均不可用",
      availabilityReason: "管理员身份门禁已关闭，所有会话均不可用。"
    });
    expect(resolveToolCapabilities).toHaveBeenCalledWith(null);
  });

  it("keeps the configured session scope independent from backend readiness", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    config.bot.bash.enabled = true;
    config.bot.bash.allowGroup = true;
    config.bot.bash.adminPrivateBackend = "native";
    const resolveToolCapabilities = vi.fn(async (backend?: "native" | "docker" | null) => ({
      codex: true,
      workspaceBash: backend === "docker",
      ...(backend === "docker" ? {} : {
        workspaceBashReason: "BASH_NATIVE_ISOLATION_UNAVAILABLE" as const
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
    expect(tools.find((tool: { name: string }) => tool.name === "workspace_bash")).toMatchObject({
      available: true,
      effectiveEnabled: true,
      accessLabel: "管理员 QQ 私聊与群聊",
      accessDescription: expect.stringContaining("管理员私聊使用 Native 后端")
    });
    expect(resolveToolCapabilities.mock.calls.map(([backend]) => backend)).toEqual(["native", "docker"]);
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
