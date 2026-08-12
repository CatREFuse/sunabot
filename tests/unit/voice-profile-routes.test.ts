// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVoiceApiComposition,
  registerVoiceApi,
} from "../../apps/api/voiceApiComposition.js";
import {
  VOICE_HEALTH_PROBE_TIMEOUT_MS,
  registerVoiceProfileRoutes
} from "../../apps/api/plugins/voiceProfileRoutes.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import {
  VoiceProfileRepository,
  defaultVoiceProfile,
  type VoiceProviderSettings,
  type VoiceSynthesisClient,
} from "../../services/voice/public.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-voice-routes-"));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("voice profile routes", () => {
  it("keeps online provider settings isolated by Agent and requires a default voice", async () => {
    const repositories = await agentRepositories("plana", "arona");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 7 }),
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=arona",
      payload: { enabled: true, defaultLanguage: "ja" },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error).toMatchObject({
      code: "VOICE_DEFAULT_VOICE_REQUIRED",
    });

    const configured = await app.inject({
      method: "PUT",
      url: "/api/voice-provider?agentId=arona",
      payload: providerSettings({ ja: "voice_arona" }),
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().profile.provider).toEqual(
      providerSettings({ ja: "voice_arona" }),
    );

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=arona",
      payload: { enabled: true, defaultLanguage: "ja" },
    });
    expect(enabled.statusCode).toBe(200);

    const [arona, plana] = await Promise.all([
      app.inject({ method: "GET", url: "/api/voice-profile?agentId=arona" }),
      app.inject({ method: "GET", url: "/api/voice-profile?agentId=plana" }),
    ]);
    expect(arona.json()).toMatchObject({
      profile: {
        enabled: true,
        defaultLanguage: "ja",
        provider: { voices: { ja: "voice_arona" } },
      },
      provider: { provider: "OpenAI Audio", ready: true, latencyMs: 7 },
    });
    expect(plana.json().profile).toEqual(defaultVoiceProfile());
  });

  it("rejects invalid language, provider settings and audio without exposing local paths", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 1 }),
    });

    const invalidLanguage = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=plana",
      payload: { enabled: false, defaultLanguage: "fr" },
    });
    expect(invalidLanguage.statusCode).toBe(400);
    expect(invalidLanguage.json().error).toMatchObject({
      code: "VOICE_LANGUAGE_INVALID",
    });

    const invalidProvider = await app.inject({
      method: "PUT",
      url: "/api/voice-provider?agentId=plana",
      payload: {
        ...providerSettings({ ja: "voice_plana" }),
        baseUrl: "http://example.com/v1",
      },
    });
    expect(invalidProvider.statusCode).toBe(400);
    expect(invalidProvider.json().error).toMatchObject({
      code: "VOICE_PROVIDER_INVALID",
    });

    const invalidBase64 = await app.inject({
      method: "PUT",
      url: "/api/voice-profile/ja?agentId=plana",
      payload: {
        fileName: "bad.wav",
        dataBase64: "not-base64",
        referenceText: "bad",
      },
    });
    expect(invalidBase64.statusCode).toBe(400);
    expect(invalidBase64.json().error).toMatchObject({
      code: "VOICE_REFERENCE_BASE64_INVALID",
    });
    expect(
      JSON.stringify([
        invalidLanguage.json(),
        invalidProvider.json(),
        invalidBase64.json(),
      ]),
    ).not.toContain(root);
  });

  it("reports online health failures with a fixed public message", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth(new Error(`failed at ${root}/private.sock`)),
      now: () => new Date("2026-07-20T01:02:03.000Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-service/check?agentId=plana",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: {
        provider: "OpenAI Audio",
        state: "unavailable",
        ready: false,
        checkedAt: "2026-07-20T01:02:03.000Z",
        message: "在线语音服务不可用",
      },
    });
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain("private.sock");
  });

  it("reports a missing API Key as unconfigured", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth(
        Object.assign(new Error("secret value must stay private"), {
          code: "VOICE_PROVIDER_KEY_MISSING",
        }),
      ),
      now: () => new Date("2026-07-20T01:02:03.000Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-service/check?agentId=plana",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: {
        provider: "OpenAI Audio",
        state: "unconfigured",
        ready: false,
        checkedAt: "2026-07-20T01:02:03.000Z",
        message: "API Key 未配置",
      },
    });
    expect(response.body).not.toContain("secret value");
  });

  it("keeps only the online connection check action", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 9 }),
    });

    const checked = await app.inject({
      method: "POST",
      url: "/api/voice-service/check?agentId=plana",
    });
    expect(checked.json().provider).toMatchObject({
      provider: "OpenAI Audio",
      ready: true,
      latencyMs: 9,
    });
    expect(VOICE_HEALTH_PROBE_TIMEOUT_MS).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/voice-service/start?agentId=plana",
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/voice-service/stop?agentId=plana",
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("builds one repository per Agent and resolves capability from voice IDs", async () => {
    const planaConfig = createAdminTestConfig(root);
    const aronaConfig = createAdminTestConfig(root);
    planaConfig.persona.agentWorkspace = path.join(root, "plana");
    aronaConfig.persona.agentWorkspace = path.join(root, "arona");
    await Promise.all([
      fs.mkdir(planaConfig.persona.agentWorkspace, { recursive: true }),
      fs.mkdir(aronaConfig.persona.agentWorkspace, { recursive: true }),
    ]);
    const runtimes = new Map([
      ["plana", { config: planaConfig }],
      ["arona", { config: aronaConfig }],
    ]);
    const composition = buildVoiceApiComposition({
      defaultAgentId: () => "plana",
      getRuntime: (agentId) => {
        const runtime = runtimes.get(agentId);
        if (!runtime) throw new Error(`missing runtime at ${root}/${agentId}`);
        return runtime;
      },
      client: clientWithHealth({ ok: true, latencyMs: 2 }),
    });
    const app = testApp();
    registerVoiceApi(app, composition);

    expect(composition.repository("plana")).toBe(
      composition.repository("plana"),
    );
    expect(composition.repository("arona")).not.toBe(
      composition.repository("plana"),
    );
    await composition
      .repository("arona")
      .updateProvider(providerSettings({ ja: "voice_arona" }));
    await composition
      .repository("arona")
      .updateSettings({ enabled: true, defaultLanguage: "ja" });
    await expect(composition.resolveCapability("arona")).resolves.toEqual({
      enabled: true,
      languages: ["ja"],
      defaultLanguage: "ja",
    });
    await expect(composition.resolveCapability("missing")).resolves.toEqual({
      enabled: false,
      languages: [],
      defaultLanguage: "ja",
    });

    const unavailable = await app.inject({
      method: "GET",
      url: "/api/voice-profile?agentId=missing",
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().error).toEqual({
      code: "VOICE_AGENT_UNAVAILABLE",
      message: "Agent 尚未就绪。",
    });
    expect(unavailable.body).not.toContain(root);
  });
});

function testApp() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError)
      return reply.status(error.statusCode).send(error.toJSON());
    const statusCode =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: statusCode === 500 ? "服务器处理请求失败。" : error.message,
      },
    });
  });
  return app;
}

async function agentRepositories(...agentIds: string[]) {
  const entries = await Promise.all(
    agentIds.map(async (agentId) => {
      const workspace = path.join(root, agentId);
      await fs.mkdir(workspace, { recursive: true });
      return [agentId, new VoiceProfileRepository(workspace)] as const;
    }),
  );
  return new Map(entries);
}

function requireRepository(
  repositories: Map<string, VoiceProfileRepository>,
  agentId: string,
) {
  const repository = repositories.get(agentId);
  if (!repository)
    throw new Error(`unexpected repository path: ${root}/${agentId}`);
  return repository;
}

function clientWithHealth(
  result: { ok: true; latencyMs: number } | Error,
): VoiceSynthesisClient {
  return {
    health: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    generate: vi.fn(async () => {
      throw new Error("generate is not used by route tests");
    }),
  };
}

function providerSettings(
  voices: Partial<VoiceProviderSettings["voices"]> = {},
): VoiceProviderSettings {
  return {
    protocol: "openai-audio",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4o-mini-tts",
    voices: { zh: null, en: null, ja: null, ...voices },
  };
}
