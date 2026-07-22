import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import type { FastifyInstance } from "fastify";
import { applicationDataStore } from "../../../adapters/sqlite/applicationDataStore.js";
import { isTrustedQqFakeIp } from "../../../adapters/onebot/qqMedia.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { runWithAgentRuntimeContext } from "../../../packages/platform/runtimeAgentContext.js";
import { AdminApiError, badRequest } from "../../../src/admin/errors.js";
import { getWorkspacePath } from "../../../packages/platform/projectPaths.js";
import { readModelCallStats, readRequestLogPage, readTokenUsageSummary, requestLogPath } from "../../../adapters/observability/requestLog.js";
import type { SunaRuntime } from "../../../src/runtime.js";
import type { AppConfig, BotToolSettings, ImageHistoryRecord } from "../../../packages/contracts/admin/public.js";
import { requestAgentId } from "../requestAgentId.js";

export interface MediaRouteOptions {
  getConfig(): AppConfig;
  runtime: SunaRuntime;
  getAgentContext?: (agentId: string) => { config: AppConfig; runtime: SunaRuntime };
  getAllAgentConfigs?: () => Promise<AppConfig[]>;
  lookupHostname?: MediaHostnameLookup;
  requestRemoteImage?: MediaPinnedRequest;
}

export type MediaHostnameLookup = (hostname: string) => Promise<readonly { address: string; family?: number }[]>;
export type MediaPinnedRequest = (
  url: URL,
  init: RequestInit,
  addresses: readonly { address: string; family: 4 | 6 }[]
) => Promise<{ response: Response; close(): Promise<void>; destroy(): Promise<void> }>;

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const remoteImageQuery = {
  type: "object",
  properties: { url: { type: "string" } },
  additionalProperties: true
} as const;
const thumbnailCache = new Map<string, Buffer>();
const qqAvatarQuery = {
  type: "object",
  properties: {
    kind: { type: "string" },
    id: { type: "string" }
  },
  additionalProperties: true
} as const;

export function registerMediaRoutes(app: FastifyInstance, options: MediaRouteOptions) {
  const histories = new Map<string, ImageHistoryRecord[]>();
  const lookupHostname = options.lookupHostname ?? defaultMediaHostnameLookup;
  const requestRemoteImage = options.requestRemoteImage ?? requestPinnedRemoteImage;
  const contextFor = (request: { query: unknown }) => options.getAgentContext?.(requestAgentId(request.query)) ?? {
    config: options.getConfig(),
    runtime: options.runtime
  };
  const historyFor = (config: AppConfig) => histories.get(config.persona.defaultAgentId) ?? loadImageHistory(config);

  app.get("/api/images", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const { config } = contextFor(request);
    const imageHistory = normalizeImageHistory(historyFor(config));
    histories.set(config.persona.defaultAgentId, imageHistory);
    return { images: imageHistory };
  });

  app.get("/api/overview/summary", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const { config } = contextFor(request);
    historyFor(config);
    const counts = applicationDataStore(config).counts();
    return { conversations: counts.conversations, images: counts.imageHistory };
  });

  app.get("/api/request-logs", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const { config } = contextFor(request);
    const query = request.query as { q?: string; limit?: string; page?: string; pageSize?: string };
    const page = await readRequestLogPage({
      query: query.q,
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? query.limit ?? 50),
      config
    });
    return {
      filePath: requestLogPath(config),
      ...page
    };
  });

  app.get("/api/token-usage", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const agentId = requestAgentId(request.query, { allowAll: true });
    const config = agentId === "all" ? options.getConfig() : contextFor(request).config;
    const configs = agentId === "all" ? await options.getAllAgentConfigs?.() : undefined;
    const query = request.query as { timezoneOffset?: string; model?: string; behavior?: string };
    return readTokenUsageSummary(Number(query.timezoneOffset ?? 0), {
      model: query.model,
      behavior: query.behavior === "reply" || query.behavior === "orchestrator" || query.behavior === "memory" || query.behavior === "other"
        ? query.behavior
        : "",
      config,
      ...(configs ? { configs } : {})
    });
  });

  app.get("/api/model-call-stats", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const agentId = requestAgentId(request.query, { allowAll: true });
    const config = agentId === "all" ? options.getConfig() : contextFor(request).config;
    const configs = agentId === "all" ? await options.getAllAgentConfigs?.() : undefined;
    return readModelCallStats({ config, ...(configs ? { configs } : {}) });
  });

  app.get("/api/media/image", {
    schema: { querystring: remoteImageQuery, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const query = request.query as { url?: string };
    const imageUrl = String(query.url ?? "");
    if (!isProxyableImageUrl(imageUrl)) {
      badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
    }

    const { bytes, contentType } = await loadRemoteImage(imageUrl, lookupHostname, requestRemoteImage);
    reply.header("content-type", contentType);
    reply.header("cache-control", "private, max-age=86400, stale-while-revalidate=604800");
    reply.header("vary", "Authorization");
    reply.header("x-content-type-options", "nosniff");
    return bytes;
  });

  app.get("/api/media/thumbnail", {
    schema: { querystring: remoteImageQuery, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const query = request.query as { url?: string; variant?: string };
    const source = String(query.url ?? "");
    const variant = query.variant === "placeholder" ? "placeholder" : "display";
    const cacheKey = `${variant}:${source}`;
    const cached = thumbnailCache.get(cacheKey);
    const bytes = cached ?? await createThumbnail(source, variant, lookupHostname, requestRemoteImage);
    if (!cached) {
      if (thumbnailCache.size >= 200) thumbnailCache.delete(thumbnailCache.keys().next().value ?? "");
      thumbnailCache.set(cacheKey, bytes);
    }
    reply.header("content-type", "image/webp");
    reply.header("cache-control", "private, max-age=604800, stale-while-revalidate=604800");
    reply.header("vary", "Authorization");
    return bytes;
  });

  app.get("/api/media/qq-avatar", {
    schema: { querystring: qqAvatarQuery, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const query = request.query as { kind?: string; id?: string };
    const kind = String(query.kind ?? "");
    const id = String(query.id ?? "").trim();
    if ((kind !== "user" && kind !== "group") || !/^\d{5,12}$/.test(id)) {
      badRequest("QQ_AVATAR_INVALID", "QQ 头像参数无效。", "id");
    }

    const imageUrl = kind === "group"
      ? `https://p.qlogo.cn/gh/${id}/${id}/100/`
      : `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=100`;
    const { bytes, contentType } = await loadRemoteImage(imageUrl, lookupHostname, requestRemoteImage);
    reply.header("content-type", contentType);
    reply.header("cache-control", "private, max-age=86400");
    reply.header("vary", "Authorization");
    reply.header("x-content-type-options", "nosniff");
    return bytes;
  });

  app.post("/api/playground/image", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const { config, runtime } = contextFor(request);
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
    const result = await runWithAgentRuntimeContext(config, () => provider.generateImage(prompt, size, quality));
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
    histories.set(config.persona.defaultAgentId, saveImageHistory([record, ...historyFor(config)], config));
    return result;
  });
}

async function createThumbnail(
  source: string,
  variant: "display" | "placeholder",
  lookupHostname: MediaHostnameLookup,
  requestRemoteImage: MediaPinnedRequest
) {
  let bytes: Buffer;
  if (source.startsWith("/generated-images/")) {
    const relativePath = decodeURIComponent(source.slice("/generated-images/".length));
    if (!relativePath || path.isAbsolute(relativePath) || !/\.(?:png|jpe?g|webp)$/i.test(relativePath)) {
      badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
    }
    const root = path.resolve(imageDirPath());
    const filePath = path.resolve(root, relativePath);
    if (filePath === root || !filePath.startsWith(`${root}${path.sep}`)) {
      badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
    }
    const stats = await fs.promises.stat(filePath).catch(() => undefined);
    if (!stats?.isFile() || stats.size > REMOTE_IMAGE_MAX_BYTES) {
      throw new AdminApiError(stats ? 413 : 404, stats ? "IMAGE_TOO_LARGE" : "IMAGE_NOT_FOUND", stats ? "图片超过 12 MiB 限制。" : "图片不存在。");
    }
    bytes = await fs.promises.readFile(filePath);
  } else {
    if (!isProxyableImageUrl(source)) badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
    bytes = (await loadRemoteImage(source, lookupHostname, requestRemoteImage)).bytes;
  }
  try {
    const pipeline = sharp(bytes, { animated: false, limitInputPixels: 64_000_000 }).rotate();
    if (variant === "placeholder") {
      return await pipeline
        .resize({ width: 48, height: 48, fit: "cover", withoutEnlargement: true })
        .webp({ quality: 24, effort: 4 })
        .toBuffer();
    }
    return await pipeline
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72, effort: 4 })
      .toBuffer();
  } catch {
    throw new AdminApiError(415, "IMAGE_THUMBNAIL_FAILED", "无法生成图片缩略图。");
  }
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

async function loadRemoteImage(
  value: string,
  lookupHostname: MediaHostnameLookup,
  requestRemoteImage: MediaPinnedRequest
) {
  let currentUrl = new URL(value);
  const signal = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);

  for (let redirectCount = 0; redirectCount <= REMOTE_IMAGE_MAX_REDIRECTS; redirectCount += 1) {
    const addresses = await assertPublicRemoteUrl(currentUrl, signal, lookupHostname);
    let transport: Awaited<ReturnType<MediaPinnedRequest>>;
    try {
      transport = await requestRemoteImage(currentUrl, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 sunabot"
        },
        redirect: "manual",
        signal
      }, addresses);
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      const timedOut = signal.aborted || (error as { name?: string }).name === "AbortError";
      throw new AdminApiError(timedOut ? 504 : 502, "IMAGE_LOAD_FAILED", timedOut ? "图片加载超时。" : "图片加载失败。");
    }
    const { response } = transport;

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === REMOTE_IMAGE_MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        await transport.destroy().catch(() => undefined);
        throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片重定向无效。");
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        await transport.destroy().catch(() => undefined);
        throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片重定向无效。");
      }
      await response.body?.cancel().catch(() => undefined);
      await transport.destroy().catch(() => undefined);
      continue;
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || !REMOTE_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      await transport.destroy().catch(() => undefined);
      throw new AdminApiError(response.ok ? 415 : 502, "IMAGE_LOAD_FAILED", "图片加载失败。");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > REMOTE_IMAGE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      await transport.destroy().catch(() => undefined);
      throw new AdminApiError(413, "IMAGE_TOO_LARGE", "图片超过 12 MiB 限制。");
    }
    try {
      return {
        bytes: await readLimitedResponseBody(response, REMOTE_IMAGE_MAX_BYTES),
        contentType
      };
    } finally {
      await transport.close().catch(() => transport.destroy().catch(() => undefined));
    }
  }

  throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片加载失败。");
}

async function assertPublicRemoteUrl(url: URL, signal: AbortSignal, lookupHostname: MediaHostnameLookup) {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    badRequest("IMAGE_URL_INVALID", "图片地址无效。", "url");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
  }
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
    return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  }

  let addresses: readonly { address: string; family?: number }[];
  try {
    addresses = await promiseWithAbort(lookupHostname(hostname), signal);
  } catch {
    if (signal.aborted) throw new AdminApiError(504, "IMAGE_LOAD_FAILED", "图片加载超时。");
    throw new AdminApiError(502, "IMAGE_LOAD_FAILED", "图片域名无法解析。");
  }
  const pinned = addresses.map(({ address, family }) => ({ address, family: (family ?? net.isIP(address)) as 4 | 6 }));
  if (!pinned.length || pinned.some(({ address, family }) =>
    (family !== 4 && family !== 6) || net.isIP(address) !== family ||
    (!isPublicIpAddress(address) && !isTrustedQqFakeIp(hostname, address)))) {
    badRequest("IMAGE_URL_PRIVATE", "图片地址不能指向本地网络。", "url");
  }
  return pinned;
}

const defaultMediaHostnameLookup: MediaHostnameLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

const requestPinnedRemoteImage: MediaPinnedRequest = async (url, init, addresses) => {
  const selected = addresses[0];
  if (!selected) throw new Error("Pinned image address is unavailable.");
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, _options, callback) {
        if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
          callback(new Error("Pinned image hostname changed."), "", 0);
          return;
        }
        callback(null, selected.address, selected.family);
      }
    }
  });
  try {
    const response = await undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]);
    return {
      response: response as unknown as Response,
      close: () => dispatcher.close(),
      destroy: () => dispatcher.destroy()
    };
  } catch (error) {
    await dispatcher.destroy().catch(() => undefined);
    throw error;
  }
};

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

function imageDirPath(config?: Pick<AppConfig, "persona">) {
  const agentId = config?.persona.defaultAgentId.trim() || "plana";
  return agentId === "plana"
    ? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
    : getWorkspacePath(WORKSPACE_LAYOUT.mediaImages, "agents", agentId);
}

function imageHistoryPath() {
  return getWorkspacePath(WORKSPACE_LAYOUT.legacyData, "image-history.json");
}

function loadImageHistory(config?: Pick<AppConfig, "persona">) {
  const historyFile = imageHistoryPath();
  try {
    const store = applicationDataStore(config);
    if (!config || config.persona.defaultAgentId === "plana") store.ensureLegacyImageHistoryImported(historyFile);
    return normalizeImageHistory(store.readImageHistory());
  } catch {
    return [];
  }
}

function normalizeImageHistory(records: ImageHistoryRecord[]) {
  return records
    .filter((record) => record.url)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 80);
}

function saveImageHistory(records: ImageHistoryRecord[], config?: Pick<AppConfig, "persona">) {
  const normalized = normalizeImageHistory(records);
  applicationDataStore(config).replaceImageHistory(normalized);
  return normalized;
}
