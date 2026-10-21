import fs, { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  NapcatLoginControl,
  type NapcatLoginControlPort,
  type NapcatLoginSnapshot
} from "../../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../../packages/platform/projectPaths.js";
import { readRemoteNapcatSync, createRemoteLoginFiles } from "../../../packages/platform/remoteNapcat.mjs";
import type { OneBotLoginCheck, OneBotQrLogin } from "../../../packages/contracts/admin/public.js";
import { AdminApiError, conflict, notFound } from "../../../src/admin/errors.js";
import type { AgentRegistry } from "../../../services/agents/agentRegistry.js";
import { AccountIdentityCoordinator } from "../../../services/agents/accountIdentityCoordinator.js";
import type { AgentAccountRegistryRow } from "../../../adapters/sqlite/applicationDataStore.js";
import { applicationDataStore } from "../../../adapters/sqlite/applicationDataStore.js";

const openObject = { type: "object", additionalProperties: true } as const;

export interface OneBotRouteOptions {
  napcatLoginControl?: NapcatLoginControlPort;
  napcatLoginControlFactory?: (accountId: string, webuiPort?: number) => NapcatLoginControlPort;
  agentRegistry?: AgentRegistry;
  restartAccount?: (accountId: string) => Promise<void>;
  authorizationSessionBinding?: (request: FastifyRequest) => string;
}

export function registerOneBotRoutes(app: FastifyInstance, onebotGateway: OneBotGateway, options: OneBotRouteOptions = {}) {
  const loginControlFactory = options.napcatLoginControlFactory ?? createNapcatLoginControl;
  const primaryWebuiPort = options.agentRegistry?.account("primary")?.webuiPort;
  const napcatLoginControl = options.napcatLoginControl ?? loginControlFactory("primary", primaryWebuiPort);
  const accountControls = new Map<string, NapcatLoginControlPort>([["primary", napcatLoginControl]]);
  const accountOperations = new Map<string, Promise<unknown>>();
  const recoveries = new Map<string, Promise<void>>();
  const auditSessions = new WeakMap<FastifyRequest, string | undefined>();
  const audit = (request: FastifyRequest, accountId: string, action: string, outcome: string, detail: Record<string, unknown> = {}) => {
    if (!auditSessions.has(request)) {
      const binding = options.authorizationSessionBinding?.(request);
      auditSessions.set(request, binding ? crypto.createHash("sha256").update(binding).digest("hex").slice(0, 16) : undefined);
    }
    request.log.info({
      event: "qq.login.operation", accountId, action, outcome,
      requestId: request.id, route: request.routeOptions.url, clientAddress: request.ip,
      clientAgent: request.headers["user-agent"]?.slice(0, 256),
      sessionTag: auditSessions.get(request),
      ...detail
    }, "QQ login operation");
  };
  const operation = async <T>(request: FastifyRequest, accountId: string, action: string, run: () => Promise<T>): Promise<T> => {
    const key = `${accountId}:${action}`;
    const existing = accountOperations.get(key);
    audit(request, accountId, action, existing ? "joined" : "started");
    const pending = existing ?? Promise.resolve().then(run);
    if (!existing) accountOperations.set(key, pending);
    try {
      const result = await pending as T;
      audit(request, accountId, action, "completed");
      return result;
    } catch (error) {
      audit(request, accountId, action, "failed", { errorCode: error instanceof AdminApiError ? error.code : "OPERATION_FAILED" });
      throw error;
    } finally {
      if (!existing && accountOperations.get(key) === pending) accountOperations.delete(key);
    }
  };
  const accountControl = (account: AgentAccountRegistryRow) => {
    let control = accountControls.get(account.id);
    if (!control) {
      control = loginControlFactory(account.id, account.webuiPort);
      accountControls.set(account.id, control);
    }
    return control;
  };
  const restartAccount = async (accountId: string) => {
    if (!options.restartAccount) {
      throw new AdminApiError(503, "ACCOUNT_RUNTIME_UNAVAILABLE", "QQ 登录恢复服务不可用。请执行 ./sunabot.sh restart。");
    }
    await options.restartAccount(accountId);
  };
  const recoverLogin = (request: FastifyRequest, accountId: string, control: NapcatLoginControlPort) => {
    const existing = recoveries.get(accountId);
    if (existing) return existing;
    const pending = (async () => {
      await control.beginManualLogin();
      if (onebotGateway.getStatus().accounts?.some((item) => item.accountId === accountId)) {
        try {
          await onebotGateway.dispatchAction("bot_exit", {}, accountId, true);
          audit(request, accountId, "bot_exit", "dispatched");
        } catch {
          // Exiting QQ can close OneBot before acknowledgement; the runtime restart still completes recovery.
          audit(request, accountId, "bot_exit", "dispatch_failed");
        }
      }
      try {
        await restartAccount(accountId);
      } catch (error) {
        audit(request, accountId, "runtime_restart", "failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
        throw new AdminApiError(502, "QQ_LOGIN_RECOVERY_FAILED", "QQ 登录恢复失败，请稍后重试。");
      }
      control.startLoginCompletionWatch();
    })().finally(() => { if (recoveries.get(accountId) === pending) recoveries.delete(accountId); });
    recoveries.set(accountId, pending);
    return pending;
  };
  const identityCoordinator = options.agentRegistry
    ? new AccountIdentityCoordinator({
        registry: options.agentRegistry,
        controlFor: accountControl,
        gateway: {
          isConnected: (accountId) => Boolean(onebotGateway.getStatus().accounts?.some((item) => item.accountId === accountId)),
          exit: (accountId) => onebotGateway.dispatchAction("bot_exit", {}, accountId, true)
        },
        restartAccount
      })
    : undefined;
  app.addHook("onClose", async () => {
    for (const control of accountControls.values()) control.close();
  });

  app.get("/api/onebot/login-info", { schema: { response: { 200: openObject } } }, async () => {
    const status = onebotGateway.getStatus();
    if (!status.connected) return { connected: false, error: "OneBot 未连接。" };

    try {
      const payload = await onebotGateway.sendAction("get_login_info", {});
      const response = payload as { data?: { user_id?: number; nickname?: string }; retcode?: number; status?: string };
      return {
        connected: true,
        data: response.data ?? {},
        retcode: response.retcode,
        status: response.status
      };
    } catch (error) {
      return { connected: status.connected, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/onebot/qq-login", { schema: { response: { 200: openObject } } }, async (request) => operation(request, "primary", "login", async () => {
    const recovery = recoveries.get("primary");
    if (recovery) { await recovery; return getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary"); }
    const current = await getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary");
    if (current.online || current.authenticated) return current;
    if (current.action === "recover_login") {
      await recoverLogin(request, "primary", napcatLoginControl);
      return getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary");
    }
    const refreshed = await napcatLoginControl.refreshQrCode();
    return getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary", refreshed);
  }));

  app.get("/api/onebot/qq-login/status", { schema: { response: { 200: openObject } } }, async () => {
    return getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary");
  });

  app.post("/api/onebot/qq-logout", { schema: { response: { 200: openObject } } }, async (request) => operation(request, "primary", "logout", async () => {
    const current = await getQqLoginSnapshot(onebotGateway, napcatLoginControl, "primary");
    if (!current.online && !current.authenticated) conflict("QQ_ALREADY_OFFLINE", "QQ 当前未登录。");
    await recoverLogin(request, "primary", napcatLoginControl);
    await options.agentRegistry?.clearAccountIdentity("primary");
    return {
      ok: true,
      connected: false,
      online: false,
      available: true,
      phase: "restarting",
      webuiUrl: getLocalNapcatWebuiRoute("primary")
    };
  }));

  app.get("/api/onebot/napcat-webui-url", { schema: { response: { 200: openObject } } }, async () => {
    const webuiUrl = getNapcatWebuiUrl("primary", { includeToken: true });
    if (!webuiUrl) notFound("NAPCAT_WEBUI_NOT_FOUND", "NapCat WebUI 未配置。");
    return { url: webuiUrl };
  });

  if (options.agentRegistry) {
    const registry = options.agentRegistry;
    const resolveAccount = (params: unknown) => {
      const { agentId, accountId } = params as { agentId: string; accountId: string };
      const account = registry.account(accountId);
      if (!account || account.agentId !== agentId) notFound("AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
      return account;
    };
    const snapshot = async (request: FastifyRequest, account: AgentAccountRegistryRow, refreshed?: NapcatLoginSnapshot) => {
      const result = await getQqLoginSnapshot(onebotGateway, accountControl(account), account.id, refreshed);
      if (result.online && result.action !== "recover_login" && result.data?.user_id && String(result.data.user_id) !== account.qqId) {
        const assignment = await operation(request, account.id, "identity_assignment", () => identityCoordinator!.assign(account.id, String(result.data!.user_id)));
        if (assignment.transferred) audit(request, account.id, "identity_transfer", "completed", { previousAccountId: assignment.previousAccount?.id });
      }
      return result;
    };

    app.get("/api/agents/:agentId/accounts/:accountId/login/status", { schema: { response: { 200: openObject } } }, async (request) => {
      const account = resolveAccount(request.params);
      return snapshot(request, account);
    });

    app.post("/api/agents/:agentId/accounts/:accountId/login", { schema: { response: { 200: openObject } } }, async (request) => {
      const account = resolveAccount(request.params);
      return operation(request, account.id, "login", async () => {
        const recovery = recoveries.get(account.id);
        if (recovery) { await recovery; return snapshot(request, account); }
        const current = await snapshot(request, account);
        if (current.online || current.authenticated) return current;
        if (current.action === "recover_login") {
          await recoverLogin(request, account.id, accountControl(account));
          return snapshot(request, account);
        }
        return snapshot(request, account, await accountControl(account).refreshQrCode());
      });
    });

    app.post("/api/agents/:agentId/accounts/:accountId/logout", { schema: { response: { 200: openObject } } }, async (request) => {
      const account = resolveAccount(request.params);
      return operation(request, account.id, "logout", async () => {
        const control = accountControl(account);
        const current = await snapshot(request, account);
        if (!current.online && !current.authenticated) conflict("QQ_ALREADY_OFFLINE", "QQ 当前未登录。");
        await recoverLogin(request, account.id, control);
        await registry.clearAccountIdentity(account.id);
        return {
          ok: true,
          connected: false,
          online: false,
          available: true,
          phase: "restarting",
          webuiUrl: getLocalNapcatWebuiRoute(account.id)
        };
      });
    });

    app.get("/api/agents/:agentId/accounts/:accountId/napcat-webui-url", { schema: { response: { 200: openObject } } }, async (request) => {
      const account = resolveAccount(request.params);
      const url = getNapcatWebuiUrl(account.id, { includeToken: true });
      if (!url) notFound("NAPCAT_WEBUI_NOT_FOUND", "NapCat WebUI 未配置。");
      return { url };
    });

    app.get("/api/agents/:agentId/accounts/:accountId/chats", { schema: { response: { 200: openObject } } }, async (request) => {
      const account = resolveAccount(request.params);
      return getOneBotChats(onebotGateway, account.id);
    });
  }

  app.get("/api/onebot/events", { schema: { response: { 200: openObject } } }, async () => {
    return { events: onebotGateway.getRecentEvents() };
  });

  app.get("/api/onebot/chats", { schema: { response: { 200: openObject } } }, async () => {
    return getOneBotChats(onebotGateway);
  });
}

async function getOneBotChats(onebotGateway: OneBotGateway, accountId?: string) {
  const status = onebotGateway.getStatus();
  const connected = accountId
    ? Boolean(status.accounts?.some((account) => account.accountId === accountId))
    : status.connected;
  if (!connected) return { connected: false, private: [], groups: [] };
  const send = (action: string) => accountId
    ? onebotGateway.sendAction(action, {}, accountId)
    : onebotGateway.sendAction(action, {});
  const [friendResult, groupResult] = await Promise.allSettled([
    send("get_friend_list"),
    send("get_group_list")
  ]);
  return {
    connected: true,
    private: extractOneBotDataArray(friendResult).map((item) => ({
      userId: Number(item.user_id ?? item.userId ?? 0),
      nickname: String(item.nickname ?? item.remark ?? item.user_id ?? ""),
      remark: String(item.remark ?? "")
    })).filter((item) => item.userId > 0),
    groups: extractOneBotDataArray(groupResult).map((item) => ({
      groupId: Number(item.group_id ?? item.groupId ?? 0),
      groupName: String(item.group_name ?? item.groupName ?? item.group_id ?? ""),
      memberCount: Number(item.member_count ?? item.memberCount ?? 0),
      maxMemberCount: Number(item.max_member_count ?? item.maxMemberCount ?? 0)
    })).filter((item) => item.groupId > 0)
  };
}

async function getQqLoginSnapshot(
  onebotGateway: OneBotGateway,
  napcatLoginControl: NapcatLoginControlPort,
  accountId: string,
  napcatSnapshot?: NapcatLoginSnapshot
): Promise<OneBotQrLogin> {
  const [onebot, napcat] = await Promise.all([
    getOneBotLoginCheck(onebotGateway, accountId),
    napcatSnapshot ? Promise.resolve(napcatSnapshot) : napcatLoginControl.status()
  ]);
  const recoverLogin = /\[KICKEDOFFLINE\]/i.test(napcat.loginError ?? "");
  const online = !recoverLogin && !napcat.manualLogin && (napcat.online === false ? false : onebot.online || napcat.online === true);
  const data = onebot.data?.user_id ? onebot.data : napcat.data;
  const webuiUrl = getLocalNapcatWebuiRoute(accountId);
  return {
    connected: onebot.connected,
    online,
    authenticated: !recoverLogin && !napcat.manualLogin && napcat.isLogin,
    data,
    available: Boolean(webuiUrl || napcat.imageDataUrl),
    phase: recoverLogin ? "restarting" : loginPhase(online, onebot.connected, napcat),
    ...(recoverLogin ? { action: "recover_login" } : {}),
    loginError: recoverLogin ? undefined : napcat.loginError,
    error: napcat.manualLogin || recoverLogin || online ? undefined : napcat.error ?? (napcat.online === undefined ? onebot.error : undefined),
    imageDataUrl: online ? undefined : napcat.imageDataUrl,
    imageUpdatedAt: online ? undefined : napcat.imageUpdatedAt,
    imageExpiresAt: online ? undefined : napcat.imageExpiresAt,
    webuiUrl
  };
}

function loginPhase(online: boolean, connected: boolean, napcat: NapcatLoginSnapshot): OneBotQrLogin["phase"] {
  if (online) return connected ? "online" : "connecting";
  if (napcat.manualLogin && !napcat.imageDataUrl) return "restarting";
  if (napcat.isLogin) return "reconnecting";
  if (napcat.loginError && /二维码.*(?:过期|失效)|(?:过期|失效).*二维码/i.test(napcat.loginError)) return "expired";
  if (napcat.imageDataUrl || napcat.qrcodeUrl) return "waiting_scan";
  return "starting";
}

async function getOneBotLoginCheck(onebotGateway: OneBotGateway, accountId: string): Promise<OneBotLoginCheck> {
  const status = onebotGateway.getStatus();
  const connected = Boolean(status.accounts?.some((account) => account.accountId === accountId));
  if (!connected) return { connected: false, online: false };
  try {
    const [payload, state] = await Promise.all([
      onebotGateway.sendAction("get_login_info", {}, accountId),
      onebotGateway.sendAction("get_status", {}, accountId)
    ]);
    const response = payload as { data?: { user_id?: number; nickname?: string } };
    const runtime = state as { data?: { online?: boolean } };
    if (typeof runtime.data?.online !== "boolean") {
      return { connected: true, online: false, data: response.data ?? {}, error: "OneBot 在线状态未返回。" };
    }
    return { connected: true, online: runtime.data?.online === true, data: response.data ?? {} };
  } catch (error) {
    return { connected: true, online: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getLocalNapcatWebuiRoute(accountId: string) {
  if (!getNapcatWebuiUrl(accountId, { includeToken: false })) return undefined;
  if (accountId === "primary") return "/api/onebot/napcat-webui-url";
  const account = applicationDataStore().readAgentAccount(accountId);
  return account
    ? `/api/agents/${encodeURIComponent(account.agentId)}/accounts/${encodeURIComponent(account.id)}/napcat-webui-url`
    : undefined;
}

function createNapcatLoginControl(accountId: string, webuiPort?: number) {
  const accountRoot = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, accountId);
  const remote = readRemoteNapcatSync(getWorkspacePath());
  return new NapcatLoginControl({
    loginFiles: remote ? createRemoteLoginFiles(remote, accountId) : undefined,
    webuiConfigPath: path.join(accountRoot, "config-full", "webui.json"),
    webuiBaseUrl: typeof webuiPort === "number" && Number.isInteger(webuiPort) && webuiPort > 0
      ? `http://127.0.0.1:${webuiPort}`
      : undefined,
    qrCodePath: path.join(accountRoot, "qrcode.png"),
    manualLoginMarkerPath: path.join(accountRoot, "manual-login-required"),
    runtimeEnvPath: path.join(accountRoot, "account.env")
  });
}

function getNapcatWebuiUrl(accountId: string, options: { includeToken: boolean }) {
  const webuiConfig = readNapcatWebuiConfig(accountId);
  const account = applicationDataStore().readAgentAccount(accountId);
  const port = Number(account?.webuiPort ?? webuiConfig?.port ?? 6099);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  const url = new URL(`http://127.0.0.1:${port}/webui/`);
  const token = typeof webuiConfig?.token === "string" ? webuiConfig.token.trim() : "";
  if (options.includeToken && token) url.searchParams.set("token", token);
  return url.toString();
}

function readNapcatWebuiConfig(accountId: string) {
  const filePath = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, accountId, "config-full", "webui.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as { port?: number; token?: string };
  } catch {
    return null;
  }
}

function extractOneBotDataArray(result: PromiseSettledResult<unknown>) {
  if (result.status !== "fulfilled") return [];
  const payload = result.value as { data?: unknown };
  return Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
}
