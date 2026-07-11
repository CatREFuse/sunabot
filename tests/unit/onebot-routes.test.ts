// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOneBotRoutes } from "../../apps/api/plugins/onebotRoutes.js";
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
});
