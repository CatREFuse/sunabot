import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs, { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { AgentFileRepository } from "./admin/agentFiles.js";
import { AdminAuthService, isAdminProtectedPath } from "./admin/auth.js";
import { ConfigService, validateProviderDraft } from "./admin/configService.js";
import { CodexAuthService } from "./admin/codexAuth.js";
import { MonitorSettingsStore } from "./admin/monitorSettings.js";
import { AdminApiError, badRequest, notFound } from "./admin/errors.js";
import { IMAGE_MODEL_CATALOG, MODEL_CATALOG, REASONING_EFFORTS } from "./admin/models.js";
import { defaultTools } from "./tools.js";
import { getConfigPath, getRootDir, getWorkspacePath, loadConfig } from "./config.js";
import { applicationDataStore } from "./dataStore.js";
import { createMemoryEntry, deleteMemoryEntry, listMemoryEntries, recallMemory, updateMemoryEntry } from "./memory.js";
import { ConversationDirectory } from "./conversationDirectory.js";
import { OneBotGateway } from "./onebot.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { OUTBOUND_MEDIA_ROUTE_PREFIX, OutboundMediaDelivery } from "./outboundMedia.js";
import { isTrustedQqFakeIp } from "./qqMedia.js";
import { readRequestLogs, requestLogPath } from "./requestLog.js";
import { SunaRuntime } from "./runtime.js";
import { ServiceMonitor } from "./serviceMonitor.js";
import {
  AppConfig,
  BotToolSettings,
  ImageHistoryRecord,
  OneBotLoginCheck,
  OneBotQrLogin,
  ProviderConfig
} from "./types.js";

export interface CreateAppOptions {
  config?: AppConfig;
  initializeRuntime?: boolean;
  logger?: boolean;
  outboundMedia?: OutboundMediaDelivery;
  testProvider?: (provider: ProviderConfig) => Promise<Record<string, unknown>>;
}

export interface BuiltApp {
  app: FastifyInstance;
  runtime: SunaRuntime;
  onebotGateway: OneBotGateway;
  outboundMedia: OutboundMediaDelivery;
  serviceMonitor: ServiceMonitor;
  getConfig(): AppConfig;
}

export async function buildApp(options: CreateAppOptions = {}): Promise<BuiltApp> {
  const startedAt = new Date().toISOString();
  let config = options.config ?? await loadConfig();
  const outboundMedia = options.outboundMedia ?? new OutboundMediaDelivery({ rootDir: imageDirPath() });
  const runtime = new SunaRuntime(config);
  if (options.initializeRuntime !== false) await runtime.initialize();
  let imageHistory = loadImageHistory();

  const adminAuth = await AdminAuthService.create({
    credentialsPath: getWorkspacePath("security/admin-credentials.json"),
    fusePath: getWorkspacePath("security/ADMIN_DISABLED.json"),
    bearerToken: process.env.SUNABOT_ADMIN_TOKEN,
    allowedOrigins: (process.env.SUNABOT_ADMIN_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  });
  const codexAuth = new CodexAuthService({
    codexHome: getWorkspacePath("security/codex"),
    executable: process.env.SUNABOT_CODEX_EXECUTABLE
  });

  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  const monitorSettings = new MonitorSettingsStore(getWorkspacePath(".env"));
  const onebotGateway = new OneBotGateway(app.server as http.Server, config, runtime, { outboundMedia });
  const conversationDirectory = new ConversationDirectory({
    cachePath: getWorkspacePath("artifacts/conversation-directory.json")
  });
  onebotGateway.on("connected", () => runtime.resumeUserGroupOrchestrators(onebotGateway));
  onebotGateway.on("disconnected", () => runtime.suspendUserGroupOrchestrators());
  onebotGateway.mount();
  const activeReverseWsPath = config.onebot.reverseWsPath;
  const serviceMonitor = new ServiceMonitor(runtime, onebotGateway, monitorSettings);
  app.addHook("onClose", async () => {
    codexAuth.close();
    serviceMonitor.close();
    runtime.close();
  });
  const agentFiles = new AgentFileRepository({ runtime });
  const configService = new ConfigService({
    prepareApply: async (candidate) => {
      await agentFiles.validateConfig(candidate);
      const agentFileRevisions = await agentFiles.captureConfigRevisions(candidate);
      const snapshot = await runtime.prepareReload(candidate);
      return {
        verify() {
          return agentFiles.assertConfigRevisions(candidate, agentFileRevisions);
        },
        async commit() {
          await runtime.ensureAgentPromptFiles(candidate);
          runtime.commitReload(snapshot);
          onebotGateway.updateConfig({
            ...candidate,
            onebot: { ...candidate.onebot, reverseWsPath: activeReverseWsPath }
          });
          config = candidate;
        }
      };
    }
  });

  app.addHook("onRequest", async (request) => {
    if (isAdminProtectedPath(request.raw.url ?? request.url)) await adminAuth.authorize(request);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if ((request.raw.url ?? request.url).startsWith("/api/")) reply.header("cache-control", "no-store");
    if (request.headers["x-forwarded-proto"] === "https") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.get("/api/auth/session", async (request) => adminAuth.getSessionStatus(request));

  app.post("/api/auth/login", async (request, reply) => adminAuth.login(request, reply, request.body));

  app.post("/api/auth/logout", async (request, reply) => {
    adminAuth.logout(request, reply);
    return reply.status(204).send();
  });

  app.get("/api/auth/security", async () => ({ fuse: adminAuth.getFuseStatus() }));

  app.post("/api/auth/fuse", async () => {
    await adminAuth.tripFuse("webui-emergency");
    return { ok: true, fuse: adminAuth.getFuseStatus() };
  });

  app.get("/api/codex-auth/status", async () => codexAuth.status());

  app.post("/api/codex-auth/login", async () => codexAuth.startLogin());

  app.post("/api/codex-auth/logout", async () => codexAuth.logout());

  app.get("/api/monitoring/settings", async () => monitorSettings.publicSettings());

  app.put("/api/monitoring/settings", async (request) => {
    return monitorSettings.update(request.body as never);
  });

  app.post("/api/monitoring/test", async () => {
    return serviceMonitor.testNotification();
  });

  app.get(`${OUTBOUND_MEDIA_ROUTE_PREFIX}/:fileName`, async (request, reply) => {
    const params = request.params as { fileName?: string };
    const query = request.query as { expires?: string; signature?: string };
    const media = await outboundMedia.resolveSignedPath(params.fileName, query.expires, query.signature);
    if (!media) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "请求的资源不存在。" } });
    }
    reply.header("content-type", media.contentType);
    reply.header("content-length", String(media.size));
    reply.header("cache-control", "private, max-age=300");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(fs.createReadStream(media.filePath));
  });

  await app.register(fastifyStatic, {
    root: getWorkspacePath("artifacts/images"),
    prefix: "/generated-images/",
    decorateReply: false
  });

  const webDist = path.join(getRootDir(), "web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });
  }

app.get("/api/status", async () => {
  return {
    startedAt,
    configPath: getConfigPath(),
    onebot: onebotGateway.getStatus(),
    persona: runtime.getPersonaStatus(),
    provider: runtime.getProviderStatus(),
    recovery: configService.getRecoveryStatus()
  };
});

app.get("/api/conversations", async () => {
  const records = runtime.getConversationRecords();
  if (onebotGateway.getStatus().connected) {
    void runtime.hydrateConversationRecords(onebotGateway).catch((error) => {
      console.error("[server] hydrate conversations failed", error);
    });
    return { conversations: await conversationDirectory.enrich(records, onebotGateway) };
  }
  return { conversations: conversationDirectory.describe(records) };
});

app.get("/api/conversations/:id/messages", async (request) => {
  const params = request.params as { id?: string };
  const query = request.query as { before?: string; limit?: string };
  const conversationId = String(params.id ?? "");
  if (onebotGateway.getStatus().connected) {
    await runtime.hydrateConversationIdentities(conversationId, onebotGateway);
  }
  return runtime.getConversationMessages(conversationId, {
    beforeSequence: query.before == null ? undefined : Number(query.before),
    limit: query.limit == null ? undefined : Number(query.limit)
  });
});

app.get("/api/conversations/:id/logs", async (request) => {
  const params = request.params as { id?: string };
  const query = request.query as { runId?: string; limit?: string };
  const runId = String(query.runId ?? "").trim();
  const conversationId = String(params.id ?? "").trim();
  const q = runId || conversationId;
  return {
    logs: q ? await readRequestLogs({ query: q, limit: query.limit == null ? 200 : Number(query.limit) }) : []
  };
});

app.put("/api/conversations/reply", async (request) => {
  const conversation = runtime.setConversationReplyEnabled(request.body as {
    id?: string;
    scope?: string;
    title?: string;
    userId?: number;
    groupId?: number;
    replyEnabled?: boolean;
    orchestratorEnabled?: boolean;
  });
  return { ok: true, conversation };
});

app.get("/api/images", async () => {
  imageHistory = mergeImageHistoryWithFiles(imageHistory);
  return { images: imageHistory };
});

app.get("/api/request-logs", async (request) => {
  const query = request.query as { q?: string; limit?: string };
  return {
    filePath: requestLogPath(),
    logs: await readRequestLogs({
      query: query.q,
      limit: query.limit == null ? undefined : Number(query.limit)
    })
  };
});

app.get("/api/media/image", async (request, reply) => {
  const query = request.query as { url?: string };
  const imageUrl = String(query.url ?? "");
  if (!isProxyableImageUrl(imageUrl)) {
    badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
  }

  const { bytes, contentType } = await loadRemoteImage(imageUrl);
  reply.header("content-type", contentType);
  reply.header("cache-control", "private, max-age=300");
  reply.header("vary", "Authorization");
  reply.header("x-content-type-options", "nosniff");
  return bytes;
});

app.get("/api/media/qq-avatar", async (request, reply) => {
  const query = request.query as { kind?: string; id?: string };
  const kind = String(query.kind ?? "");
  const id = String(query.id ?? "").trim();
  if ((kind !== "user" && kind !== "group") || !/^\d{5,12}$/.test(id)) {
    badRequest("QQ_AVATAR_INVALID", "QQ 头像参数无效。", "id");
  }

  const imageUrl = kind === "group"
    ? `https://p.qlogo.cn/gh/${id}/${id}/100/`
    : `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=100`;
  const { bytes, contentType } = await loadRemoteImage(imageUrl);
  reply.header("content-type", contentType);
  reply.header("cache-control", "private, max-age=86400");
  reply.header("vary", "Authorization");
  reply.header("x-content-type-options", "nosniff");
  return bytes;
});

app.get("/api/onebot/login-info", async () => {
  const status = onebotGateway.getStatus();
  if (!status.connected) {
    return { connected: false, error: "OneBot 未连接。" };
  }

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
    return {
      connected: status.connected,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

app.post("/api/onebot/qq-login", async () => {
  const login = await getOneBotLoginCheck(onebotGateway);
  const localQr = readNapcatQrImage();
  const webuiUrl = getLocalNapcatWebuiRoute();
  const response: OneBotQrLogin = {
    ...login,
    available: Boolean(localQr || webuiUrl),
    webuiUrl
  };

  if (localQr) {
    response.imageDataUrl = localQr.imageDataUrl;
    response.imageUpdatedAt = localQr.imageUpdatedAt;
    return response;
  }

  if (login.connected && !login.online) {
    const actionQr = await getOneBotActionQr(onebotGateway);
    if (actionQr) {
      return { ...response, ...actionQr, available: true };
    }
  }

  return response;
});

app.get("/api/onebot/qq-login/status", async () => {
  return getOneBotLoginCheck(onebotGateway);
});

app.get("/api/onebot/napcat-webui-url", async () => {
  const webuiUrl = getNapcatWebuiUrl({ includeToken: true });
  if (!webuiUrl) notFound("NAPCAT_WEBUI_NOT_FOUND", "NapCat WebUI 未配置。");
  return { url: webuiUrl };
});

app.get("/api/onebot/events", async () => {
  return { events: onebotGateway.getRecentEvents() };
});

app.get("/api/onebot/chats", async () => {
  const status = onebotGateway.getStatus();
  if (!status.connected) {
    return { connected: false, private: [], groups: [] };
  }

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

app.get("/api/config", async () => {
  return configService.readEnvelope();
});

app.patch("/api/config/group-reply", async (request) => {
  return configService.patchGroupReply(request.body);
});

app.patch("/api/config/:section", async (request) => {
  const params = request.params as { section?: string };
  return configService.patch(String(params.section ?? ""), request.body);
});

app.get("/api/models", async () => {
  return {
    models: MODEL_CATALOG,
    reasoningEfforts: REASONING_EFFORTS,
    imageModels: IMAGE_MODEL_CATALOG
  };
});

app.get("/api/agent-files", async () => {
  return agentFiles.list();
});

app.get("/api/agent-files/:id", async (request) => {
  const params = request.params as { id?: string };
  return agentFiles.get(String(params.id ?? ""));
});

app.put("/api/agent-files/:id", async (request) => {
  const params = request.params as { id?: string };
  return agentFiles.put(String(params.id ?? ""), request.body);
});

app.get("/api/tools", async () => {
  return { tools: defaultTools };
});

app.get("/api/memory", async (request) => {
  const query = request.query as { source?: string };
  const payload = await listMemoryEntries(config, query.source);
  return { ...payload, entries: runtime.enrichMemoryEntries(payload.entries) };
});

app.post("/api/memory/recall", async (request) => {
  const payload = await recallMemory(config, request.body as { query?: string; source?: string; limit?: number });
  return { ...payload, matches: runtime.enrichMemoryEntries(payload.matches) };
});

app.post("/api/memory", async (request) => {
  const entry = await createMemoryEntry(config, request.body as {
    source?: string;
    text?: string;
    userId?: string;
    userName?: string;
    addressName?: string;
  });
  await runtime.reload(config);
  return { ok: true, entry };
});

app.put("/api/memory", async (request) => {
  const entry = await updateMemoryEntry(config, request.body as {
    source?: string;
    id?: string;
    text?: string;
    addressName?: string;
  });
  await runtime.reload(config);
  return { ok: true, entry };
});

app.delete("/api/memory", async (request) => {
  const result = await deleteMemoryEntry(config, request.body as { source?: string; id?: string });
  await runtime.reload(config);
  return result;
});

app.post("/api/providers/test", async (request) => {
  const body = request.body as { provider?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "provider")) {
    badRequest("PROVIDER_TEST_INVALID", "请求体必须只包含 provider。", "provider");
  }
  const provider = validateProviderDraft(body.provider);
  const started = performance.now();
  let result: Record<string, unknown>;
  try {
    result = options.testProvider
      ? await options.testProvider(provider)
      : await new OpenAIProvider(provider).test();
  } catch (error) {
    throw new AdminApiError(
      422,
      "PROVIDER_TEST_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  return {
    ...result,
    ok: true,
    model: provider.model,
    elapsedMs
  };
});

app.post("/api/playground/image", async (request, reply) => {
  const body = request.body as { prompt?: string; size?: string; resolution?: string; quality?: string; providerId?: string };
  const prompt = String(body?.prompt ?? "").trim();
  const resolution = isImageResolution(body?.resolution) ? body.resolution : config.bot.tools.generateImg.resolution;
  const requestedSize = isImageSize(body?.size) ? body.size : config.bot.tools.generateImg.size;
  const size = sizeForResolution(requestedSize, resolution);
  const quality = isImageQuality(body?.quality) ? body.quality : config.bot.tools.generateImg.quality;
  const providerId = body?.providerId ? String(body.providerId) : undefined;

  if (!prompt) {
    badRequest("IMAGE_PROMPT_EMPTY", "请输入提示词。", "prompt");
  }

  const provider = runtime.getProvider(providerId);
  const result = await provider.generateImage(prompt, size, quality);
  const record: ImageHistoryRecord = {
    id: path.basename(result.url),
    url: result.url,
    filePath: result.filePath,
    prompt,
    size,
    resolution,
    providerId,
    model: provider.getModelInfo().imageModel,
    createdAt: new Date().toISOString()
  };
  imageHistory = saveImageHistory([record, ...imageHistory]);
  return result;
});

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AdminApiError) {
      if (error.statusCode === 401 && request.headers.authorization) {
        reply.header("www-authenticate", "Bearer");
      }
      return reply.status(error.statusCode).send(error.toJSON());
    }
    const genericError = error as { statusCode?: number; message?: string };
    const statusCode = typeof genericError.statusCode === "number" && genericError.statusCode >= 400 && genericError.statusCode < 500
      ? genericError.statusCode
      : 500;
    const message = statusCode === 500 ? "服务器处理请求失败。" : genericError.message ?? "请求失败。";
    requestLogError(error);
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 404 ? "NOT_FOUND" : statusCode === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message
      }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const indexPath = path.join(webDist, "index.html");
    if (request.method === "GET" && isSpaRoute(pathname) && existsSync(indexPath)) {
      return reply.type("text/html; charset=utf-8").send(fs.createReadStream(indexPath));
    }
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "请求的资源不存在。" } });
  });

  return {
    app,
    runtime,
    onebotGateway,
    outboundMedia,
    serviceMonitor,
    getConfig: () => config
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  return (await buildApp(options)).app;
}

async function startServer() {
  const built = await buildApp({ logger: true });
  const config = built.getConfig();
  await built.app.listen({ host: config.server.host, port: config.server.port });
  built.serviceMonitor.start();
  const address = `http://${config.server.host}:${config.server.port}`;
  console.log(`sunabot listening on ${address}`);
  console.log(`onebot reverse ws: ws://${config.server.host}:${config.server.port}${config.onebot.reverseWsPath}`);
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isDirectExecution) {
  void startServer().catch((error) => {
    console.error("sunabot failed to start", error);
    process.exitCode = 1;
  });
}

function requestLogError(error: unknown) {
  console.error("[server] request failed", error);
}

function isSpaRoute(pathname: string) {
  return pathname === "/" || ["overview", "conversations", "prompts", "memory", "images", "settings"]
    .some((segment) => pathname === `/${segment}` || pathname.startsWith(`/${segment}/`));
}

function isProxyableImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

const REMOTE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const REMOTE_IMAGE_MAX_REDIRECTS = 3;
const REMOTE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

async function loadRemoteImage(value: string) {
  let currentUrl = new URL(value);
  const signal = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);

  for (let redirectCount = 0; redirectCount <= REMOTE_IMAGE_MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicRemoteUrl(currentUrl, signal);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 sunabot"
        },
        redirect: "manual",
        signal
      });
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      const timedOut = signal.aborted || (error as { name?: string }).name === "AbortError";
      throw new AdminApiError(timedOut ? 504 : 502, "IMAGE_LOAD_FAILED", timedOut ? "图片加载超时。" : "图片加载失败。");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === REMOTE_IMAGE_MAX_REDIRECTS) {
        throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片重定向无效。");
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片重定向无效。");
      }
      continue;
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || !REMOTE_IMAGE_TYPES.has(contentType)) {
      throw new AdminApiError(response.ok ? 415 : 502, "IMAGE_LOAD_FAILED", "图片加载失败。");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > REMOTE_IMAGE_MAX_BYTES) {
      throw new AdminApiError(413, "IMAGE_TOO_LARGE", "图片超过 12 MiB 限制。");
    }
    return {
      bytes: await readLimitedResponseBody(response, REMOTE_IMAGE_MAX_BYTES),
      contentType
    };
  }

  throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片加载失败。");
}

async function assertPublicRemoteUrl(url: URL, signal: AbortSignal) {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
  }
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await promiseWithAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch {
    if (signal.aborted) throw new AdminApiError(504, "IMAGE_LOAD_FAILED", "图片加载超时。");
    throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片域名无法解析。");
  }
  if (!addresses.length || addresses.some(({ address }) =>
    !isPublicIpAddress(address) && !isTrustedQqFakeIp(hostname, address))) {
    badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
  }
}

async function promiseWithAbort<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isPublicIpAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^(?:0*:)*ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);
  if (mapped?.[2] && mapped[3]) {
    const high = Number.parseInt(mapped[2], 16);
    const low = Number.parseInt(mapped[3], 16);
    return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !normalized.startsWith("2001:db8:") && !normalized.startsWith("2002:");
}

function isPublicIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

async function readLimitedResponseBody(response: Response, maxBytes: number) {
  if (!response.body) throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片响应为空。");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AdminApiError(413, "IMAGE_TOO_LARGE", "图片超过 12 MiB 限制。");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片读取失败。");
  }
  return Buffer.concat(chunks, total);
}

async function getOneBotLoginCheck(onebotGateway: OneBotGateway): Promise<OneBotLoginCheck> {
  const status = onebotGateway.getStatus();
  if (!status.connected) {
    return { connected: false, online: false };
  }

  try {
    const payload = await onebotGateway.sendAction("get_login_info", {});
    const response = payload as { data?: { user_id?: number; nickname?: string } };
    return {
      connected: true,
      online: Boolean(response.data?.user_id),
      data: response.data ?? {}
    };
  } catch (error) {
    return {
      connected: true,
      online: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getOneBotActionQr(onebotGateway: OneBotGateway) {
  const actions = ["get_qrcode", "get_qr_code", "get_login_qrcode", "get_login_qr_code"];
  for (const action of actions) {
    try {
      const payload = await onebotGateway.sendAction(action, {});
      const qr = normalizeOneBotActionQr(payload);
      if (qr) return { ...qr, action };
    } catch {
      // Some OneBot implementations do not expose a login QR action.
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

  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output, seen));
    return output;
  }

  Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output, seen));
  return output;
}

function normalizeImageSource(value: string) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
    return { imageDataUrl: value };
  }
  if (/^https?:\/\//i.test(value)) {
    return { imageUrl: value };
  }

  const compact = value.replace(/\s+/g, "");
  if (compact.length > 100 && /^[A-Za-z0-9+/=]+$/.test(compact) && /^(iVBOR|\/9j\/|UklGR)/.test(compact)) {
    return { imageDataUrl: `data:image/png;base64,${compact}` };
  }

  return null;
}

function readNapcatQrImage() {
  const filePath = getWorkspacePath("napcat/qrcode.png");
  if (!existsSync(filePath)) return null;

  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size <= 0) return null;

  const imageDataUrl = `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
  return {
    imageDataUrl,
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
  if (options.includeToken && token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

function readNapcatWebuiConfig() {
  const filePath = getWorkspacePath("napcat/config-full/webui.json");
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as { port?: number; token?: string };
  } catch {
    return null;
  }
}

function isImageSize(value: unknown): value is BotToolSettings["generateImg"]["size"] {
  return value === "1024x1024" ||
    value === "1536x1024" ||
    value === "1024x1536" ||
    value === "2048x2048" ||
    value === "2048x1152" ||
    value === "1152x2048" ||
    value === "3840x2160" ||
    value === "2160x3840";
}

function isImageResolution(value: unknown): value is BotToolSettings["generateImg"]["resolution"] {
  return value === "1K" || value === "2K" || value === "4K";
}

function isImageQuality(value: unknown): value is BotToolSettings["generateImg"]["quality"] {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function sizeForResolution(size: BotToolSettings["generateImg"]["size"], resolution: BotToolSettings["generateImg"]["resolution"]) {
  const aspect = imageAspect(size);
  if (resolution === "4K") return aspect === "portrait" ? "2160x3840" : "3840x2160";
  if (resolution === "2K") return aspect === "portrait" ? "1152x2048" : aspect === "landscape" ? "2048x1152" : "2048x2048";
  return aspect === "portrait" ? "1024x1536" : aspect === "landscape" ? "1536x1024" : "1024x1024";
}

function imageAspect(size: string) {
  const [width = 0, height = 0] = size.split("x").map((item) => Number(item));
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

function extractOneBotDataArray(result: PromiseSettledResult<unknown>) {
  if (result.status !== "fulfilled") return [];
  const payload = result.value as { data?: unknown };
  return Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
}

function imageDirPath() {
  return getWorkspacePath("artifacts/images");
}

function imageHistoryPath() {
  return getWorkspacePath("artifacts/image-history.json");
}

function loadImageHistory() {
  const historyFile = imageHistoryPath();
  try {
    const store = applicationDataStore();
    store.ensureLegacyImageHistoryImported(historyFile);
    return mergeImageHistoryWithFiles(store.readImageHistory());
  } catch {
    return mergeImageHistoryWithFiles([]);
  }
}

function mergeImageHistoryWithFiles(records: ImageHistoryRecord[]) {
  const byUrl = new Map(records.map((record) => [record.url, record]));
  const dir = imageDirPath();
  if (!existsSync(dir)) return normalizeImageHistory([...byUrl.values()]);

  for (const fileName of fs.readdirSync(dir)) {
    if (!/\.(png|jpe?g|webp)$/i.test(fileName)) continue;
    const url = `/generated-images/${fileName}`;
    if (byUrl.has(url)) continue;
    const filePath = path.join(dir, fileName);
    const stats = fs.statSync(filePath);
    byUrl.set(url, {
      id: fileName,
      url,
      filePath,
      createdAt: stats.mtime.toISOString()
    });
  }

  return normalizeImageHistory([...byUrl.values()]);
}

function normalizeImageHistory(records: ImageHistoryRecord[]) {
  return records
    .filter((record) => record.url)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 80);
}

function saveImageHistory(records: ImageHistoryRecord[]) {
  const normalized = normalizeImageHistory(records);
  applicationDataStore().replaceImageHistory(normalized);
  return normalized;
}
