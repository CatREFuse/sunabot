import fs, { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../../src/config.js";
import type { OneBotLoginCheck, OneBotQrLogin } from "../../../src/types.js";
import { notFound } from "../../../src/admin/errors.js";

const openObject = { type: "object", additionalProperties: true } as const;

export function registerOneBotRoutes(app: FastifyInstance, onebotGateway: OneBotGateway) {
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
    const login = await getOneBotLoginCheck(onebotGateway);
    const localQr = readNapcatQrImage();
    const webuiUrl = getLocalNapcatWebuiRoute();
    const response: OneBotQrLogin = { ...login, available: Boolean(localQr || webuiUrl), webuiUrl };
    if (localQr) return { ...response, ...localQr };
    if (login.connected && !login.online) {
      const actionQr = await getOneBotActionQr(onebotGateway);
      if (actionQr) return { ...response, ...actionQr, available: true };
    }
    return response;
  });

  app.get("/api/onebot/qq-login/status", { schema: { response: { 200: openObject } } }, async () => {
    return getOneBotLoginCheck(onebotGateway);
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

async function getOneBotActionQr(onebotGateway: OneBotGateway) {
  for (const action of ["get_qrcode", "get_qr_code", "get_login_qrcode", "get_login_qr_code"]) {
    try {
      const qr = normalizeOneBotActionQr(await onebotGateway.sendAction(action, {}));
      if (qr) return { ...qr, action };
    } catch {
      // This action is optional across OneBot implementations.
    }
  }
  return null;
}

function normalizeOneBotActionQr(payload: unknown) {
  const strings = collectStrings((payload as { data?: unknown })?.data ?? payload);
  for (const value of strings) {
    const imageSource = normalizeImageSource(value);
    if (imageSource) return imageSource;
  }
  const qrcode = strings.find((value) => value.length > 12 && !value.includes("\n"));
  return qrcode ? { qrcode } : null;
}

function collectStrings(value: unknown, output: string[] = [], seen = new Set<unknown>()) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) output.push(text);
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output, seen));
  else Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output, seen));
  return output;
}

function normalizeImageSource(value: string) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return { imageDataUrl: value };
  if (/^https?:\/\//i.test(value)) return { imageUrl: value };
  const compact = value.replace(/\s+/g, "");
  if (compact.length > 100 && /^[A-Za-z0-9+/=]+$/.test(compact) && /^(iVBOR|\/9j\/|UklGR)/.test(compact)) {
    return { imageDataUrl: `data:image/png;base64,${compact}` };
  }
  return null;
}

function readNapcatQrImage() {
  const filePath = getWorkspacePath(WORKSPACE_LAYOUT.napcatQrCode);
  if (!existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size <= 0) return null;
  return {
    imageDataUrl: `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`,
    imageUpdatedAt: stats.mtime.toISOString()
  };
}

function getLocalNapcatWebuiRoute() {
  return getNapcatWebuiUrl({ includeToken: false }) ? "/api/onebot/napcat-webui-url" : undefined;
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
