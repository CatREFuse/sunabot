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
    registerOneBotRoutes(app, gateway, {
      agentRegistry: registry,
      napcatLoginControlFactory: (accountId) => controlFor(accountId)
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${target.agentId}/accounts/${target.id}/login/status`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ online: true, data: { user_id: 123456789 } });
    expect(controls.get(source.id)?.beginManualLogin).toHaveBeenCalledOnce();
    expect(gateway.dispatchAction).toHaveBeenCalledWith("bot_exit", {}, source.id, true);
    expect(registry.updateAccountIdentity).toHaveBeenCalledWith(target.id, "123456789", undefined, true);
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
