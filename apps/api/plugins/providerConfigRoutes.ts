import type { FastifyInstance } from "fastify";
import { OpenAIProvider } from "../../../adapters/model/openaiProvider.js";
import { discoverProviderModels, probeProviderMultimodal } from "../../../adapters/model/providerDiscovery.js";
import { ConfigService, validateProviderDraft } from "../../../src/admin/configService.js";
import type { CodexAuthService } from "../../../src/admin/codexAuth.js";
import { AdminApiError, badRequest } from "../../../src/admin/errors.js";
import { IMAGE_MODEL_CATALOG, MODEL_CATALOG, REASONING_EFFORTS } from "../../../src/admin/models.js";
import type { ProviderConfig } from "../../../src/types.js";

export type ProviderTestRunner = (provider: ProviderConfig) => Promise<Record<string, unknown>>;
export type ProviderModelsRunner = (provider: ProviderConfig) => Promise<string[]>;
export type ProviderVisionProbeRunner = (provider: ProviderConfig) => Promise<{ multimodal: boolean; reason?: string }>;

export interface ProviderConfigRouteOptions {
  codexAuth: Pick<CodexAuthService, "status" | "startLogin" | "logout">;
  configService: Pick<ConfigService, "readEnvelope" | "patchGroupReply" | "patch">;
  testProvider?: ProviderTestRunner;
  listProviderModels?: ProviderModelsRunner;
  probeProviderVision?: ProviderVisionProbeRunner;
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;

export function registerProviderConfigRoutes(
  app: FastifyInstance,
  options: ProviderConfigRouteOptions
) {
  app.get("/api/codex-auth/status", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.codexAuth.status());

  app.post("/api/codex-auth/login", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.codexAuth.startLogin());

  app.post("/api/codex-auth/logout", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.codexAuth.logout());

  app.get("/api/config", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.configService.readEnvelope());

  app.patch("/api/config/group-reply", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => options.configService.patchGroupReply(request.body));

  app.patch("/api/config/:section", {
    schema: {
      params: {
        type: "object",
        required: ["section"],
        properties: { section: { type: "string" } },
        additionalProperties: true
      },
      body: passthroughBody,
      response: { 200: openObject }
    }
  }, async (request) => {
    const params = request.params as { section?: string };
    return options.configService.patch(String(params.section ?? ""), request.body);
  });

  app.get("/api/models", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => ({
    models: MODEL_CATALOG,
    reasoningEfforts: REASONING_EFFORTS,
    imageModels: IMAGE_MODEL_CATALOG
  }));

  app.post("/api/providers/test", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
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
    if (provider.multimodal === "auto") {
      try {
        const vision = await (options.probeProviderVision ?? probeProviderMultimodal)(provider);
        result = { ...result, multimodal: vision.multimodal, ...(vision.reason ? { visionReason: vision.reason } : {}) };
      } catch (error) {
        result = { ...result, multimodal: false, visionReason: error instanceof Error ? error.message : String(error) };
      }
    }
    const elapsedMs = Math.max(0, Math.round(performance.now() - started));
    return {
      ...result,
      ok: true,
      model: provider.model,
      elapsedMs
    };
  });

  app.post("/api/providers/models", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const provider = providerFromBody(request.body, "PROVIDER_MODELS_INVALID");
    try {
      const models = await (options.listProviderModels ?? discoverProviderModels)(provider);
      return { ok: true, models };
    } catch (error) {
      throw new AdminApiError(422, "PROVIDER_MODELS_FAILED", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/providers/vision-probe", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const provider = providerFromBody(request.body, "PROVIDER_VISION_INVALID");
    const result = await (options.probeProviderVision ?? probeProviderMultimodal)(provider);
    return { ok: true, ...result };
  });
}

function providerFromBody(body: unknown, code: string) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "provider")) {
    badRequest(code, "请求体必须只包含 provider。", "provider");
  }
  return validateProviderDraft((body as { provider?: unknown }).provider);
}
