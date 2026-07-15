import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "../types";
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
    runtime.status.value = null;
    runtime.error.value = "状态服务不可用";
    runtime.refresh.mockClear();
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/plana/accounts/primary/login/status") return Promise.resolve({ connected: false, online: false });
      if (path === "/api/onebot/login-info") return Promise.resolve({ connected: false });
      if (path === "/api/conversations") return Promise.resolve({ conversations: [] });
      if (path === "/api/images") return Promise.resolve({ images: [] });
      if (path.startsWith("/api/token-usage?")) return Promise.resolve({
        today: { date: "2026-07-10", input: 0, output: 0, cachedInput: 0, total: 0, cacheRate: null, requests: 0 },
        days: [],
        hours: []
      });
      throw new Error(`Unexpected request: ${path}`);
    });
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
