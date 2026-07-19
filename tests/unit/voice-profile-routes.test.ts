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
import { registerVoiceProfileRoutes } from "../../apps/api/plugins/voiceProfileRoutes.js";
import type {
  VoiceServiceControlPort,
  VoiceServiceRuntimeStatus,
} from "../../apps/api/voiceServiceControlClient.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  VoiceProfileRepository,
  defaultVoiceProfile,
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
  it("keeps profiles isolated by Agent and requires a reference before enabling", async () => {
    const repositories = await agentRepositories("plana", "koharu");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 7 }),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=plana",
      payload: { enabled: true, defaultLanguage: "ja" },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error).toMatchObject({
      code: "VOICE_DEFAULT_REFERENCE_REQUIRED",
    });

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/voice-profile/ja?agentId=koharu",
      payload: {
        fileName: "koharu.wav",
        dataBase64: waveFixture().toString("base64"),
        referenceText: "おはようございます。",
        sourceUrl: "https://kivo.wiki/voice/koharu",
      },
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().profile.languages.ja).toMatchObject({
      language: "ja",
      fileName: "koharu.wav",
      mimeType: "audio/wav",
      referenceText: "おはようございます。",
    });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=koharu",
      payload: { enabled: true, defaultLanguage: "ja" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().profile).toMatchObject({
      enabled: true,
      defaultLanguage: "ja",
    });

    const [koharu, plana] = await Promise.all([
      app.inject({ method: "GET", url: "/api/voice-profile?agentId=koharu" }),
      app.inject({ method: "GET", url: "/api/voice-profile?agentId=plana" }),
    ]);
    expect(koharu.json()).toMatchObject({
      profile: { enabled: true, languages: { ja: expect.any(Object) } },
      provider: { provider: "MOSS-TTS-Nano", ready: true, latencyMs: 7 },
    });
    expect(plana.json().profile).toEqual(defaultVoiceProfile());
  });

  it("rejects invalid language, settings and audio without exposing local paths", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 1 }),
    });

    const invalidLanguage = await app.inject({
      method: "PUT",
      url: "/api/voice-profile/fr?agentId=plana",
      payload: {
        fileName: "bad.wav",
        dataBase64: "AA==",
        referenceText: "bad",
      },
    });
    expect(invalidLanguage.statusCode).toBe(400);

    const invalidSettings = await app.inject({
      method: "PUT",
      url: "/api/voice-profile?agentId=plana",
      payload: { enabled: false, defaultLanguage: "fr" },
    });
    expect(invalidSettings.statusCode).toBe(400);
    expect(invalidSettings.json().error).toMatchObject({
      code: "VOICE_LANGUAGE_INVALID",
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

    const unsupported = await app.inject({
      method: "PUT",
      url: "/api/voice-profile/ja?agentId=plana",
      payload: {
        fileName: "private.txt",
        dataBase64: Buffer.from("not audio").toString("base64"),
        referenceText: "bad",
      },
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error).toMatchObject({
      code: "VOICE_REFERENCE_TYPE_UNSUPPORTED",
    });
    expect(
      JSON.stringify([
        invalidSettings.json(),
        invalidBase64.json(),
        unsupported.json(),
      ]),
    ).not.toContain(root);
  });

  it("reports health failures with a fixed public message", async () => {
    const repositories = await agentRepositories("plana");
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth(
        new Error(`upstream failed at ${root}/private.sock`),
      ),
      serviceController: serviceController({
        state: "stopped",
        updatedAt: "2026-07-19T01:02:02.000Z",
      }),
      now: () => new Date("2026-07-19T01:02:03.000Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-profile/probe?agentId=plana",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: {
        provider: "MOSS-TTS-Nano",
        ready: false,
        checkedAt: "2026-07-19T01:02:03.000Z",
        serviceState: "stopped",
        controlsAvailable: true,
        message: "语音服务已关闭",
      },
    });
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain("private.sock");
  });

  it("checks, starts and stops the managed voice service", async () => {
    const repositories = await agentRepositories("plana");
    const controller = serviceController({
      state: "stopped",
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    controller.start = vi.fn(async () => ({
      state: "running" as const,
      message: "语音服务已启动，模型载入后即可使用。",
      updatedAt: "2026-07-19T02:01:00.000Z",
    }));
    const app = testApp();
    registerVoiceProfileRoutes(app, {
      repository: (agentId) => requireRepository(repositories, agentId),
      client: clientWithHealth({ ok: true, latencyMs: 9 }),
      serviceController: controller,
      now: () => new Date("2026-07-19T02:02:00.000Z"),
    });

    const checked = await app.inject({
      method: "POST",
      url: "/api/voice-service/check?agentId=plana",
    });
    expect(checked.json().provider).toMatchObject({
      ready: true,
      serviceState: "running",
      controlsAvailable: true,
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/voice-service/start?agentId=plana",
    });
    expect(started.statusCode).toBe(200);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(started.json().provider).toMatchObject({
      ready: true,
      serviceState: "running",
      controlsAvailable: true,
    });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/voice-service/stop?agentId=plana",
    });
    expect(stopped.statusCode).toBe(200);
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(stopped.json().provider).toEqual({
      provider: "MOSS-TTS-Nano",
      ready: false,
      checkedAt: "2026-07-19T02:02:00.000Z",
      serviceState: "stopped",
      controlsAvailable: true,
      message: "语音服务已关闭",
    });
  });

  it("builds one repository per Agent and fails closed for an unavailable Agent", async () => {
    const planaConfig = createAdminTestConfig(root);
    const koharuConfig = createAdminTestConfig(root);
    planaConfig.persona.agentWorkspace = path.join(root, "plana");
    koharuConfig.persona.agentWorkspace = path.join(root, "koharu");
    await Promise.all([
      fs.mkdir(planaConfig.persona.agentWorkspace, { recursive: true }),
      fs.mkdir(koharuConfig.persona.agentWorkspace, { recursive: true }),
    ]);
    const runtimes = new Map([
      ["plana", { config: planaConfig }],
      ["koharu", { config: koharuConfig }],
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
    expect(composition.repository("koharu")).not.toBe(
      composition.repository("plana"),
    );
    await composition.repository("koharu").putReference({
      language: "ja",
      fileName: "koharu.wav",
      dataBase64: waveFixture().toString("base64"),
      referenceText: "こんばんは。",
    });
    await composition
      .repository("koharu")
      .updateSettings({ enabled: true, defaultLanguage: "ja" });
    await expect(composition.resolveCapability("koharu")).resolves.toEqual({
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

function serviceController(
  initial: VoiceServiceRuntimeStatus,
): VoiceServiceControlPort {
  return {
    check: vi.fn(async () => initial),
    start: vi.fn(async () => ({
      state: "running",
      updatedAt: "2026-07-19T02:01:00.000Z",
    })),
    stop: vi.fn(async () => ({
      state: "stopped",
      message: "语音服务已关闭",
      updatedAt: "2026-07-19T02:03:00.000Z",
    })),
  };
}

function waveFixture() {
  const data = Buffer.from([1, 0, 1, 0]);
  const bytes = Buffer.alloc(44 + data.byteLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + data.byteLength, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.byteLength, 40);
  data.copy(bytes, 44);
  return bytes;
}
