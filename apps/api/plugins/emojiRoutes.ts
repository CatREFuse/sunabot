import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { applicationDataStore } from "../../../adapters/sqlite/applicationDataStore.js";
import { runWithAgentRuntimeContext } from "../../../packages/platform/runtimeAgentContext.js";
import {
  EmojiLibraryRepository,
  type EmojiEnvelope,
  type EmojiImageVariant
} from "../../../src/admin/emojiLibrary.js";
import { AdminApiError, badRequest } from "../../../src/admin/errors.js";
import type { SunaRuntime } from "../../../src/runtime.js";
import type { AppConfig, EmojiSendSize, ImageHistoryRecord, ImageResult } from "../../../src/types.js";
import {
  emojiGenerationPrompt,
  isEmojiFileName,
  isValidEmojiKey,
  normalizeEmojiKey
} from "../../../services/emojis/emojiCatalog.js";
import {
  EmojiGenerationGate,
  EmojiNormalizationBusyError
} from "../../../services/emojis/emojiOperationGate.js";

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const emojiParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string" } },
  additionalProperties: false
} as const;
const emojiVersionParams = {
  type: "object",
  required: ["key", "fileName"],
  properties: {
    key: { type: "string" },
    fileName: { type: "string" }
  },
  additionalProperties: false
} as const;

export interface EmojiRouteOptions {
  repository: EmojiLibraryRepository;
  getRepository?: (agentId: string) => EmojiLibraryRepository;
  getConfig(): AppConfig;
  runtime: SunaRuntime;
  getAgentContext?: (agentId: string) => { config: AppConfig; runtime: SunaRuntime };
  generationGate?: EmojiGenerationGate;
  settings?: {
    read(agentId: string): Promise<EmojiSettingsEnvelope>;
    update(agentId: string, input: { sendSize: EmojiSendSize; revision: string }): Promise<EmojiSettingsEnvelope>;
  };
}

interface EmojiSettingsEnvelope {
  sendSize: EmojiSendSize;
  revision: string;
}

export function registerEmojiRoutes(app: FastifyInstance, options: EmojiRouteOptions) {
  const generationGate = options.generationGate ?? new EmojiGenerationGate();
  app.get("/api/emojis", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const context = repositoryContext(options, request.query);
    const [envelope, settings] = await Promise.all([
      context.repository.list(),
      readEmojiSettings(options, context.agentId)
    ]);
    return withContentUrls(envelope, context.agentId, settings);
  });

  app.patch("/api/emojis/settings", {
    schema: { querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const context = repositoryContext(options, request.query);
    if (!options.settings) {
      throw new AdminApiError(409, "EMOJI_SETTINGS_UNAVAILABLE", "表情设置暂不可用。");
    }
    const settings = await options.settings.update(context.agentId, parseEmojiSettingsBody(request.body));
    return withContentUrls(await context.repository.list(), context.agentId, settings);
  });

  app.post("/api/emojis", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request, reply) => {
    const context = repositoryContext(options, request.query);
    assertMutationEmojiKey(request.body);
    const result = await withNormalizationBusyResponse(
      reply,
      () => context.repository.upload(request.body)
    );
    return withContentUrls(result, context.agentId, await readEmojiSettings(options, context.agentId));
  });

  app.post("/api/emojis/generate", {
    schema: { querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request, reply) => {
    const repository = repositoryContext(options, request.query);
    const runtimeContext = agentContext(options, repository.agentId);
    const body = parseGenerateBody(request.body);
    const admission = generationGate.tryAcquire(repository.agentId, body.key);
    if (!admission.ok) {
      reply.header("retry-after", "2");
      if (admission.reason === "key") {
        throw new AdminApiError(409, "EMOJI_GENERATION_IN_PROGRESS", "该表情正在生成，请稍后重试。");
      }
      throw new AdminApiError(429, "EMOJI_GENERATION_BUSY", "表情生成任务较多，请稍后重试。");
    }
    try {
      let references: string[];
      try {
        references = await runtimeContext.runtime.loadSelfieReferenceImages();
      } catch {
        throw new AdminApiError(409, "EMOJI_REFERENCE_REQUIRED", "请先添加角色参考图。");
      }
      if (!references.length) {
        throw new AdminApiError(409, "EMOJI_REFERENCE_REQUIRED", "请先添加角色参考图。");
      }
      const provider = runtimeContext.runtime.getProvider(body.providerId);
      const personaName = runtimeContext.runtime.getPersonaStatus().name;
      const prompt = emojiGenerationPrompt(body.key, personaName);
      let result: ImageResult;
      try {
        result = await runWithAgentRuntimeContext(runtimeContext.config, () => provider.generateImage(
          prompt,
          "1024x1024",
          runtimeContext.config.bot.tools.generateImg.quality,
          references,
          { stage: "emoji_generation", promptFamily: "image.emoji" }
        ));
      } catch {
        throw new AdminApiError(502, "EMOJI_GENERATION_UNAVAILABLE", "表情生成失败，请检查生图配置。");
      }
      const envelope = await withNormalizationBusyResponse(
        reply,
        () => repository.repository.bindGenerated(body.key, result)
      );
      saveGeneratedImageHistory(runtimeContext.config, provider.getModelInfo().imageModel, prompt, result);
      return withContentUrls(envelope, repository.agentId, await readEmojiSettings(options, repository.agentId));
    } finally {
      admission.release();
    }
  });

  app.patch("/api/emojis/:key", {
    schema: { params: emojiParams, querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { key?: string };
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.rename(params.key ?? "", parseRenameBody(request.body));
    return withContentUrls(envelope, context.agentId, await readEmojiSettings(options, context.agentId));
  });

  app.get("/api/emojis/:key/versions", {
    schema: { params: emojiParams, querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { key?: string };
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.listVersions(params.key ?? "");
    return withVersionContentUrls(envelope, context.agentId);
  });

  app.get("/api/emojis/:key/versions/:fileName/content", {
    schema: { params: emojiVersionParams, querystring: openObject, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const params = request.params as { key?: string; fileName?: string };
    const query = request.query as { variant?: string; agentId?: string };
    const context = repositoryContext(options, query);
    const content = await context.repository.versionContent(
      params.key ?? "",
      params.fileName ?? "",
      parseVariant(query.variant)
    );
    setEmojiContentHeaders(reply, content.contentType);
    return content.bytes;
  });

  app.delete("/api/emojis/:key/versions/:fileName", {
    schema: { params: emojiVersionParams, querystring: openObject, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    const params = request.params as { key?: string; fileName?: string };
    const context = repositoryContext(options, request.query);
    await context.repository.removeVersion(params.key ?? "", params.fileName ?? "");
    return reply.status(204).send();
  });

  app.get("/api/emojis/:key/content", {
    schema: { params: emojiParams, querystring: openObject, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const params = request.params as { key?: string };
    const query = request.query as { variant?: string; agentId?: string; v?: string };
    const context = repositoryContext(options, query);
    const content = await context.repository.content(
      params.key ?? "",
      parseVariant(query.variant),
      parseContentVersion(query.v)
    );
    setEmojiContentHeaders(reply, content.contentType);
    return content.bytes;
  });

  app.delete("/api/emojis/:key", {
    schema: { params: emojiParams, querystring: openObject, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    const params = request.params as { key?: string };
    const context = repositoryContext(options, request.query);
    await context.repository.remove(params.key ?? "");
    return reply.status(204).send();
  });
}

async function withNormalizationBusyResponse<T>(
  reply: FastifyReply,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EmojiNormalizationBusyError) {
      reply.header("retry-after", "2");
      throw new AdminApiError(429, "EMOJI_NORMALIZATION_BUSY", "表情处理任务较多，请稍后重试。");
    }
    throw error;
  }
}

function repositoryContext(options: EmojiRouteOptions, query: unknown) {
  const agentId = requestAgentId(query);
  return {
    agentId,
    repository: options.getRepository?.(agentId) ?? options.repository
  };
}

function agentContext(options: EmojiRouteOptions, agentId: string) {
  return options.getAgentContext?.(agentId) ?? { config: options.getConfig(), runtime: options.runtime };
}

function withContentUrls(envelope: EmojiEnvelope, agentId: string, settings: EmojiSettingsEnvelope) {
  return {
    presetKeys: envelope.presetKeys,
    sendSize: settings.sendSize,
    revision: settings.revision,
    emojis: envelope.emojis.map((emoji) => {
      const base = `/api/emojis/${encodeURIComponent(emoji.key)}/content`;
      const scope = `&agentId=${encodeURIComponent(agentId)}&v=${encodeURIComponent(emoji.fileName)}`;
      return {
        ...emoji,
        originalUrl: `${base}?variant=original${scope}`,
        displayUrl: `${base}?variant=display${scope}`,
        placeholderUrl: `${base}?variant=placeholder${scope}`
      };
    })
  };
}

function withVersionContentUrls(
  envelope: Awaited<ReturnType<EmojiLibraryRepository["listVersions"]>>,
  agentId: string
) {
  return {
    key: envelope.key,
    versions: envelope.versions.map((version) => {
      const base = `/api/emojis/${encodeURIComponent(envelope.key)}/versions/${encodeURIComponent(version.fileName)}/content`;
      const scope = `&agentId=${encodeURIComponent(agentId)}`;
      return {
        ...version,
        originalUrl: `${base}?variant=original${scope}`,
        displayUrl: `${base}?variant=display${scope}`,
        placeholderUrl: `${base}?variant=placeholder${scope}`
      };
    })
  };
}

function setEmojiContentHeaders(reply: FastifyReply, contentType: string) {
  reply.header("content-type", contentType);
  reply.header("cache-control", "private, max-age=604800, immutable");
  reply.header("vary", "Authorization");
  reply.header("x-content-type-options", "nosniff");
}

async function readEmojiSettings(options: EmojiRouteOptions, agentId: string): Promise<EmojiSettingsEnvelope> {
  if (options.settings) return options.settings.read(agentId);
  const config = agentContext(options, agentId).config;
  return { sendSize: config.bot.emojiSendSize, revision: "" };
}

function parseEmojiSettingsBody(input: unknown): { sendSize: EmojiSendSize; revision: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("EMOJI_SETTINGS_INVALID", "表情设置无效。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => key !== "sendSize" && key !== "revision");
  if (extra || typeof body.revision !== "string" || !body.revision.trim()) {
    badRequest("EMOJI_SETTINGS_INVALID", "表情设置无效。", extra ?? "revision");
  }
  const sendSize = body.sendSize;
  if (sendSize !== 64 && sendSize !== 128 && sendSize !== 256 && sendSize !== 512 && sendSize !== 1024) {
    badRequest("EMOJI_SETTINGS_INVALID", "表情发送尺寸无效。", "sendSize");
  }
  return { sendSize, revision: body.revision };
}

function parseRenameBody(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("EMOJI_RENAME_INVALID", "表情 key 无效。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => key !== "key");
  if (extra) badRequest("EMOJI_RENAME_INVALID", "包含不支持的字段。", extra);
  return requireSafeEmojiKey(body.key);
}

function parseGenerateBody(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("EMOJI_GENERATION_INVALID", "请求体必须是对象。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => key !== "key" && key !== "providerId");
  if (extra) badRequest("EMOJI_GENERATION_INVALID", "包含不支持的字段。", extra);
  const key = requireSafeEmojiKey(body.key);
  const providerId = body.providerId == null ? undefined : String(body.providerId).trim() || undefined;
  return { key, providerId };
}

function assertMutationEmojiKey(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  requireSafeEmojiKey((input as Record<string, unknown>).key);
}

function requireSafeEmojiKey(value: unknown) {
  const raw = String(value ?? "");
  const key = normalizeEmojiKey(raw);
  if (isValidEmojiKey(raw)) return key;
  badRequest("EMOJI_KEY_INVALID", "表情 key 需为 1 至 24 个字符，且不能包含括号、斜杠或控制字符。", "key");
}

function saveGeneratedImageHistory(
  config: AppConfig,
  model: string,
  prompt: string,
  result: { url: string; filePath?: string; revisedPrompt?: string }
) {
  const store = applicationDataStore(config);
  const record: ImageHistoryRecord = {
    id: path.basename(result.url),
    url: result.url,
    filePath: result.filePath,
    prompt,
    size: "1024x1024",
    resolution: "1K",
    model,
    createdAt: new Date().toISOString()
  };
  store.replaceImageHistory([record, ...store.readImageHistory()].slice(0, 80));
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}

function parseVariant(value: string | undefined): EmojiImageVariant {
  if (value === "original" || value === "display" || value === "placeholder") return value;
  badRequest("EMOJI_VARIANT_INVALID", "表情图片尺寸无效。", "variant");
}

function parseContentVersion(value: string | undefined) {
  if (value && isEmojiFileName(value)) return value;
  badRequest("EMOJI_CONTENT_VERSION_INVALID", "表情图片版本无效。", "v");
}
