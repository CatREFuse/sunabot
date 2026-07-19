import type { FastifyInstance } from "fastify";
import { AdminApiError } from "../../../src/admin/errors.js";
import {
  VOICE_LANGUAGES,
  VoiceProfileError,
  type VoiceLanguage,
  type VoiceProfileRepository,
  type VoiceSynthesisClient,
} from "../../../services/voice/public.js";
import {
  VoiceServiceControlError,
  type VoiceServiceControlPort,
  type VoiceServiceRuntimeStatus,
} from "../voiceServiceControlClient.js";

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const VOICE_HEALTH_PROBE_TIMEOUT_MS = 5_000;
const languageParams = {
  type: "object",
  required: ["language"],
  properties: { language: { type: "string", enum: VOICE_LANGUAGES } },
  additionalProperties: false,
} as const;

export interface VoiceProfileRouteOptions {
  repository(agentId: string): VoiceProfileRepository;
  client: VoiceSynthesisClient;
  serviceController?: VoiceServiceControlPort;
  defaultAgentId?: () => string;
  now?: () => Date;
}

export function registerVoiceProfileRoutes(
  app: FastifyInstance,
  options: VoiceProfileRouteOptions,
) {
  const now = options.now ?? (() => new Date());

  app.get(
    "/api/voice-profile",
    {
      schema: { querystring: openObject, response: { 200: openObject } },
    },
    async (request) => {
      const repository = repositoryFor(options, request.query);
      const [profile, provider] = await Promise.all([
        mapRepositoryError(() => repository.readProfile()),
        probeVoiceProvider(options.client, now, options.serviceController),
      ]);
      return { profile, provider };
    },
  );

  app.put(
    "/api/voice-profile",
    {
      schema: {
        querystring: openObject,
        body: passthroughBody,
        response: { 200: openObject },
      },
    },
    async (request) => ({
      profile: await mapRepositoryError(() =>
        repositoryFor(options, request.query).updateSettings(
          request.body as never,
        ),
      ),
    }),
  );

  app.put(
    "/api/voice-profile/:language",
    {
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        params: languageParams,
        querystring: openObject,
        body: passthroughBody,
        response: { 200: openObject },
      },
    },
    async (request) => {
      const language = requestLanguage(request.params);
      const body = referenceBody(request.body);
      return {
        profile: await mapRepositoryError(() =>
          repositoryFor(options, request.query).putReference({
            language,
            ...body,
          }),
        ),
      };
    },
  );

  app.delete(
    "/api/voice-profile/:language",
    {
      schema: {
        params: languageParams,
        querystring: openObject,
        response: { 200: openObject },
      },
    },
    async (request) => ({
      profile: await mapRepositoryError(() =>
        repositoryFor(options, request.query).removeReference(
          requestLanguage(request.params),
        ),
      ),
    }),
  );

  app.post(
    "/api/voice-profile/probe",
    {
      schema: { querystring: openObject, response: { 200: openObject } },
    },
    async (request) => {
      repositoryFor(options, request.query);
      return {
        provider: await probeVoiceProvider(
          options.client,
          now,
          options.serviceController,
        ),
      };
    },
  );

  app.post(
    "/api/voice-service/check",
    {
      schema: { querystring: openObject, response: { 200: openObject } },
    },
    async (request) => {
      repositoryFor(options, request.query);
      return {
        provider: await probeVoiceProvider(
          options.client,
          now,
          options.serviceController,
        ),
      };
    },
  );

  app.post(
    "/api/voice-service/start",
    {
      schema: { querystring: openObject, response: { 200: openObject } },
    },
    async (request) => {
      repositoryFor(options, request.query);
      const runtime = await runServiceAction(options.serviceController, "start");
      return {
        provider: await probeVoiceProvider(
          options.client,
          now,
          options.serviceController,
          runtime,
        ),
      };
    },
  );

  app.post(
    "/api/voice-service/stop",
    {
      schema: { querystring: openObject, response: { 200: openObject } },
    },
    async (request) => {
      repositoryFor(options, request.query);
      const runtime = await runServiceAction(options.serviceController, "stop");
      return {
        provider: stoppedProvider(now, runtime),
      };
    },
  );
}

export async function probeVoiceProvider(
  client: VoiceSynthesisClient,
  now: () => Date = () => new Date(),
  serviceController?: VoiceServiceControlPort,
  knownRuntime?: VoiceServiceRuntimeStatus,
) {
  const checkedAt = now().toISOString();
  const [health, runtime] = await Promise.allSettled([
    client.health({
      signal: AbortSignal.timeout(VOICE_HEALTH_PROBE_TIMEOUT_MS),
    }),
    knownRuntime
      ? Promise.resolve(knownRuntime)
      : serviceController?.check() ?? Promise.reject(new Error("unmanaged")),
  ]);
  const controlsAvailable = runtime.status === "fulfilled";
  if (health.status === "fulfilled") {
    return {
      provider: "MOSS-TTS-Nano" as const,
      ready: true,
      checkedAt,
      latencyMs: health.value.latencyMs,
      serviceState: "running" as const,
      controlsAvailable,
    };
  }
  const serviceState =
    runtime.status === "fulfilled" ? runtime.value.state : "unknown";
  return {
    provider: "MOSS-TTS-Nano" as const,
    ready: false,
    checkedAt,
    serviceState,
    controlsAvailable,
    message:
      serviceState === "stopped"
        ? "语音服务已关闭"
        : serviceState === "running"
          ? (runtime.status === "fulfilled" && runtime.value.message) ||
            "语音服务正在启动或暂不可用"
          : "语音服务不可用",
  };
}

function stoppedProvider(
  now: () => Date,
  runtime: VoiceServiceRuntimeStatus,
) {
  return {
    provider: "MOSS-TTS-Nano" as const,
    ready: false,
    checkedAt: now().toISOString(),
    serviceState: "stopped" as const,
    controlsAvailable: true,
    message: runtime.message ?? "语音服务已关闭",
  };
}

async function runServiceAction(
  controller: VoiceServiceControlPort | undefined,
  action: "start" | "stop",
) {
  if (!controller) {
    throw new AdminApiError(
      503,
      "VOICE_SERVICE_CONTROL_UNAVAILABLE",
      "语音服务管理不可用，请重启 Sunabot。",
    );
  }
  try {
    return await controller[action]();
  } catch (error) {
    if (error instanceof VoiceServiceControlError) {
      throw new AdminApiError(error.status, error.code, error.message);
    }
    throw new AdminApiError(
      503,
      "VOICE_SERVICE_CONTROL_FAILED",
      "语音服务操作失败，请检查运行日志。",
    );
  }
}

function repositoryFor(options: VoiceProfileRouteOptions, query: unknown) {
  return options.repository(
    requestAgentId(query, options.defaultAgentId?.() ?? "plana"),
  );
}

function requestAgentId(query: unknown, defaultAgentId: string) {
  const value =
    query && typeof query === "object"
      ? (query as { agentId?: unknown }).agentId
      : undefined;
  return String(value ?? defaultAgentId).trim() || defaultAgentId;
}

function requestLanguage(params: unknown): VoiceLanguage {
  const value =
    params && typeof params === "object"
      ? (params as { language?: unknown }).language
      : undefined;
  if (
    typeof value === "string" &&
    VOICE_LANGUAGES.includes(value as VoiceLanguage)
  )
    return value as VoiceLanguage;
  throw new AdminApiError(
    400,
    "VOICE_LANGUAGE_INVALID",
    "语音语言无效。",
    "language",
  );
}

function referenceBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminApiError(
      400,
      "VOICE_REFERENCE_INVALID",
      "参考音频请求无效。",
    );
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "fileName",
    "dataBase64",
    "referenceText",
    "sourceUrl",
    "characterUrl",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AdminApiError(
      400,
      "VOICE_REFERENCE_INVALID",
      "参考音频请求无效。",
    );
  }
  return value as {
    fileName: string;
    dataBase64: string;
    referenceText: string;
    sourceUrl?: string;
    characterUrl?: string;
  };
}

async function mapRepositoryError<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    if (error instanceof VoiceProfileError) {
      throw new AdminApiError(error.status, error.code, error.message);
    }
    throw new AdminApiError(
      500,
      "VOICE_PROFILE_UNAVAILABLE",
      "语音配置暂时不可用。",
    );
  }
}
