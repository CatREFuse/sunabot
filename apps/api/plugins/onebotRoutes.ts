import fs, { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  NapcatLoginControl,
  type NapcatLoginControlPort,
  type NapcatLoginSnapshot
} from "../../../adapters/onebot/napcatLoginControl.js";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../../src/config.js";
import type { OneBotLoginCheck, OneBotQrLogin } from "../../../src/types.js";
import { AdminApiError, conflict, notFound } from "../../../src/admin/errors.js";

const openObject = { type: "object", additionalProperties: true } as const;

export interface OneBotRouteOptions {
  napcatLoginControl?: NapcatLoginControlPort;
}

export function registerOneBotRoutes(app: FastifyInstance, onebotGateway: OneBotGateway, options: OneBotRouteOptions = {}) {
  const napcatLoginControl = options.napcatLoginControl ?? createNapcatLoginControl();
  app.addHook("onClose", async () => napcatLoginControl.close());

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

  app.post("/api/onebot/qq-login", { schema: { response: { 200: openObject } } }, async () => {
    const current = await getQqLoginSnapshot(onebotGateway, napcatLoginControl);
    if (current.online) return current;
    const refreshed = await napcatLoginControl.refreshQrCode();
    return getQqLoginSnapshot(onebotGateway, napcatLoginControl, refreshed);
  });

  app.get("/api/onebot/qq-login/status", { schema: { response: { 200: openObject } } }, async () => {
    return getQqLoginSnapshot(onebotGateway, napcatLoginControl);
  });

  app.post("/api/onebot/qq-logout", { schema: { response: { 200: openObject } } }, async () => {
    const current = await getQqLoginSnapshot(onebotGateway, napcatLoginControl);
    if (!current.online || !onebotGateway.getStatus().connected) {
      conflict("QQ_ALREADY_OFFLINE", "QQ 当前未登录。");
    }
    await napcatLoginControl.beginManualLogin();
    try {
      await onebotGateway.dispatchAction("bot_exit", {});
    } catch (error) {
      await napcatLoginControl.cancelManualLogin();
      throw new AdminApiError(502, "QQ_LOGOUT_FAILED", error instanceof Error ? error.message : "QQ 退出失败。");
    }
    napcatLoginControl.startLoginCompletionWatch();
    return {
      ok: true,
      connected: false,
      online: false,
      available: true,
      phase: "restarting",
      webuiUrl: getLocalNapcatWebuiRoute()
    };
  });

  app.get("/api/onebot/napcat-webui-url", { schema: { response: { 200: openObject } } }, async () => {
    const webuiUrl = getNapcatWebuiUrl({ includeToken: true });
    if (!webuiUrl) notFound("NAPCAT_WEBUI_NOT_FOUND", "NapCat WebUI 未配置。");
    return { url: webuiUrl };
  });

  app.get("/api/onebot/events", { schema: { response: { 200: openObject } } }, async () => {
    return { events: onebotGateway.getRecentEvents() };
  });

  app.get("/api/onebot/chats", { schema: { response: { 200: openObject } } }, async () => {
    const status = onebotGateway.getStatus();
    if (!status.connected) return { connected: false, private: [], groups: [] };
    const [friendResult, groupResult] = await Promise.allSettled([
      onebotGateway.sendAction("get_friend_list", {}),
      onebotGateway.sendAction("get_group_list", {})
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
  });
}

async function getQqLoginSnapshot(
  onebotGateway: OneBotGateway,
  napcatLoginControl: NapcatLoginControlPort,
  napcatSnapshot?: NapcatLoginSnapshot
): Promise<OneBotQrLogin> {
  const [onebot, napcat] = await Promise.all([
    getOneBotLoginCheck(onebotGateway),
    napcatSnapshot ? Promise.resolve(napcatSnapshot) : napcatLoginControl.status()
  ]);
  const online = onebot.online || napcat.isLogin;
  const data = onebot.data?.user_id ? onebot.data : napcat.data;
  const webuiUrl = getLocalNapcatWebuiRoute();
  return {
    connected: onebot.connected,
    online,
    data,
    available: Boolean(webuiUrl || napcat.imageDataUrl),
    phase: loginPhase(online, onebot.connected, napcat),
    loginError: napcat.loginError,
    error: napcat.manualLogin ? undefined : napcat.error,
    imageDataUrl: online ? undefined : napcat.imageDataUrl,
    imageUpdatedAt: online ? undefined : napcat.imageUpdatedAt,
    webuiUrl
  };
}

function loginPhase(online: boolean, connected: boolean, napcat: NapcatLoginSnapshot): OneBotQrLogin["phase"] {
  if (online) return connected ? "online" : "connecting";
  if (napcat.manualLogin && !napcat.imageDataUrl) return "restarting";
  if (napcat.loginError && /二维码.*(?:过期|失效)|(?:过期|失效).*二维码/i.test(napcat.loginError)) return "expired";
  if (napcat.imageDataUrl || napcat.qrcodeUrl) return "waiting_scan";
  return "starting";
}

async function getOneBotLoginCheck(onebotGateway: OneBotGateway): Promise<OneBotLoginCheck> {
  const status = onebotGateway.getStatus();
  if (!status.connected) return { connected: false, online: false };
  try {
    const payload = await onebotGateway.sendAction("get_login_info", {});
    const response = payload as { data?: { user_id?: number; nickname?: string } };
    return { connected: true, online: Boolean(response.data?.user_id), data: response.data ?? {} };
  } catch (error) {
    return { connected: true, online: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getLocalNapcatWebuiRoute() {
  return getNapcatWebuiUrl({ includeToken: false }) ? "/api/onebot/napcat-webui-url" : undefined;
}

function createNapcatLoginControl() {
  return new NapcatLoginControl({
    webuiConfigPath: getWorkspacePath(WORKSPACE_LAYOUT.napcatConfig, "webui.json"),
    webuiBaseUrl: process.env.SUNABOT_RUNTIME_MODE === "docker" ? "http://napcat:6099" : undefined,
    qrCodePath: getWorkspacePath(WORKSPACE_LAYOUT.napcatQrCode),
    manualLoginMarkerPath: getWorkspacePath(WORKSPACE_LAYOUT.napcatManualLogin),
    runtimeEnvPath: getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv)
  });
}

function getNapcatWebuiUrl(options: { includeToken: boolean }) {
  const webuiConfig = readNapcatWebuiConfig();
  const port = Number(webuiConfig?.port ?? 6099);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  const url = new URL(`http://127.0.0.1:${port}/webui/`);
  const token = typeof webuiConfig?.token === "string" ? webuiConfig.token.trim() : "";
  if (options.includeToken && token) url.searchParams.set("token", token);
  return url.toString();
}

function readNapcatWebuiConfig() {
  const filePath = getWorkspacePath(WORKSPACE_LAYOUT.napcatConfig, "webui.json");
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
