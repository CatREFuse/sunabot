// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExtensionOverview, AgentMcpHttpServer } from "../types/agentExtensions";
import McpOAuthDialog from "../components/extensions/McpOAuthDialog.vue";
import McpServerList from "../components/extensions/McpServerList.vue";
import SkillInstallDialog from "../components/extensions/SkillInstallDialog.vue";

const dependencies = vi.hoisted(() => ({
  extensions: null as ReturnType<typeof createExtensions> | null,
  agents: null as ReturnType<typeof createAgents> | null
}));

vi.mock("../composables/useAgentExtensions", () => ({
  useAgentExtensions: () => dependencies.extensions
}));
vi.mock("../composables/useAgents", () => ({
  useAgents: () => dependencies.agents
}));

import AgentExtensionsView from "./AgentExtensionsView.vue";

describe("AgentExtensionsView OAuth return flow", () => {
  beforeEach(() => {
    dependencies.extensions = createExtensions();
    dependencies.agents = createAgents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears stale feedback before dialogs and announces successful actions", async () => {
    const extensions = requiredExtensions();
    extensions.message.value = "Skill 已安装";
    const wrapper = mountView();
    await flushPromises();

    const status = wrapper.get('[role="status"]');
    expect(status.attributes("aria-live")).toBe("polite");
    expect(status.text()).toBe("Skill 已安装");

    const installButton = wrapper.findAll("button").find((button) => button.text().includes("安装 ZIP"));
    expect(installButton).toBeDefined();
    await installButton!.trigger("click");
    expect(extensions.clearFeedback).toHaveBeenCalledTimes(1);
    expect(wrapper.getComponent(SkillInstallDialog).props("open")).toBe(true);

    await wrapper.getComponent(McpServerList).vm.$emit("oauth", pendingServer);
    expect(extensions.clearFeedback).toHaveBeenCalledTimes(2);
    expect(wrapper.getComponent(McpOAuthDialog).props()).toMatchObject({
      agentId: "plana",
      agentName: "普拉娜",
      authorizationOrigin: "",
      server: pendingServer
    });
  });

  it("reloads canonical extension state after the main window regains focus", async () => {
    const extensions = requiredExtensions();
    const wrapper = mountView();
    await flushPromises();
    await wrapper.getComponent(McpServerList).vm.$emit("oauth", pendingServer);

    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
      location: { replace },
      close: vi.fn()
    } as unknown as Window);
    await wrapper.getComponent(McpOAuthDialog).vm.$emit("begin", oauthInput);
    await flushPromises();

    expect(extensions.beginOAuth).toHaveBeenCalledWith("plana", "remote-search", oauthInput);
    expect(replace).toHaveBeenCalledWith("https://auth.example.test/authorize");
    expect(wrapper.getComponent(McpOAuthDialog).props("authorizationOrigin")).toBe("https://auth.example.test");

    extensions.load.mockImplementationOnce(async () => {
      extensions.overview.value = overview(connectedServer);
    });
    window.dispatchEvent(new Event("focus"));
    await flushPromises();

    expect(extensions.load).toHaveBeenLastCalledWith("plana");
    expect(wrapper.getComponent(McpOAuthDialog).props("server")).toEqual(connectedServer);
    wrapper.unmount();
  });

  it("keeps popup blocking as an inline error without starting OAuth", async () => {
    const extensions = requiredExtensions();
    const wrapper = mountView();
    await flushPromises();
    await wrapper.getComponent(McpServerList).vm.$emit("oauth", pendingServer);
    vi.spyOn(window, "open").mockReturnValue(null);

    await wrapper.getComponent(McpOAuthDialog).vm.$emit("begin", oauthInput);
    await flushPromises();

    expect(extensions.beginOAuth).not.toHaveBeenCalled();
    expect(wrapper.getComponent(McpOAuthDialog).props("error")).toContain("浏览器拦截了授权窗口");
  });

  it("does not render an overview that belongs to a different active Agent", async () => {
    const extensions = requiredExtensions();
    const agents = dependencies.agents!;
    extensions.overview.value = overview(pendingServer, "plana");
    const arona = { ...agents.currentAgent.value!, id: "arona", name: "阿罗娜" };
    agents.currentAgentId.value = "arona";
    agents.currentAgent.value = arona;
    agents.agents.value = [arona];

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.findComponent(McpServerList).exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Remote Search");
  });
});

function mountView() {
  return shallowMount(AgentExtensionsView, {
    global: {
      stubs: {
        PageHeader: { template: "<header><slot name='actions' /></header>" },
        SkillList: { template: "<section><slot name='actions' /></section>" }
      }
    }
  });
}

function createExtensions() {
  return {
    overview: shallowRef<AgentExtensionOverview | null>(overview(pendingServer)),
    runtime: shallowRef({ servers: [] }),
    approvals: shallowRef([]),
    loading: shallowRef(false),
    busy: shallowRef(false),
    error: shallowRef(""),
    message: shallowRef(""),
    load: vi.fn().mockResolvedValue(undefined),
    installSkill: vi.fn(),
    reviewSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    removeSkill: vi.fn(),
    previewSkillCopy: vi.fn(),
    applySkillCopy: vi.fn(),
    previewMcpServer: vi.fn(),
    putMcpServer: vi.fn(),
    setMcpServerEnabled: vi.fn(),
    removeMcpServer: vi.fn(),
    loadMcpCatalog: vi.fn(),
    approveMcpTool: vi.fn(),
    beginOAuth: vi.fn().mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize",
      authorizationOrigin: "https://auth.example.test",
      expiresAt: "2026-07-17T00:10:00.000Z"
    }),
    refreshOAuth: vi.fn(),
    revokeOAuth: vi.fn(),
    clearFeedback: vi.fn()
  };
}

function createAgents() {
  const current = {
    id: "plana",
    name: "普拉娜",
    enabled: true,
    workspace: "workspace/business/agents/plana",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    accounts: []
  };
  return {
    agents: shallowRef([current]),
    currentAgentId: shallowRef("plana"),
    currentAgent: shallowRef(current),
    load: vi.fn().mockResolvedValue([current])
  };
}

function requiredExtensions() {
  if (!dependencies.extensions) throw new Error("Missing extensions mock");
  return dependencies.extensions;
}

function overview(server: AgentMcpHttpServer, agentId = "plana"): AgentExtensionOverview {
  return {
    schemaVersion: 1,
    agentId,
    skills: [],
    mcp: {
      servers: [server],
      secrets: { configuredKeys: [], missingKeys: [] }
    }
  };
}

const oauthInput = {
  authorizationEndpoint: "https://auth.example.test/authorize",
  tokenEndpoint: "https://auth.example.test/token",
  clientId: "sunabot-web",
  scopes: ["tools"]
};

const pendingServer: AgentMcpHttpServer = {
  id: "remote-search",
  name: "Remote Search",
  description: "远程搜索服务。",
  enabled: true,
  transport: "streamable_http",
  url: "https://mcp.example.test/v1",
  auth: { kind: "oauth", credentialRef: "pending" }
};

const connectedServer: AgentMcpHttpServer = {
  ...pendingServer,
  auth: { kind: "oauth", credentialRef: `mcpcred_${"A".repeat(24)}` }
};
