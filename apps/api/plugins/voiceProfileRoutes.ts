import type { FastifyInstance } from "fastify";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../../packages/contracts/model/modelGateway.js";
import { AdminApiError } from "../../../src/admin/errors.js";
import {
  VOICE_LANGUAGES,
  VoiceProfileError,
  type VoiceLanguage,
  type VoiceProfileRepository,
  type VoiceProfileV1,
  type VoiceSynthesisClient,
} from "../../../services/voice/public.js";
import { requestAgentId } from "../requestAgentId.js";

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
export const VOICE_HEALTH_PROBE_TIMEOUT_MS = AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;
const languageParams = {
  type: "object",
  required: ["language"],
  properties: { language: { type: "string", enum: VOICE_LANGUAGES } },
  additionalProperties: false,
} as const;

export interface VoiceProfileRouteOptions {
  repository(agentId: string): VoiceProfileRepository;
  client?: VoiceSynthesisClient;
  clientForProfile?: (profile: VoiceProfileV1) => VoiceSynthesisClient;
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
      const profile = await mapRepositoryError(() => repository.readProfile());
      return {
        profile,
        provider: await probeProfileProvider(options, profile, now),
      };
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
    "/api/voice-provider",
    {
      schema: {
        querystring: openObject,
        body: passthroughBody,
        response: { 200: openObject },
      },
    },
    async (request) => ({
      profile: await mapRepositoryError(() =>
        repositoryFor(options, request.query).updateProvider(
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

  for (const route of [
    "/api/voice-profile/probe",
    "/api/voice-service/check",
  ]) {
    app.post(
      route,
      {
        schema: { querystring: openObject, response: { 200: openObject } },
      },
      async (request) => {
        const profile = await mapRepositoryError(() =>
          repositoryFor(options, request.query).readProfile(),
        );
        return {
          provider: await probeProfileProvider(options, profile, now),
        };
      },
    );
  }
}

export async function probeVoiceProvider(
  client: VoiceSynthesisClient,
  now: () => Date = () => new Date(),
) {
  const checkedAt = now().toISOString();
  try {
    const health = await client.health({
      signal: AbortSignal.timeout(VOICE_HEALTH_PROBE_TIMEOUT_MS),
    });
    return {
      provider: "OpenAI Audio" as const,
      state: "ready" as const,
      ready: true,
      checkedAt,
      latencyMs: health.latencyMs,
    };
  } catch (error) {
    return unavailableProvider(checkedAt, providerError(error));
  }
}

async function probeProfileProvider(
  options: VoiceProfileRouteOptions,
  profile: VoiceProfileV1,
  now: () => Date,
) {
  const checkedAt = now().toISOString();
  try {
    const client =
      options.client ?? options.clientForProfile?.(profile) ?? missingClient();
    return await probeVoiceProvider(client, now);
  } catch (error) {
    return unavailableProvider(checkedAt, providerError(error));
  }
}

function missingClient(): never {
  throw new Error("voice client unavailable");
}

function unavailableProvider(
  checkedAt: string,
  error: { state: "unconfigured" | "unavailable"; message: string },
) {
  return {
    provider: "OpenAI Audio" as const,
    state: error.state,
    ready: false,
    checkedAt,
    message: error.message,
  };
}

function providerError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "VOICE_PROVIDER_KEY_MISSING"
  ) {
    return { state: "unconfigured" as const, message: "API Key 未配置" };
  }
  return {
    state: "unavailable" as const,
    message: "在线语音服务不可用",
  };
}

function repositoryFor(options: VoiceProfileRouteOptions, query: unknown) {
  return options.repository(requestAgentId(query));
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
