// @vitest-environment node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AGENT_FILE_DEFINITIONS } from "../../src/admin/agentFiles.js";
import { defaultConfig, saveConfig } from "../../src/config.js";
import { buildApp, createApp } from "../../apps/api/server.js";
import type { CreateAppOptions } from "../../apps/api/server.js";
import type { AppConfig } from "../../src/types.js";

const ADMIN_HEADERS = { host: "127.0.0.1", authorization: "Bearer admin-secret" };
const scopedUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}agentId=plana`;

async function requestThroughGlobalFetch(url: URL, init: RequestInit) {
  return {
    response: await fetch(url, init),
    close: async () => undefined,
    destroy: async () => undefined
  };
}

describe("admin API smoke", () => {
  let temporaryDirectory = "";
  let previousConfigPath: string | undefined;
  let previousAdminToken: string | undefined;
  let previousOneBotToken: string | undefined;
  let config: AppConfig;

  function testAppOptions(options: CreateAppOptions = {}): CreateAppOptions {
    return {
      config,
      initializeRuntime: false,
      agentRegistry: {
        workspaceRoot: path.join(temporaryDirectory, "business", "agents"),
        allowUnmarkedMigration: true
      },
      agentExtensions: {
        workspaceRoot: temporaryDirectory
      },
      runtimeProbeClient: false,
      ...options
    };
  }

  beforeEach(async () => {
    previousConfigPath = process.env.SUNABOT_CONFIG;
    previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
    previousOneBotToken = process.env.ONEBOT_ACCESS_TOKEN;
    process.env.SUNABOT_ADMIN_TOKEN = "admin-secret";
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-api-test-"));
    process.env.SUNABOT_CONFIG = path.join(temporaryDirectory, "sunabot.json");
    config = defaultConfig();
    config.persona.agentWorkspace = path.join(temporaryDirectory, "business", "agents", "plana");
    config.persona.systemPromptWorkspace = path.join(temporaryDirectory, "system-prompts");
    await Promise.all([
      fs.mkdir(config.persona.agentWorkspace, { recursive: true, mode: 0o700 }),
      fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true, mode: 0o700 })
    ]);
    for (const definition of AGENT_FILE_DEFINITIONS) {
      const workspace = definition.scope === "system"
        ? config.persona.systemPromptWorkspace
        : config.persona.agentWorkspace;
      const filePath = path.join(workspace, definition.fileName(config));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${definition.id}\n`, "utf8");
    }
    await saveConfig(config);
  });

  afterEach(async () => {
    if (previousConfigPath == null) delete process.env.SUNABOT_CONFIG;
    else process.env.SUNABOT_CONFIG = previousConfigPath;
    if (previousAdminToken == null) delete process.env.SUNABOT_ADMIN_TOKEN;
    else process.env.SUNABOT_ADMIN_TOKEN = previousAdminToken;
    if (previousOneBotToken == null) delete process.env.ONEBOT_ACCESS_TOKEN;
    else process.env.ONEBOT_ACCESS_TOKEN = previousOneBotToken;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("serves the model catalog, config envelope and all prompt files", async () => {
    const app = await createApp(testAppOptions());
    const headers = ADMIN_HEADERS;
    const models = await app.inject({ method: "GET", url: "/api/models", headers });
    const envelope = await app.inject({ method: "GET", url: scopedUrl("/api/config"), headers });
    const files = await app.inject({ method: "GET", url: scopedUrl("/api/agent-files"), headers });
    const systemFiles = await app.inject({ method: "GET", url: scopedUrl("/api/system-prompt-files"), headers });
    expect(models.statusCode).toBe(200);
    expect(models.json().models).toHaveLength(7);
    expect(envelope.statusCode).toBe(200);
    expect(envelope.json().revision).toMatch(/^[a-f0-9]{64}$/);
    expect(files.statusCode).toBe(200);
    expect(files.json().files.map(({ id }: { id: string }) => id)).toEqual([
      "persona.agents",
      "persona.soul",
      "persona.preference",
      "persona.dialogue_style_examples",
      "persona.user",
      "persona.relation",
      "persona.air",
      "persona.director-seed",
      "image.selfie-rewrite"
    ]);
    expect(systemFiles.statusCode).toBe(200);
    expect(systemFiles.json().files.map(({ id }: { id: string }) => id)).toEqual([
      "conversation.private-reply",
      "conversation.group-reply",
      "conversation.tone-rewrite",
      "memory.compress-out",
      "memory.dream",
      "orchestrator.user-group",
      "conversation.group-summary",
      "scheduler.cron-callback",
      "director.daily-plan",
      "director.schedule-revision",
      "air.read"
    ]);
    expect(systemFiles.json().files).toContainEqual(expect.objectContaining({
      id: "conversation.private-reply",
      kind: "final",
      fileName: "conversation_private_reply.json",
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "persona.dialogue_style_examples", description: expect.any(String) }),
        expect.objectContaining({ name: "message_32", type: "message[]" }),
        expect.objectContaining({ name: "user.input", description: expect.any(String) })
      ])
    }));
    expect(systemFiles.json().files).toContainEqual(expect.objectContaining({
      id: "conversation.group-reply"
    }));
    expect(systemFiles.json().files).toContainEqual(expect.objectContaining({
      id: "conversation.tone-rewrite",
      kind: "final",
      fileName: "tone_rewrite.json",
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "tone.input", description: expect.any(String) })
      ])
    }));
    expect(files.json().files).toContainEqual(expect.objectContaining({ id: "image.selfie-rewrite" }));
    expect(systemFiles.json().files).toContainEqual(expect.objectContaining({
      id: "scheduler.cron-callback",
      kind: "final",
      fileName: "cron_callback.json",
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "cron.payload", type: "json", description: expect.any(String) })
      ])
    }));
    expect(systemFiles.json().files).not.toContainEqual(expect.objectContaining({ id: "image.selfie-rewrite" }));
    const toneFile = await app.inject({
      method: "GET",
      url: scopedUrl("/api/system-prompt-files/conversation.tone-rewrite"),
      headers
    });
    expect(toneFile.statusCode).toBe(200);
    expect(toneFile.json()).toMatchObject({
      id: "conversation.tone-rewrite",
      fileName: "tone_rewrite.json",
      content: "conversation.tone-rewrite\n"
    });
    for (const [endpoint, summaries] of [
      ["/api/agent-files", files.json().files],
      ["/api/system-prompt-files", systemFiles.json().files]
    ] as const) {
      for (const summary of summaries) {
        const detail = await app.inject({ method: "GET", url: scopedUrl(`${endpoint}/${summary.id}`), headers });
        expect(detail.statusCode, `${endpoint}/${summary.id}`).toBe(200);
        expect(detail.json()).toMatchObject({ id: summary.id, content: expect.any(String) });
      }
    }
    await app.close();
  });

  it("protects the config doctor and keeps AI calls behind an explicit authorized request", async () => {
    const configDoctorModelRunner = vi.fn(async () => JSON.stringify({ summary: "ok", operations: [] }));
    const app = await createApp(testAppOptions({ configDoctorModelRunner }));

    const unauthorizedScan = await app.inject({ method: "GET", url: "/api/config-doctor/scan" });
    const unauthorizedAi = await app.inject({
      method: "POST",
      url: "/api/config-doctor/propose",
      payload: { sourceRevision: "unknown" }
    });
    const scan = await app.inject({
      method: "GET",
      url: "/api/config-doctor/scan",
      headers: ADMIN_HEADERS
    });

    expect(unauthorizedScan.statusCode).toBe(401);
    expect(unauthorizedAi.statusCode).toBe(401);
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ schemaVersion: 1, sourceRevision: expect.any(String) });
    expect(configDoctorModelRunner).not.toHaveBeenCalled();
    await app.close();
  });

  it("updates and serves the current Agent WebUI avatar", async () => {
    const app = await createApp(testAppOptions());
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const update = await app.inject({
      method: "PUT",
      url: "/api/agents/plana/avatar",
      headers: ADMIN_HEADERS,
      payload: {
        avatar: { fileName: "plana.png", dataBase64: bytes.toString("base64") }
      }
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().avatarPath).toMatch(/^assets\/avatar-[A-Za-z0-9_-]+\.png$/);
    const image = await app.inject({
      method: "GET",
      url: "/api/agents/plana/avatar",
      headers: ADMIN_HEADERS
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload).toEqual(bytes);
    await app.close();
  });

  it("runs OneBot on an injected listener and closes it with the admin service", async () => {
    process.env.ONEBOT_ACCESS_TOKEN = "listener-test-token";
    const injectedServer = http.createServer();
    const built = await buildApp(testAppOptions({
      onebotListener: { server: injectedServer, host: "127.0.0.1", port: 0 }
    }));

    const onebotAddress = await built.startOneBotListener();
    const adminOrigin = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const adminPort = Number(new URL(adminOrigin).port);
    expect(built.onebotServer).toBe(injectedServer);
    expect(onebotAddress.port).not.toBe(adminPort);

    const websocket = new WebSocket(
      `ws://127.0.0.1:${onebotAddress.port}${config.onebot.reverseWsPath}?access_token=listener-test-token`
    );
    await new Promise<void>((resolve, reject) => {
      websocket.once("open", resolve);
      websocket.once("error", reject);
    });
    expect(built.onebotGateway.getStatus().connections).toBe(1);

    const websocketClosed = new Promise<void>((resolve) => websocket.once("close", resolve));
    await built.app.close();
    await websocketClosed;
    expect(injectedServer.listening).toBe(false);
    expect(built.app.server.listening).toBe(false);
  });

  it("allows tests to disable the OneBot listener", async () => {
    const built = await buildApp(testAppOptions({ onebotListener: false }));
    expect(built.onebotServer).toBeUndefined();
    await expect(built.startOneBotListener()).rejects.toThrow("disabled");
    await built.app.close();
  });

  it("exposes only an empty liveness endpoint on the dedicated OneBot HTTP listener", async () => {
    process.env.ONEBOT_ACCESS_TOKEN = "listener-test-token";
    const built = await buildApp(testAppOptions());
    const address = await built.startOneBotListener({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${origin}/healthz`);
    const unknown = await fetch(`${origin}/api/status`);
    expect(health.status).toBe(204);
    expect(await health.text()).toBe("");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("ONEBOT_WEBSOCKET_UPGRADE_REQUIRED\n");

    await built.app.close();
    expect(built.onebotServer?.listening).toBe(false);
  });

  it("tests a complete provider draft without changing disk config", async () => {
    const app = await createApp(testAppOptions({
      testProvider: async () => ({ connected: true })
    }));
    const headers = ADMIN_HEADERS;
    const before = await fs.readFile(process.env.SUNABOT_CONFIG!, "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers,
      payload: { provider: { ...config.providers.items[0], multimodal: "disabled" } }
    });
    const after = await fs.readFile(process.env.SUNABOT_CONFIG!, "utf8");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, connected: true, model: "gpt-5.5" });
    expect(response.json().elapsedMs).toEqual(expect.any(Number));
    expect(after).toBe(before);
    await app.close();
  }, 20_000);

  it("enforces auth for forwarded requests and accepts a valid bearer token", async () => {
    const app = await createApp(testAppOptions());
    let response = await app.inject({
      method: "GET",
      url: scopedUrl("/api/status"),
      headers: { host: "127.0.0.1", "x-forwarded-for": "127.0.0.1" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_UNAUTHORIZED");

    response = await app.inject({
      method: "GET",
      url: scopedUrl("/api/status"),
      headers: {
        host: "127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        authorization: "Bearer admin-secret"
      }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  }, 20_000);

  it("protects readiness while reusing the host probe facts and keeps runtime liveness secret-free", async () => {
    const collectFacts = vi.fn(async () => ({
      workspace: { exists: true, migrationState: "trusted", path: temporaryDirectory },
      core: { mode: "native", running: true, apiReady: true, onebotReady: true },
      dependencies: { node: { ok: true, detail: process.versions.node } },
      capabilities: { provider: { ok: true, detail: "test-provider" } },
      accounts: [{
        id: "primary",
        desiredState: "running",
        observedState: "running",
        connected: false,
        reconcileRequired: false,
        lastError: null
      }]
    }));
    const app = await createApp(testAppOptions({
      onebotListener: false,
      runtimeProbeClient: { collectFacts }
    }));

    const unauthorized = await app.inject({
      method: "GET",
      url: scopedUrl("/api/readiness"),
      headers: { host: "127.0.0.1" }
    });
    const readiness = await app.inject({
      method: "GET",
      url: scopedUrl("/api/readiness"),
      headers: ADMIN_HEADERS
    });
    const liveness = await app.inject({
      method: "GET",
      url: "/healthz/runtime",
      headers: { host: "127.0.0.1" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      schemaVersion: 1,
      summary: { liveness: "live", readiness: "degraded" },
      accounts: [{ id: "primary", connected: false }]
    });
    expect(collectFacts).toHaveBeenCalledWith({ connectedAccountIds: [] });
    expect(liveness.json()).toEqual({ schemaVersion: 1, live: true });
    expect(liveness.body).not.toContain("test-provider");
    await app.close();
  });

  it("serves global system settings without requiring an Agent", async () => {
    const app = await createApp(testAppOptions());
    const globalEnvelope = await app.inject({ method: "GET", url: "/api/config", headers: ADMIN_HEADERS });

    expect(globalEnvelope.statusCode).toBe(200);
    expect(globalEnvelope.json().config.normalReply.maxRetries).toBe(3);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/config/normalReply",
      headers: ADMIN_HEADERS,
      payload: {
        revision: globalEnvelope.json().revision,
        value: { maxRetries: 4 }
      }
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.normalReply.maxRetries).toBe(4);

    const agentOnlyPatch = await app.inject({
      method: "PATCH",
      url: "/api/config/bot",
      headers: ADMIN_HEADERS,
      payload: {
        revision: patch.json().revision,
        value: {}
      }
    });

    expect(agentOnlyPatch.statusCode).toBe(400);
    expect(agentOnlyPatch.json()).toMatchObject({ error: { code: "AGENT_ID_REQUIRED" } });
    await app.close();
  });

  it("reloads the config envelope from disk after an external edit", async () => {
    const app = await createApp(testAppOptions());
    config.server.port = 9123;
    await saveConfig(config);
    const response = await app.inject({ method: "GET", url: scopedUrl("/api/config"), headers: ADMIN_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json().config.server.port).toBe(9123);
    await app.close();
  });

  it("rejects changing the fixed Plana workspace", async () => {
    const app = await createApp(testAppOptions());
    const headers = ADMIN_HEADERS;
    const envelope = await app.inject({ method: "GET", url: scopedUrl("/api/config"), headers });
    const nextWorkspace = path.join(temporaryDirectory, "new-agent");
    const response = await app.inject({
      method: "PATCH",
      url: scopedUrl("/api/config/persona"),
      headers,
      payload: {
        revision: envelope.json().revision,
        value: {
          agentWorkspace: nextWorkspace
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "CONFIG_INVALID",
        field: "persona.agentWorkspace"
      }
    });
    await expect(fs.access(path.join(nextWorkspace, "conversation_private_reply.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it.each([
    "http://localhost/image.png",
    "http://127.0.0.1/image.png",
    "http://10.1.2.3/image.png",
    "http://192.168.1.10/image.png",
    "http://[::1]/image.png"
  ])("loads local and private image proxy targets: %s", async (imageUrl) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" }
    }));
    const app = await createApp(testAppOptions({ mediaPinnedRequest: requestThroughGlobalFetch }));
    const response = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent(imageUrl)}`,
      headers: ADMIN_HEADERS
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(new URL(imageUrl), expect.objectContaining({ redirect: "manual" }));
    fetchMock.mockRestore();
    await app.close();
  });

  it("loads QQ message images when the CDN resolves through Clash fake IP", async () => {
    const imageUrl = "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=fixture&rkey=fixture";
    const mediaHostnameLookup = vi.fn(async () => [{ address: "198.18.0.226" }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" }
    }));
    const app = await createApp(testAppOptions({ mediaHostnameLookup, mediaPinnedRequest: requestThroughGlobalFetch }));
    const response = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent(imageUrl)}`,
      headers: ADMIN_HEADERS
    });

    expect(mediaHostnameLookup).toHaveBeenCalledWith("multimedia.nt.qq.com.cn");
    expect(fetchMock).toHaveBeenCalledWith(new URL(imageUrl), expect.objectContaining({ redirect: "manual" }));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    fetchMock.mockRestore();
    await app.close();
  });

  it("maps an upstream image 401 to a proxy error without forwarding authentication semantics", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", {
      status: 401,
      headers: { "content-type": "text/plain" }
    }));
    const app = await createApp(testAppOptions({ mediaPinnedRequest: requestThroughGlobalFetch }));
    const response = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent("https://8.8.8.8/image.png")}`,
      headers: ADMIN_HEADERS
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(502);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json()).toMatchObject({ error: { code: "IMAGE_LOAD_FAILED" } });
    await app.close();
  });

  it("loads QQ user and group avatars through the dedicated proxy", async () => {
    const mediaHostnameLookup = vi.fn(async () => [{ address: "8.8.8.8" }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" }
    }));
    const app = await createApp(testAppOptions({ mediaHostnameLookup, mediaPinnedRequest: requestThroughGlobalFetch }));

    const user = await app.inject({
      method: "GET",
      url: "/api/media/qq-avatar?kind=user&id=171419991",
      headers: ADMIN_HEADERS
    });
    const group = await app.inject({
      method: "GET",
      url: "/api/media/qq-avatar?kind=group&id=1030412235",
      headers: ADMIN_HEADERS
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/media/qq-avatar?kind=user&id=../../etc/passwd",
      headers: ADMIN_HEADERS
    });

    expect(mediaHostnameLookup.mock.calls.map(([hostname]) => hostname)).toEqual(["q1.qlogo.cn", "p.qlogo.cn"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://q1.qlogo.cn/g?b=qq&nk=171419991&s=100",
      "https://p.qlogo.cn/gh/1030412235/1030412235/100/"
    ]);
    expect(user.statusCode).toBe(200);
    expect(user.headers["content-type"]).toContain("image/jpeg");
    expect(group.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "QQ_AVATAR_INVALID", field: "id" } });
    fetchMock.mockRestore();
    await app.close();
  });

  it("converts image resolution to the actual size and stores the provider image model", async () => {
    const built = await buildApp(testAppOptions());
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/playground-test.png",
      filePath: path.join(temporaryDirectory, "playground-test.png"),
      revisedPrompt: "do not use this as the model"
    }));
    vi.spyOn(built.runtime, "getProvider").mockReturnValue({
      generateImage,
      getModelInfo: () => ({ model: "gpt-5.6-sol", imageModel: "gpt-image-2-test" })
    } as never);

    const response = await built.app.inject({
      method: "POST",
      url: scopedUrl("/api/playground/image"),
      headers: ADMIN_HEADERS,
      payload: {
        prompt: "portrait test",
        size: "1024x1536",
        resolution: "4K"
      }
    });
    const history = await built.app.inject({
      method: "GET",
      url: scopedUrl("/api/images"),
      headers: ADMIN_HEADERS
    });
    const record = history.json().images.find((item: { id: string }) => item.id === "playground-test.png");

    expect(response.statusCode).toBe(200);
    expect(generateImage).toHaveBeenCalledWith("portrait test", "2160x3840", "high");
    expect(record).toMatchObject({
      size: "2160x3840",
      resolution: "4K",
      model: "gpt-image-2-test"
    });
    await built.app.close();
  });
});
