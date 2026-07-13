// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOneBotRoutes } from "../../apps/api/plugins/onebotRoutes.js";
import type { NapcatLoginControlPort } from "../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { AgentAccountRegistryRow } from "../../adapters/sqlite/applicationDataStore.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("OneBot API plugin", () => {
  it("maps connected login, friend and group action responses", async () => {
    const sendAction = vi.fn(async (action: string) => {
      if (action === "get_login_info") return { status: "ok", retcode: 0, data: { user_id: 123456, nickname: "测试 Bot" } };
      if (action === "get_friend_list") return { data: [{ user_id: 171419991, nickname: "管理员", remark: "老师" }] };
      if (action === "get_group_list") return { data: [{ group_id: 987654, group_name: "测试群", member_count: 2, max_member_count: 200 }] };
      throw new Error(`unexpected action: ${action}`);
    });
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({ connected: true }),
      getRecentEvents: () => [{ post_type: "meta_event" }],
      sendAction
    } as unknown as OneBotGateway);

    const login = await app.inject({ method: "GET", url: "/api/onebot/login-info" });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ connected: true, retcode: 0, data: { user_id: 123456 } });
    const chats = await app.inject({ method: "GET", url: "/api/onebot/chats" });
    expect(chats.json()).toEqual({
      connected: true,
      private: [{ userId: 171419991, nickname: "管理员", remark: "老师" }],
      groups: [{ groupId: 987654, groupName: "测试群", memberCount: 2, maxMemberCount: 200 }]
    });
  });

  it("returns an explicit offline shape without actions", async () => {
    const sendAction = vi.fn();
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({ connected: false }),
      getRecentEvents: () => [],
      sendAction
    } as unknown as OneBotGateway);

    expect((await app.inject({ method: "GET", url: "/api/onebot/login-info" })).json())
      .toEqual({ connected: false, error: "OneBot 未连接。" });
    expect((await app.inject({ method: "GET", url: "/api/onebot/chats" })).json())
      .toEqual({ connected: false, private: [], groups: [] });
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("refreshes a NapCat QR without requiring a OneBot connection", async () => {
    const control = loginControl({
      status: vi.fn(async () => ({ isLogin: false, manualLogin: false })),
      refreshQrCode: vi.fn(async () => ({
        isLogin: false,
        manualLogin: false,
        qrcodeUrl: "https://txz.qq.com/example",
        imageDataUrl: "data:image/png;base64,AAAA",
        imageUpdatedAt: "2026-07-12T00:00:00.000Z"
      }))
    });
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({ connected: false }),
      getRecentEvents: () => [],
      sendAction: vi.fn()
    } as unknown as OneBotGateway, { napcatLoginControl: control });

    const response = await app.inject({ method: "POST", url: "/api/onebot/qq-login" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connected: false,
      online: false,
      available: true,
      phase: "waiting_scan",
      imageDataUrl: "data:image/png;base64,AAAA"
    });
    expect(control.refreshQrCode).toHaveBeenCalledOnce();
  });

  it("uses each registered account's host WebUI port for its login control", async () => {
    const account: AgentAccountRegistryRow = {
      id: "qq-arona",
      agentId: "arona",
      label: "阿罗娜 QQ",
      enabled: true,
      webuiPort: 6100,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    };
    const control = loginControl({
      status: vi.fn(async () => ({
        isLogin: false,
        manualLogin: false,
        imageDataUrl: "data:image/png;base64,AAAA"
      }))
    });
    const loginControlFactory = vi.fn(() => control);
    const registry = {
      account: vi.fn((accountId: string) => accountId === account.id ? account : undefined),
      updateAccountIdentity: vi.fn()
    } as unknown as AgentRegistry;
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({ connected: false, accounts: [] }),
      getRecentEvents: () => [],
      sendAction: vi.fn()
    } as unknown as OneBotGateway, {
      agentRegistry: registry,
      napcatLoginControl: loginControl(),
      napcatLoginControlFactory: loginControlFactory
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${account.agentId}/accounts/${account.id}/login/status`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      online: false,
      phase: "waiting_scan",
      imageDataUrl: "data:image/png;base64,AAAA"
    });
    expect(loginControlFactory).toHaveBeenCalledWith(account.id, 6100);
    expect(control.status).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "only primary", accountIds: ["primary"], expectedStatus: 200, expectedDeliveries: ["primary"] },
    {
      label: "primary and secondary",
      accountIds: ["primary", "qq-secondary"],
      expectedStatus: 200,
      expectedDeliveries: ["primary"]
    },
    { label: "only secondary", accountIds: ["qq-secondary"], expectedStatus: 502, expectedDeliveries: [] }
  ])("targets the primary account for legacy logout with $label connected", async ({
    accountIds,
    expectedStatus,
    expectedDeliveries
  }) => {
    const control = loginControl({
      status: vi.fn(async () => ({
        isLogin: true,
        manualLogin: false,
        data: { user_id: 985436737, nickname: "测试 Bot" }
      }))
    });
    const deliveries: string[] = [];
    const dispatchAction = vi.fn(async (_action: string, _params: Record<string, unknown>, accountId?: string) => {
      const requested = accountId?.trim() || "primary";
      const exact = accountIds.includes(requested) ? requested : undefined;
      const fallback = !accountId && accountIds.length === 1 ? accountIds[0] : undefined;
      const target = exact ?? fallback;
      if (!target) throw new Error("OneBot is not connected.");
      deliveries.push(target);
    });
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({
        connected: true,
        accounts: accountIds.map((accountId) => ({ accountId, connectedAt: "2026-07-14T00:00:00.000Z" }))
      }),
      getRecentEvents: () => [],
      sendAction: vi.fn(async () => ({ data: { user_id: 985436737, nickname: "测试 Bot" } })),
      dispatchAction
    } as unknown as OneBotGateway, { napcatLoginControl: control });

    const response = await app.inject({ method: "POST", url: "/api/onebot/qq-logout" });

    expect(response.statusCode).toBe(expectedStatus);
    expect(control.beginManualLogin).toHaveBeenCalledOnce();
    expect(dispatchAction).toHaveBeenCalledWith("bot_exit", {}, "primary");
    expect(deliveries).toEqual(expectedDeliveries);
    if (expectedStatus === 200) {
      expect(response.json()).toMatchObject({ ok: true, online: false, phase: "restarting" });
      expect(control.startLoginCompletionWatch).toHaveBeenCalledOnce();
      expect(control.cancelManualLogin).not.toHaveBeenCalled();
    } else {
      expect(response.json()).toMatchObject({ code: "QQ_LOGOUT_FAILED" });
      expect(control.cancelManualLogin).toHaveBeenCalledOnce();
      expect(control.startLoginCompletionWatch).not.toHaveBeenCalled();
    }
  });
});

function loginControl(overrides: Partial<NapcatLoginControlPort> = {}): NapcatLoginControlPort {
  return {
    status: vi.fn(async () => ({ isLogin: false, manualLogin: false })),
    refreshQrCode: vi.fn(async () => ({ isLogin: false, manualLogin: false })),
    beginManualLogin: vi.fn(async () => undefined),
    cancelManualLogin: vi.fn(async () => undefined),
    startLoginCompletionWatch: vi.fn(),
    close: vi.fn(),
    ...overrides
  };
}
