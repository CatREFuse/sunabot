// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOneBotRoutes } from "../../apps/api/plugins/onebotRoutes.js";
import type { NapcatLoginControlPort } from "../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";

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

  it("marks manual login before dispatching bot_exit", async () => {
    const control = loginControl({
      status: vi.fn(async () => ({
        isLogin: true,
        manualLogin: false,
        data: { user_id: 985436737, nickname: "测试 Bot" }
      }))
    });
    const dispatchAction = vi.fn(async () => undefined);
    const app = Fastify();
    apps.push(app);
    registerOneBotRoutes(app, {
      getStatus: () => ({ connected: true }),
      getRecentEvents: () => [],
      sendAction: vi.fn(async () => ({ data: { user_id: 985436737, nickname: "测试 Bot" } })),
      dispatchAction
    } as unknown as OneBotGateway, { napcatLoginControl: control });

    const response = await app.inject({ method: "POST", url: "/api/onebot/qq-logout" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, online: false, phase: "restarting" });
    expect(control.beginManualLogin).toHaveBeenCalledOnce();
    expect(dispatchAction).toHaveBeenCalledWith("bot_exit", {});
    expect(control.startLoginCompletionWatch).toHaveBeenCalledOnce();
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
