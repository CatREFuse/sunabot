// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_FILE_DEFINITIONS } from "../../src/admin/agentFiles.js";
import { defaultConfig, saveConfig } from "../../src/config.js";
import { buildApp, createApp } from "../../src/server.js";
import type { AppConfig } from "../../src/types.js";

const ADMIN_HEADERS = { host: "127.0.0.1", authorization: "Bearer admin-secret" };

describe("admin API smoke", () => {
  let temporaryDirectory = "";
  let previousConfigPath: string | undefined;
  let previousAdminToken: string | undefined;
  let config: AppConfig;

  beforeEach(async () => {
    previousConfigPath = process.env.SUNABOT_CONFIG;
    previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
    process.env.SUNABOT_ADMIN_TOKEN = "admin-secret";
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-api-test-"));
    process.env.SUNABOT_CONFIG = path.join(temporaryDirectory, "sunabot.json");
    config = defaultConfig();
    config.persona.agentWorkspace = path.join(temporaryDirectory, "agent");
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    for (const definition of AGENT_FILE_DEFINITIONS) {
      const filePath = path.join(config.persona.agentWorkspace, definition.fileName(config));
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
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("serves the model catalog, config envelope and all prompt files", async () => {
    const app = await createApp({ config, initializeRuntime: false });
    const headers = ADMIN_HEADERS;
    const models = await app.inject({ method: "GET", url: "/api/models", headers });
    const envelope = await app.inject({ method: "GET", url: "/api/config", headers });
    const files = await app.inject({ method: "GET", url: "/api/agent-files", headers });
    expect(models.statusCode).toBe(200);
    expect(models.json().models).toHaveLength(7);
    expect(envelope.statusCode).toBe(200);
    expect(envelope.json().revision).toMatch(/^[a-f0-9]{64}$/);
    expect(files.statusCode).toBe(200);
    expect(files.json().files).toHaveLength(12);
    expect(files.json().files).toContainEqual(expect.objectContaining({
      id: "conversation.reply",
      kind: "final",
      fileName: "conversation_reply.json",
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "user.input", description: expect.any(String) })
      ])
    }));
    await app.close();
  });

  it("tests a complete provider draft without changing disk config", async () => {
    const app = await createApp({
      config,
      initializeRuntime: false,
      testProvider: async () => ({ connected: true })
    });
    const headers = ADMIN_HEADERS;
    const before = await fs.readFile(process.env.SUNABOT_CONFIG!, "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers,
      payload: { provider: config.providers.items[0] }
    });
    const after = await fs.readFile(process.env.SUNABOT_CONFIG!, "utf8");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, connected: true, model: "gpt-5.5" });
    expect(response.json().elapsedMs).toEqual(expect.any(Number));
    expect(after).toBe(before);
    await app.close();
  });

  it("enforces auth for forwarded requests and accepts a valid bearer token", async () => {
    const app = await createApp({ config, initializeRuntime: false });
    let response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "127.0.0.1", "x-forwarded-for": "127.0.0.1" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_UNAUTHORIZED");

    response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: {
        host: "127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        authorization: "Bearer admin-secret"
      }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("reloads the config envelope from disk after an external edit", async () => {
    const app = await createApp({ config, initializeRuntime: false });
    config.server.port = 9123;
    await saveConfig(config);
    const response = await app.inject({ method: "GET", url: "/api/config", headers: ADMIN_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json().config.server.port).toBe(9123);
    await app.close();
  });

  it("creates editable default runtime prompts when the agent workspace changes", async () => {
    const app = await createApp({ config, initializeRuntime: false });
    const headers = ADMIN_HEADERS;
    const envelope = await app.inject({ method: "GET", url: "/api/config", headers });
    const nextWorkspace = path.join(temporaryDirectory, "new-agent");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/config/persona",
      headers,
      payload: {
        revision: envelope.json().revision,
        value: {
          agentWorkspace: nextWorkspace,
          memoryLimit: config.persona.memoryLimit
        }
      }
    });

    expect(response.statusCode).toBe(200);
    for (const definition of AGENT_FILE_DEFINITIONS.slice(5)) {
      const content = await fs.readFile(path.join(nextWorkspace, definition.fileName(response.json().config)), "utf8");
      expect(content.trim()).not.toBe("");
    }
    await app.close();
  });

  it.each([
    "http://localhost/image.png",
    "http://127.0.0.1/image.png",
    "http://10.1.2.3/image.png",
    "http://192.168.1.10/image.png",
    "http://[::1]/image.png"
  ])("rejects private image proxy targets: %s", async (imageUrl) => {
    const app = await createApp({ config, initializeRuntime: false });
    const response = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent(imageUrl)}`,
      headers: ADMIN_HEADERS
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "IMAGE_URL_PRIVATE", field: "url" }
    });
    await app.close();
  });

  it("loads QQ message images when the trusted CDN resolves through Clash fake IP", async () => {
    const imageUrl = "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=fixture&rkey=fixture";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" }
    }));
    const app = await createApp({ config, initializeRuntime: false });
    const response = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent(imageUrl)}`,
      headers: ADMIN_HEADERS
    });

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
    const app = await createApp({ config, initializeRuntime: false });
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

  it("loads QQ user and group avatars through the dedicated trusted proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" }
    }));
    const app = await createApp({ config, initializeRuntime: false });

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
    const built = await buildApp({ config, initializeRuntime: false });
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
      url: "/api/playground/image",
      headers: ADMIN_HEADERS,
      payload: {
        prompt: "portrait test",
        size: "1024x1536",
        resolution: "4K"
      }
    });
    const history = await built.app.inject({
      method: "GET",
      url: "/api/images",
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
