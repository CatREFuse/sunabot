// @vitest-environment node
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { NapcatLoginControlPort } from "../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { registerOneBotRoutes } from "../../apps/api/plugins/onebotRoutes.js";
import type { AgentAccount, AgentRegistry } from "../../services/agents/agentRegistry.js";

describe("OneBot account identity transfer routes", () => {
  it("completes the current login after automatically releasing the previous account", async () => {
    const source = account("source", "agent-source", "123456789");
    const target = account("target", "agent-target");
    const controls = new Map<string, NapcatLoginControlPort>();
    const controlFor = (accountId: string) => {
      let control = controls.get(accountId);
      if (!control) {
        control = {
          status: vi.fn(async () => accountId === target.id
            ? { isLogin: true, manualLogin: false, data: { user_id: 123456789 } }
            : { isLogin: true, manualLogin: false, data: { user_id: 123456789 } }),
          refreshQrCode: vi.fn(),
          beginManualLogin: vi.fn(async () => undefined),
          cancelManualLogin: vi.fn(async () => undefined),
          startLoginCompletionWatch: vi.fn(),
          close: vi.fn()
        };
        controls.set(accountId, control);
      }
      return control;
    };
    const registry = {
      account: vi.fn((accountId: string) => accountId === source.id ? source : accountId === target.id ? target : undefined),
      list: vi.fn(async () => [
        { id: source.agentId, accounts: [source] },
        { id: target.agentId, accounts: [target] }
      ]),
      updateAccountIdentity: vi.fn(async (_accountId: string, qqId: string) => ({ ...target, qqId }))
    } as unknown as AgentRegistry;
    const gateway = {
      getStatus: vi.fn(() => ({
        connected: true,
        accounts: [
          { accountId: source.id, selfId: source.qqId, connectedAt: "2026-08-05T00:00:00.000Z" },
          { accountId: target.id, selfId: "123456789", connectedAt: "2026-08-05T00:00:01.000Z" }
        ]
      })),
      sendAction: vi.fn(async (_action: string, _params: Record<string, unknown>, accountId: string) => ({
        data: accountId === target.id ? { user_id: 123456789, nickname: "target" } : {}
      })),
      dispatchAction: vi.fn(async () => undefined),
      getRecentEvents: vi.fn(() => [])
    } as unknown as OneBotGateway;
    const app = Fastify();
    const restartAccount = vi.fn(async () => undefined);
    registerOneBotRoutes(app, gateway, {
      agentRegistry: registry,
      napcatLoginControlFactory: (accountId) => controlFor(accountId),
      restartAccount
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${target.agentId}/accounts/${target.id}/login/status`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ online: true, data: { user_id: 123456789 } });
    expect(controls.get(source.id)?.beginManualLogin).toHaveBeenCalledOnce();
    expect(gateway.dispatchAction).toHaveBeenCalledWith("bot_exit", {}, source.id, true);
    expect(restartAccount).toHaveBeenCalledWith(source.id);
    expect(registry.updateAccountIdentity).toHaveBeenCalledWith(target.id, "123456789", undefined, true);
    await app.close();
  });

  it("restarts a kicked account and returns a fresh login QR", async () => {
    const primary = account("primary", "plana", "985436737");
    let restarted = false;
    const control = {
      status: vi.fn(async () => restarted
        ? {
            isLogin: false,
            manualLogin: true,
            imageDataUrl: "data:image/png;base64,FRESH",
            imageUpdatedAt: "2026-08-05T00:00:00.000Z"
          }
        : {
            isLogin: true,
            manualLogin: false,
            loginError: "[KICKEDOFFLINE] [下线通知] 您的账号已在另一台终端登录。",
            data: { user_id: 985436737, nickname: "A.R.O.N.A" }
          }),
      refreshQrCode: vi.fn(),
      beginManualLogin: vi.fn(async () => undefined),
      cancelManualLogin: vi.fn(async () => undefined),
      startLoginCompletionWatch: vi.fn(),
      close: vi.fn()
    } satisfies NapcatLoginControlPort;
    const registry = {
      account: vi.fn(() => primary),
      list: vi.fn(async () => [{ id: "plana", accounts: [primary] }]),
      updateAccountIdentity: vi.fn(async () => primary)
    } as unknown as AgentRegistry;
    const gateway = {
      getStatus: vi.fn(() => ({
        connected: !restarted,
        accounts: restarted ? [] : [{ accountId: "primary", selfId: "985436737", connectedAt: "2026-08-05T00:00:00.000Z" }]
      })),
      sendAction: vi.fn(async () => ({ data: { user_id: 985436737, nickname: "A.R.O.N.A" } })),
      dispatchAction: vi.fn(async () => undefined),
      getRecentEvents: vi.fn(() => [])
    } as unknown as OneBotGateway;
    const restartAccount = vi.fn(async () => { restarted = true; });
    const app = Fastify();
    registerOneBotRoutes(app, gateway, {
      agentRegistry: registry,
      napcatLoginControl: control,
      napcatLoginControlFactory: () => control,
      restartAccount
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/agents/plana/accounts/primary/login/status"
    });
    expect(status.json()).toMatchObject({
      connected: true,
      online: false,
      phase: "restarting",
      action: "recover_login"
    });
    expect(status.json()).not.toHaveProperty("loginError");

    const recovery = await app.inject({
      method: "POST",
      url: "/api/agents/plana/accounts/primary/login"
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toMatchObject({
      connected: false,
      online: false,
      phase: "waiting_scan",
      imageDataUrl: "data:image/png;base64,FRESH"
    });
    expect(control.beginManualLogin).toHaveBeenCalledOnce();
    expect(gateway.dispatchAction).toHaveBeenCalledWith("bot_exit", {}, "primary", true);
    expect(restartAccount).toHaveBeenCalledWith("primary");
    expect(control.refreshQrCode).not.toHaveBeenCalled();
    await app.close();
  });
});

function account(id: string, agentId: string, qqId?: string): AgentAccount {
  return {
    id,
    agentId,
    label: id,
    qqId,
    enabled: true,
    webuiPort: id === "source" ? 6099 : 6100,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}
