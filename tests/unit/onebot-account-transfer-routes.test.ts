// @vitest-environment node
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { NapcatLoginControlPort } from "../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { registerOneBotRoutes } from "../../apps/api/plugins/onebotRoutes.js";
import type { AgentAccount, AgentRegistry } from "../../services/agents/agentRegistry.js";

describe("OneBot account identity transfer routes", () => {
  it("does not let an old OneBot online response complete a new manual login", async () => {
    const control = {
      status: vi.fn(async () => ({ isLogin: true, online: true, manualLogin: true, data: { user_id: 985436737 } })),
      refreshQrCode: vi.fn(), beginManualLogin: vi.fn(), cancelManualLogin: vi.fn(),
      startLoginCompletionWatch: vi.fn(), close: vi.fn()
    } satisfies NapcatLoginControlPort;
    const gateway = {
      getStatus: () => ({ connected: true, accounts: [{ accountId: "primary" }] }),
      sendAction: vi.fn(async (action: string) => ({ data: action === "get_status" ? { online: true } : { user_id: 985436737 } }))
    } as unknown as OneBotGateway;
    const app = Fastify();
    registerOneBotRoutes(app, gateway, { napcatLoginControl: control });
    try {
      const result = await app.inject({ method: "GET", url: "/api/onebot/qq-login/status" });
      expect(result.json()).toMatchObject({ connected: true, online: false, authenticated: false, phase: "restarting" });
    } finally { await app.close(); }
  });

  it("coalesces recovery across route aliases, keeps other accounts independent and audits without credentials", async () => {
    const primary = account("primary", "plana", "985436737");
    const other = account("other", "arona", "123456789");
    let releaseRestart!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRestart = resolve; });
    const restarted = new Set<string>();
    const controls = new Map<string, NapcatLoginControlPort>();
    const controlFor = (id: string) => {
      const control = {
        status: vi.fn(async () => restarted.has(id)
          ? { isLogin: false, manualLogin: true, imageDataUrl: "data:image/png;base64,FRESH" }
          : { isLogin: true, manualLogin: false, loginError: "[KICKEDOFFLINE] expired" }),
        refreshQrCode: vi.fn(), beginManualLogin: vi.fn(), cancelManualLogin: vi.fn(),
        startLoginCompletionWatch: vi.fn(), close: vi.fn()
      };
      controls.set(id, control);
      return control;
    };
    const registry = { account: (id: string) => id === "primary" ? primary : other } as AgentRegistry;
    const gateway = { getStatus: () => ({ connected: false, accounts: [] }) } as unknown as OneBotGateway;
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (value: string) => { logs.push(value); } } } });
    const restartAccount = vi.fn(async (id: string) => {
      if (id === "primary") await blocked;
      restarted.add(id);
    });
    registerOneBotRoutes(app, gateway, {
      agentRegistry: registry, napcatLoginControlFactory: controlFor, restartAccount,
      authorizationSessionBinding: () => "session:private-binding"
    });
    try {
      const first = app.inject({ method: "POST", url: "/api/onebot/qq-login" }).then((value) => value);
      await vi.waitFor(() => expect(restartAccount).toHaveBeenCalledWith("primary"));
      const second = app.inject({ method: "POST", url: "/api/agents/plana/accounts/primary/login" }).then((value) => value);
      const independent = await app.inject({ method: "POST", url: "/api/agents/arona/accounts/other/login" });
      expect(independent.statusCode).toBe(200);
      await vi.waitFor(() => expect(logs.some((line) => line.includes('"outcome":"joined"'))).toBe(true));
      releaseRestart();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect(controls.get("primary")!.beginManualLogin).toHaveBeenCalledOnce();
      expect(restartAccount.mock.calls.filter(([id]) => id === "primary")).toHaveLength(1);
      const audit = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "qq.login.operation");
      expect(audit).toContainEqual(expect.objectContaining({ action: "login", outcome: "completed", accountId: "primary", sessionTag: expect.stringMatching(/^[a-f0-9]{16}$/) }));
      expect(JSON.stringify(audit)).not.toContain("private-binding");
    } finally { releaseRestart(); await app.close(); }
  });

  it("releases a failed recovery so a later explicit request can retry", async () => {
    const control = {
      status: vi.fn(async () => ({ isLogin: true, manualLogin: false, loginError: "[KICKEDOFFLINE] expired" })),
      refreshQrCode: vi.fn(), beginManualLogin: vi.fn(), cancelManualLogin: vi.fn(),
      startLoginCompletionWatch: vi.fn(), close: vi.fn()
    } satisfies NapcatLoginControlPort;
    const gateway = { getStatus: () => ({ connected: false, accounts: [] }) } as unknown as OneBotGateway;
    const restartAccount = vi.fn().mockRejectedValueOnce(new Error("runtime failed token=private-restart-token")).mockResolvedValue(undefined);
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (value: string) => { logs.push(value); } } } });
    const authorizationSessionBinding = vi.fn(() => "session:private-session-token");
    registerOneBotRoutes(app, gateway, { napcatLoginControl: control, restartAccount, authorizationSessionBinding });
    try {
      expect((await app.inject({ method: "POST", url: "/api/onebot/qq-login" })).statusCode).toBe(502);
      expect((await app.inject({ method: "POST", url: "/api/onebot/qq-login" })).statusCode).toBe(200);
      expect(restartAccount).toHaveBeenCalledTimes(2);
      expect(control.startLoginCompletionWatch).toHaveBeenCalledOnce();
      expect(authorizationSessionBinding).toHaveBeenCalledTimes(2);
      expect(logs.join("")).not.toContain("private-restart-token");
      expect(logs.join("")).not.toContain("private-session-token");
      expect(logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: "qq.login.operation", action: "login", outcome: "failed", errorCode: "QQ_LOGIN_RECOVERY_FAILED" }));
    } finally { await app.close(); }
  });

  it("shares logout aliases and lets a login request await that recovery", async () => {
    const primary = account("primary", "plana", "985436737");
    let releaseRestart!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRestart = resolve; });
    let restarted = false;
    const control = {
      status: vi.fn(async () => restarted
        ? { isLogin: false, manualLogin: true, imageDataUrl: "data:image/png;base64,PRIVATE_QR" }
        : { isLogin: true, online: true, manualLogin: false, data: { user_id: 985436737 } }),
      refreshQrCode: vi.fn(), beginManualLogin: vi.fn(), cancelManualLogin: vi.fn(),
      startLoginCompletionWatch: vi.fn(), close: vi.fn()
    } satisfies NapcatLoginControlPort;
    const registry = { account: () => primary, clearAccountIdentity: vi.fn() } as unknown as AgentRegistry;
    const gateway = { getStatus: () => ({ connected: false, accounts: [] }) } as unknown as OneBotGateway;
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (value: string) => { logs.push(value); } } } });
    const restartAccount = vi.fn(async () => { await blocked; restarted = true; });
    registerOneBotRoutes(app, gateway, { napcatLoginControl: control, agentRegistry: registry, restartAccount });
    try {
      const logout = app.inject({ method: "POST", url: "/api/onebot/qq-logout", headers: { cookie: "private-cookie", authorization: "Bearer private-token" } }).then((value) => value);
      await vi.waitFor(() => expect(restartAccount).toHaveBeenCalledOnce());
      const alias = app.inject({ method: "POST", url: "/api/agents/plana/accounts/primary/logout" }).then((value) => value);
      const login = app.inject({ method: "POST", url: "/api/agents/plana/accounts/primary/login" }).then((value) => value);
      await vi.waitFor(() => expect(logs.some((line) => line.includes('"outcome":"joined"'))).toBe(true));
      releaseRestart();
      expect((await logout).statusCode).toBe(200);
      expect((await alias).statusCode).toBe(200);
      expect((await login).json()).toMatchObject({ phase: "waiting_scan" });
      expect(control.beginManualLogin).toHaveBeenCalledOnce();
      expect(control.refreshQrCode).not.toHaveBeenCalled();
      expect(registry.clearAccountIdentity).toHaveBeenCalledOnce();
      const audit = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "qq.login.operation");
      expect(audit).toContainEqual(expect.objectContaining({ action: "logout", outcome: "completed", route: "/api/onebot/qq-logout" }));
      expect(audit).toContainEqual(expect.objectContaining({ action: "logout", outcome: "joined", route: "/api/agents/:agentId/accounts/:accountId/logout" }));
      expect(logs.join("")).not.toMatch(/private-cookie|private-token|PRIVATE_QR/);
    } finally { releaseRestart(); await app.close(); }
  });

  it("does not report cached identity as online or reset an authenticated offline session", async () => {
    const control = {
      status: vi.fn(async () => ({ isLogin: true, online: false, manualLogin: false, data: { user_id: 985436737 } })),
      refreshQrCode: vi.fn(), beginManualLogin: vi.fn(), cancelManualLogin: vi.fn(),
      startLoginCompletionWatch: vi.fn(), close: vi.fn()
    } satisfies NapcatLoginControlPort;
    const gateway = {
      getStatus: () => ({ connected: true, accounts: [{ accountId: "primary" }] }),
      sendAction: vi.fn(async (action: string) => ({ data: action === "get_status" ? { online: false } : { user_id: 985436737 } })),
      dispatchAction: vi.fn(async () => undefined)
    } as unknown as OneBotGateway;
    const app = Fastify();
    const restartAccount = vi.fn();
    registerOneBotRoutes(app, gateway, { napcatLoginControl: control, restartAccount });
    try {
      const response = await app.inject({ method: "GET", url: "/api/onebot/qq-login/status" });
      expect(response.json()).toMatchObject({ connected: true, online: false, authenticated: true, phase: "reconnecting" });
      expect(gateway.sendAction).toHaveBeenCalledWith("get_status", {}, "primary");
      const refresh = await app.inject({ method: "POST", url: "/api/onebot/qq-login" });
      expect(refresh.json()).toMatchObject({ online: false, authenticated: true });
      expect(control.refreshQrCode).not.toHaveBeenCalled();
      expect(control.beginManualLogin).not.toHaveBeenCalled();
      expect(restartAccount).not.toHaveBeenCalled();
      expect(gateway.dispatchAction).not.toHaveBeenCalled();
      const logout = await app.inject({ method: "POST", url: "/api/onebot/qq-logout" });
      expect(logout.statusCode, logout.body).toBe(200);
      expect(control.beginManualLogin).toHaveBeenCalledOnce();
      expect(restartAccount).toHaveBeenCalledWith("primary");
    } finally {
      await app.close();
    }
  });

  it("completes the current login after automatically releasing the previous account", async () => {
    const source = account("source", "agent-source", "123456789");
    const target = account("target", "agent-target");
    const controls = new Map<string, NapcatLoginControlPort>();
    const controlFor = (accountId: string) => {
      let control = controls.get(accountId);
      if (!control) {
        control = {
          status: vi.fn(async () => accountId === target.id
            ? { isLogin: true, online: true, manualLogin: false, data: { user_id: 123456789 } }
            : { isLogin: true, online: true, manualLogin: false, data: { user_id: 123456789 } }),
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
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (value: string) => { logs.push(value); } } } });
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
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: "qq.login.operation", action: "identity_transfer", outcome: "completed",
      accountId: "target", previousAccountId: "source", route: "/api/agents/:agentId/accounts/:accountId/login/status"
    }));
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
