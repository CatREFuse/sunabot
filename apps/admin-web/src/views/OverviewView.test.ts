import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount, RuntimeStatus } from "../types";
import OverviewView from "./OverviewView.vue";

const runtime = vi.hoisted(() => ({
  status: { value: null as RuntimeStatus | null },
  loading: { value: false },
  error: { value: "状态服务不可用" },
  refresh: vi.fn().mockResolvedValue(undefined)
}));
const apiRequest = vi.hoisted(() => vi.fn());
const agentsState = vi.hoisted(() => ({
  agents: { value: [{
    id: "plana",
    name: "普拉娜",
    enabled: true,
    workspace: "workspace/business/agents/plana",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    accounts: [{
      id: "primary",
      agentId: "plana",
      label: "主账号",
      enabled: true,
      webuiPort: 6099,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]
  }] },
  currentAgent: { value: null as null | {
    id: string;
    name: string;
    accounts: Array<{ id: string; agentId: string; label: string; qqId?: string }>;
  } },
  load: vi.fn().mockResolvedValue(undefined)
}));
agentsState.currentAgent.value = agentsState.agents.value[0];

vi.mock("../composables/useRuntimeStatus", () => ({ useRuntimeStatus: () => runtime }));
vi.mock("../composables/useAdminApi", () => ({ apiRequest }));
vi.mock("../composables/useAgents", () => ({ useAgents: () => agentsState }));

describe("OverviewView", () => {
  beforeEach(() => {
    setAccounts([account("primary", "主账号", 6099)]);
    runtime.status.value = null;
    runtime.error.value = "状态服务不可用";
    runtime.refresh.mockClear();
    apiRequest.mockReset();
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/plana/accounts/primary/login/status") return Promise.resolve({ connected: false, online: false });
      if (path === "/api/onebot/login-info") return Promise.resolve({ connected: false });
      if (path === "/api/conversations") return Promise.resolve({ conversations: [] });
      if (path === "/api/images") return Promise.resolve({ images: [] });
      if (path === "/api/overview/summary") return Promise.resolve({ conversations: 0, images: 0 });
      if (path.startsWith("/api/token-usage?")) return Promise.resolve({
        today: { date: "2026-07-10", input: 0, output: 0, cachedInput: 0, total: 0, cacheRate: null, requests: 0 },
        days: [],
        hours: []
      });
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("selects primary by identity, switches every QQ action to the chosen account, and labels the login session", async () => {
    setAccounts([
      account("secondary", "备用账号", 6100),
      account("primary", "主账号", 6099)
    ]);
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("/login/status")) {
        const secondary = path.includes("/secondary/");
        return Promise.resolve({ connected: true, online: true, data: { user_id: secondary ? 222 : 111, nickname: secondary ? "备用 Bot" : "主 Bot" } });
      }
      if (path === "/api/agents/plana/accounts/secondary/chats") return Promise.resolve({ connected: true, private: [], groups: [] });
      if (path === "/api/agents/plana/accounts/secondary/napcat-webui-url") return Promise.resolve({ url: "http://127.0.0.1:6100" });
      if (path === "/api/conversations") return Promise.resolve({ conversations: [] });
      if (path === "/api/images") return Promise.resolve({ images: [] });
      if (path === "/api/overview/summary") return Promise.resolve({ conversations: 0, images: 0 });
      if (path.startsWith("/api/token-usage?")) return Promise.resolve(emptyTokenUsage());
      throw new Error(`Unexpected request: ${path}`);
    });

    const wrapper = mount(OverviewView);
    await flushPromises();
    const selector = wrapper.get<HTMLSelectElement>('select[aria-label="当前 QQ 账号"]');
    expect(selector.element.value).toBe("primary");
    expect(selector.text()).toContain("主账号 · primary");

    await selector.setValue("secondary");
    await flushPromises();
    expect(wrapper.text()).toContain("备用 Bot");
    apiRequest.mockClear();

    await wrapper.findAll("button").find((button) => button.text().includes("联系人"))!.trigger("click");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text().includes("NapCat"))!.trigger("click");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text().includes("QQ 账号"))!.trigger("click");
    await flushPromises();

    const accountRequests = apiRequest.mock.calls.map(([path]) => String(path)).filter((path) => path.includes("/accounts/"));
    expect(accountRequests.every((path) => path.includes("/accounts/secondary/"))).toBe(true);
    expect(accountRequests).toContain("/api/agents/plana/accounts/secondary/chats");
    expect(accountRequests).toContain("/api/agents/plana/accounts/secondary/napcat-webui-url");
    expect(accountRequests).toContain("/api/agents/plana/accounts/secondary/login/status");
    expect(wrapper.text()).toContain("备用账号 · secondary");
    expect(openWindow).toHaveBeenCalledWith("http://127.0.0.1:6100", "_blank", "noopener,noreferrer");
    openWindow.mockRestore();
  });

  it("keeps QQ actions disabled when the current Agent has no accounts", async () => {
    setAccounts([]);
    const wrapper = mount(OverviewView);
    await flushPromises();

    const selector = wrapper.get<HTMLSelectElement>('select[aria-label="当前 QQ 账号"]');
    expect(selector.attributes()).toHaveProperty("disabled");
    expect(selector.text()).toContain("还没有 QQ 账号");
    expect(wrapper.findAll("button").find((button) => button.text().includes("联系人"))!.attributes()).toHaveProperty("disabled");
    expect(wrapper.findAll("button").find((button) => button.text().includes("NapCat"))!.attributes()).toHaveProperty("disabled");
    expect(wrapper.findAll("button").find((button) => button.text().includes("新增 QQ"))).toBeTruthy();
    expect(apiRequest.mock.calls.some(([path]) => String(path).includes("/accounts/"))).toBe(false);
  });

  it("shows an unknown QQ state when OneBot is connected but login lookup fails", async () => {
    runtime.status.value = {
      startedAt: "2026-07-10T00:00:00.000Z",
      configPath: "/tmp/config.json",
      onebot: { connected: true, connections: 1, selfIds: ["42"] },
      persona: { id: "plana", name: "普拉娜", memoryItems: 0 },
      provider: { defaultProviderId: "codex", model: "gpt-5.6-sol", imageModel: "gpt-image-2", apiKeyConfigured: true }
    };
    runtime.error.value = "";
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/plana/accounts/primary/login/status") return Promise.resolve({ connected: true, online: false, error: "登录查询失败" });
      if (path === "/api/onebot/login-info") return Promise.resolve({ connected: true, error: "登录查询失败" });
      if (path === "/api/conversations") return Promise.resolve({ conversations: [] });
      if (path === "/api/images") return Promise.resolve({ images: [] });
      if (path === "/api/overview/summary") return Promise.resolve({ conversations: 0, images: 0 });
      if (path.startsWith("/api/token-usage?")) return Promise.resolve({
        today: { date: "2026-07-10", input: 0, output: 0, cachedInput: 0, total: 0, cacheRate: null, requests: 0 },
        days: [],
        hours: []
      });
      throw new Error(`Unexpected request: ${path}`);
    });

    const wrapper = mount(OverviewView);
    await flushPromises();
    expect(wrapper.text()).toContain("OneBot 已连接，QQ 未知");
    expect(wrapper.get('[aria-label="Token 消耗统计"]').text()).toContain("缓存输入");
    expect(wrapper.get('[aria-label="Token 消耗统计"]').text()).toContain("缓存率");
  });

  it.each([
    {
      apiKeyConfigured: true,
      providerCompatibility: {},
      probeStatus: "pass" as const,
      expected: ["已验证可用"]
    },
    {
      apiKeyConfigured: false,
      providerCompatibility: {},
      probeStatus: "pass" as const,
      expected: ["已验证可用"]
    },
    {
      apiKeyConfigured: true,
      providerCompatibility: { configured: true, verifiedAvailable: true },
      probeStatus: "fail" as const,
      expected: ["当前不可用", "已配置"]
    },
    {
      apiKeyConfigured: false,
      providerCompatibility: {},
      probeStatus: undefined,
      expected: ["未配置", "前往设置"]
    }
  ])("shows the verified Provider state for $expected", async ({ apiKeyConfigured, providerCompatibility, probeStatus, expected }) => {
    runtime.status.value = {
      startedAt: "2026-07-10T00:00:00.000Z",
      configPath: "/tmp/config.json",
      onebot: { connected: true, connections: 1, selfIds: ["42"] },
      persona: { id: "plana", name: "普拉娜", memoryItems: 0 },
      provider: {
        defaultProviderId: "codex",
        model: "gpt-5.6-sol",
        imageModel: "gpt-image-2",
        apiKeyConfigured,
        ...providerCompatibility
      },
      ...(probeStatus ? { probe: {
        schemaVersion: 1,
        generatedAt: "2026-07-10T00:00:00.000Z",
        summary: { liveness: "live", readiness: probeStatus === "pass" ? "ready" : "not_ready", capability: "ready" },
        checks: [{
          id: "provider",
          kind: "readiness",
          status: probeStatus,
          code: probeStatus === "pass" ? null : "PROVIDER_NOT_READY",
          path: "/tmp/config.json",
          action: probeStatus === "pass" ? null : "在管理台选择并测试默认 Provider",
          detail: probeStatus === "pass" ? "ready" : "not ready"
        }],
        accounts: []
      } } : {})
    };
    runtime.error.value = "";

    const wrapper = mount(OverviewView);
    await flushPromises();
    const providerState = wrapper.findAll(".health-card")[1];
    expect(providerState.text()).toContain("Provider 状态");
    for (const text of expected) expect(providerState.text()).toContain(text);
    wrapper.unmount();
  });

  it("shows the status request error and never reports a failed refresh as updated", async () => {
    const wrapper = mount(OverviewView);
    await flushPromises();
    expect(wrapper.text()).toContain("状态服务不可用");
    expect(wrapper.text()).not.toContain("[ERROR");

    await wrapper.get('button[aria-label="刷新"]').trigger("click");
    await flushPromises();
    expect(runtime.refresh).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("状态服务不可用");
    expect(wrapper.text()).not.toContain("已更新");
  });
});

function account(id: string, label: string, webuiPort: number): AgentAccount {
  return {
    id,
    agentId: "plana",
    label,
    enabled: true,
    webuiPort,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function setAccounts(accounts: AgentAccount[]) {
  const agent = {
    id: "plana",
    name: "普拉娜",
    enabled: true,
    workspace: "workspace/business/agents/plana",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    accounts
  };
  agentsState.agents.value = [agent];
  agentsState.currentAgent.value = agent;
}

function emptyTokenUsage() {
  return {
    today: { date: "2026-07-10", input: 0, output: 0, cachedInput: 0, total: 0, cacheRate: null, requests: 0 },
    days: [],
    hours: []
  };
}
