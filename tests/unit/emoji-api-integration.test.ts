// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { AppConfig } from "../../src/types.js";

const PASSWORD = "correct-horse-battery-staple";
const LOGIN_HEADERS = {
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:8787"
};
const AGENT_IDS = [
  "plana",
  "agent-b",
  "replace-agent",
  "invalid-agent",
  "limit-agent",
  "link-agent",
  "content-agent",
  "poison-agent",
  "external-agent",
  "zero-reference-agent",
  "unreadable-reference-agent"
] as const;

let app: FastifyInstance;
let root = "";
let previousWorkspace: string | undefined;
let cookie = "";
let csrf = "";
let redPng = Buffer.alloc(0);
let bluePng = Buffer.alloc(0);
let greenPng = Buffer.alloc(0);
let redJpeg = Buffer.alloc(0);
let configs = new Map<string, AppConfig>();
let runtimes = new Map<string, SunaRuntime>();
let generatedCalls = new Map<string, ReturnType<typeof vi.fn>>();
let applicationDataStore: (config?: Pick<AppConfig, "persona">) => ApplicationDataStore;
let applicationDatabasePath: (config?: Pick<AppConfig, "persona">) => string;
let closeApplicationDataStores: () => void;

beforeAll(async () => {
  previousWorkspace = process.env.SUNABOT_WORKSPACE;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-api-")));
  process.env.SUNABOT_WORKSPACE = root;
  vi.resetModules();

  const [
    fastifyModule,
    sharpModule,
    fixturesModule,
    authModule,
    authRoutesModule,
    emojiCompositionModule,
    storeModule,
    serviceErrorModule
  ] = await Promise.all([
    import("fastify"),
    import("sharp"),
    import("./admin-fixtures.js"),
    import("../../src/admin/auth.js"),
    import("../../apps/api/plugins/authRoutes.js"),
    import("../../apps/api/emojiApiComposition.js"),
    import("../../adapters/sqlite/applicationDataStore.js"),
    import("../../packages/contracts/errors/serviceError.js")
  ]);
  applicationDataStore = storeModule.applicationDataStore;
  applicationDatabasePath = storeModule.applicationDatabasePath;
  closeApplicationDataStores = storeModule.closeApplicationDataStores;

  const sharp = sharpModule.default;
  [redPng, bluePng, greenPng] = await Promise.all([
    solidPng(sharp, { r: 220, g: 40, b: 40 }),
    solidPng(sharp, { r: 40, g: 70, b: 220 }),
    solidPng(sharp, { r: 30, g: 180, b: 80 })
  ]);
  redJpeg = await sharp(redPng).jpeg().toBuffer();

  for (const agentId of AGENT_IDS) {
    const config = fixturesModule.createAdminTestConfig(root);
    config.persona.defaultAgentId = agentId;
    config.persona.name = `Test ${agentId}`;
    config.persona.agentWorkspace = path.join(root, "business", "agents", agentId);
    config.persona.systemPromptWorkspace = path.join(root, "business", "system-prompts");
    configs.set(agentId, config);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    runtimes.set(agentId, fakeRuntime(config, agentId));
  }

  const credentialsPath = path.join(root, "secrets", "admin-credentials.json");
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  const timestamp = new Date().toISOString();
  await fs.writeFile(credentialsPath, JSON.stringify({
    version: 1,
    username: "admin",
    password: await authModule.hashAdminPassword(PASSWORD),
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const adminAuth = await authModule.AdminAuthService.create({
    credentialsPath,
    fusePath: path.join(root, "secrets", "ADMIN_DISABLED.json")
  });

  app = fastifyModule.default({ logger: false });
  const ServiceErrorConstructor = serviceErrorModule.ServiceError;
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ServiceErrorConstructor) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务器处理请求失败。" }
    });
  });
  authRoutesModule.registerAuthRoutes(app, adminAuth);
  const defaultRuntime = requireRuntime("plana");
  emojiCompositionModule.registerAgentEmojiApi(app, {
    getConfig: () => requireConfig("plana"),
    runtime: defaultRuntime,
    getRuntime: (agentId: string) => {
      if (agentId === "disabled-agent") throw new Error("Agent is disabled: disabled-agent");
      if (agentId === "not-ready-agent") throw new Error("Agent runtime is not available: not-ready-agent");
      return requireRuntime(agentId);
    },
    configService: {
      readEnvelope: async () => ({ config: requireConfig("plana"), revision: "plana-r1" }),
      patch: vi.fn()
    },
    agentConfigService: {
      readEnvelope: async (agentId: string) => ({ config: requireConfig(agentId), revision: `${agentId}-r1` }),
      patch: vi.fn()
    }
  });
  app.addHook("onClose", async () => closeApplicationDataStores());

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: LOGIN_HEADERS,
    payload: { username: "admin", password: PASSWORD }
  });
  expect(login.statusCode).toBe(200);
  const setCookie = Array.isArray(login.headers["set-cookie"])
    ? login.headers["set-cookie"][0]
    : login.headers["set-cookie"];
  cookie = String(setCookie).split(";", 1)[0] ?? "";
  csrf = String(login.json().csrfToken);
}, 30_000);

afterAll(async () => {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
  if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
  else process.env.SUNABOT_WORKSPACE = previousWorkspace;
});

describe("emoji production repository and Fastify routes", () => {
  it("enforces admin authentication and CSRF before repository mutations", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/api/emojis?agentId=plana" });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/emojis?agentId=plana",
      headers: readHeaders()
    });
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/emojis?agentId=plana",
      headers: { host: LOGIN_HEADERS.host, origin: LOGIN_HEADERS.origin, cookie },
      payload: uploadPayload("开心", "red.png", redPng)
    });
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/emojis?agentId=plana",
      headers: { ...mutationHeaders(), origin: "https://untrusted.example.test" },
      payload: uploadPayload("开心", "red.png", redPng)
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ error: { code: "ADMIN_UNAUTHORIZED" } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().emojis).toEqual([]);
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "ADMIN_CSRF_INVALID" } });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ error: { code: "ADMIN_ORIGIN_REJECTED" } });
    expect(applicationDataStore(requireConfig("plana")).readEmojis()).toEqual([]);
  });

  it("isolates Agent databases, media paths and content bytes", async () => {
    const plana = await upload("plana", "开心", "plana.png", redPng);
    const agentB = await upload("agent-b", "开心", "agent-b.png", bluePng);
    const planaRecord = findEmoji(plana, "开心");
    const agentBRecord = findEmoji(agentB, "开心");

    expect(planaRecord.fileName).not.toBe(agentBRecord.fileName);
    expect(applicationDatabasePath(requireConfig("plana"))).toBe(path.join(root, "business", "data", "sunabot.sqlite"));
    expect(applicationDatabasePath(requireConfig("agent-b")))
      .toBe(path.join(root, "business", "agents", "agent-b", "data", "sunabot.sqlite"));
    await expect(fs.access(path.join(root, "business", "media", "images", planaRecord.fileName))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "business", "media", "images", "agents", "agent-b", agentBRecord.fileName)))
      .resolves.toBeUndefined();

    const [planaContent, agentBContent] = await Promise.all([
      app.inject({ method: "GET", url: planaRecord.originalUrl, headers: readHeaders() }),
      app.inject({ method: "GET", url: agentBRecord.originalUrl, headers: readHeaders() })
    ]);
    expect(planaContent.statusCode).toBe(200);
    expect(agentBContent.statusCode).toBe(200);
    expect(planaContent.headers["content-type"]).toContain("image/png");
    expect(planaContent.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(agentBContent.rawPayload).not.toEqual(planaContent.rawPayload);
    expect((await list("plana")).emojis.map((item: { key: string }) => item.key)).toEqual(["开心"]);
    expect((await list("agent-b")).emojis.map((item: { key: string }) => item.key)).toEqual(["开心"]);
  });

  it("lists and deletes old versions, renames keys, rejects stale current URLs and binds generated images", async () => {
    const first = findEmoji(await upload("replace-agent", "开心", "red.png", redPng), "开心");
    const second = findEmoji(await upload("replace-agent", "开心", "blue.png", bluePng), "开心");
    expect(second.fileName).not.toBe(first.fileName);
    expect(second.originalUrl).not.toBe(first.originalUrl);

    const stale = await app.inject({ method: "GET", url: first.originalUrl, headers: readHeaders() });
    const current = await app.inject({ method: "GET", url: second.originalUrl, headers: readHeaders() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "EMOJI_CONTENT_VERSION_MISMATCH" } });
    expect(current.statusCode).toBe(200);

    const versions = await app.inject({
      method: "GET",
      url: `/api/emojis/${encodeURIComponent("开心")}/versions?agentId=replace-agent`,
      headers: readHeaders()
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().versions).toEqual([
      expect.objectContaining({ fileName: second.fileName, current: true }),
      expect.objectContaining({ fileName: first.fileName, current: false })
    ]);
    const oldVersion = versions.json().versions[1];
    const oldContent = await app.inject({ method: "GET", url: oldVersion.originalUrl, headers: readHeaders() });
    expect(oldContent.statusCode).toBe(200);

    const deleteCurrent = await app.inject({
      method: "DELETE",
      url: `/api/emojis/${encodeURIComponent("开心")}/versions/${encodeURIComponent(second.fileName)}?agentId=replace-agent`,
      headers: mutationHeaders()
    });
    expect(deleteCurrent.statusCode).toBe(409);
    expect(deleteCurrent.json()).toMatchObject({ error: { code: "EMOJI_VERSION_CURRENT" } });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/emojis/${encodeURIComponent("开心")}?agentId=replace-agent`,
      headers: mutationHeaders(),
      payload: { key: "大笑" }
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(findEmoji(renamed.json(), "大笑")).toMatchObject({ fileName: second.fileName });
    expect(applicationDataStore(requireConfig("replace-agent")).readEmojiVersions("大笑")).toHaveLength(2);

    const deletedOld = await app.inject({
      method: "DELETE",
      url: `/api/emojis/${encodeURIComponent("大笑")}/versions/${encodeURIComponent(first.fileName)}?agentId=replace-agent`,
      headers: mutationHeaders()
    });
    expect(deletedOld.statusCode).toBe(204);
    expect(applicationDataStore(requireConfig("replace-agent")).readEmojiVersions("大笑"))
      .toEqual([expect.objectContaining({ fileName: second.fileName, current: true })]);

    const generated = await app.inject({
      method: "POST",
      url: "/api/emojis/generate?agentId=replace-agent",
      headers: mutationHeaders(),
      payload: { key: "哭" }
    });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(findEmoji(generated.json(), "哭")).toMatchObject({ source: "generated", width: 1024, height: 1024 });
    expect(generatedCalls.get("replace-agent")).toHaveBeenCalledWith(
      expect.stringContaining("Test replace-agent"),
      "1024x1024",
      "high",
      [referencePath("replace-agent")],
      expect.objectContaining({ stage: "emoji_generation", promptFamily: "image.emoji" })
    );
    expect(applicationDataStore(requireConfig("replace-agent")).readImageHistory()[0])
      .toMatchObject({ model: "test-image-model", size: "1024x1024", resolution: "1K" });
  });

  it("rejects invalid keys, names, Base64, image data and oversized payloads before disk writes", async () => {
    const agentId = "invalid-agent";
    const cases = [
      { payload: uploadPayload("\ud800", "bad.png", redPng), status: 400, code: "EMOJI_KEY_INVALID" },
      { payload: uploadPayload("开\u0085心", "bad.png", redPng), status: 400, code: "EMOJI_KEY_INVALID" },
      { payload: uploadPayload("\t开心", "bad.png", redPng), status: 400, code: "EMOJI_KEY_INVALID" },
      { payload: uploadPayload("开心\n", "bad.png", redPng), status: 400, code: "EMOJI_KEY_INVALID" },
      { payload: uploadPayload("坏/键", "bad.png", redPng), status: 400, code: "EMOJI_KEY_INVALID" },
      { payload: uploadPayload("坏名", "../bad.png", redPng), status: 400, code: "EMOJI_UPLOAD_INVALID" },
      { payload: uploadPayload("坏扩展", "bad.gif", redPng), status: 415, code: "EMOJI_IMAGE_UNSUPPORTED" },
      { payload: uploadPayload("错格式", "bad.png", redJpeg), status: 415, code: "EMOJI_IMAGE_UNSUPPORTED" },
      { payload: { key: "坏数据", fileName: "bad.png", dataBase64: "%%%%" }, status: 400, code: "EMOJI_BASE64_INVALID" },
      { payload: uploadPayload("坏图片", "bad.png", Buffer.from("not an image")), status: 415, code: "EMOJI_IMAGE_UNSUPPORTED" },
      {
        payload: { key: "太大", fileName: "large.png", dataBase64: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) },
        status: 413,
        code: "EMOJI_IMAGE_TOO_LARGE"
      }
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/api/emojis?agentId=${agentId}`,
        headers: mutationHeaders(),
        payload: testCase.payload
      });
      expect(response.statusCode, testCase.code).toBe(testCase.status);
      expect(response.json(), testCase.code).toMatchObject({ error: { code: testCase.code } });
    }

    await expect(fs.access(applicationDatabasePath(requireConfig(agentId))))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(agentMediaDirectory(agentId))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("enforces the 64-key limit while allowing an explicit same-key replacement", async () => {
    const agentId = "limit-agent";
    const first = findEmoji(await upload(agentId, "表情0", "first.png", redPng), "表情0");
    const store = applicationDataStore(requireConfig(agentId));
    for (let index = 1; index < 64; index += 1) {
      store.upsertEmoji({
        key: `表情${index}`,
        fileName: first.fileName,
        source: "upload",
        sizeBytes: first.sizeBytes,
        width: first.width,
        height: first.height,
        createdAt: first.createdAt,
        updatedAt: new Date(Date.now() + index).toISOString()
      });
    }
    expect(store.readEmojis()).toHaveLength(64);
    const filesBefore = await sortedFiles(agentMediaDirectory(agentId));
    const rejected = await app.inject({
      method: "POST",
      url: `/api/emojis?agentId=${agentId}`,
      headers: mutationHeaders(),
      payload: uploadPayload("第65个", "blue.png", bluePng)
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: "EMOJI_LIMIT_REACHED" } });
    expect(store.readEmojis()).toHaveLength(64);
    expect(await sortedFiles(agentMediaDirectory(agentId))).toEqual(filesBefore);

    const replaced = await upload(agentId, "表情0", "blue.png", bluePng);
    expect(findEmoji(replaced, "表情0").fileName).not.toBe(first.fileName);
    expect(store.readEmojis()).toHaveLength(64);
  });

  it("fails closed for symlink directories, symlink files, oversized files and undecodable content", async () => {
    const external = path.join(root, "external-media");
    const linkedDirectory = agentMediaDirectory("link-agent");
    await fs.mkdir(path.dirname(linkedDirectory), { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.symlink(external, linkedDirectory, "dir");
    const linkedUpload = await app.inject({
      method: "POST",
      url: "/api/emojis?agentId=link-agent",
      headers: mutationHeaders(),
      payload: uploadPayload("开心", "red.png", redPng)
    });
    expect(linkedUpload.statusCode).toBe(500);
    expect(linkedUpload.json()).toMatchObject({ error: { code: "EMOJI_PATH_INVALID" } });
    expect(applicationDataStore(requireConfig("link-agent")).readEmojis()).toEqual([]);
    expect(await fs.readdir(external)).toEqual([]);

    const contentAgent = "content-agent";
    const contentDirectory = agentMediaDirectory(contentAgent);
    await fs.mkdir(contentDirectory, { recursive: true });
    const target = path.join(root, "target.png");
    await fs.writeFile(target, redPng);
    const linkName = emojiFileName("a");
    await fs.symlink(target, path.join(contentDirectory, linkName));
    const contentStore = applicationDataStore(requireConfig(contentAgent));
    contentStore.upsertEmoji(emojiRecord("链接", linkName, redPng.byteLength));
    const linkedContent = await content("链接", contentAgent, linkName, "original");
    expect(linkedContent.statusCode).toBe(415);
    expect(linkedContent.json()).toMatchObject({ error: { code: "EMOJI_IMAGE_INVALID" } });

    const oversizedName = emojiFileName("b");
    const oversizedPath = path.join(contentDirectory, oversizedName);
    await fs.writeFile(oversizedPath, Buffer.from([0]));
    await fs.truncate(oversizedPath, 16 * 1024 * 1024 + 1);
    contentStore.upsertEmoji(emojiRecord("过大", oversizedName, 16 * 1024 * 1024 + 1));
    const oversized = await content("过大", contentAgent, oversizedName, "original");
    expect(oversized.statusCode).toBe(415);
    expect(oversized.json()).toMatchObject({ error: { code: "EMOJI_IMAGE_INVALID" } });

    const invalidName = emojiFileName("c");
    const invalidBytes = Buffer.from("not an image");
    await fs.writeFile(path.join(contentDirectory, invalidName), invalidBytes);
    contentStore.upsertEmoji(emojiRecord("损坏", invalidName, invalidBytes.byteLength));
    const invalid = await content("损坏", contentAgent, invalidName, "original");
    expect(invalid.statusCode).toBe(415);
    expect(invalid.json()).toMatchObject({ error: { code: "EMOJI_IMAGE_INVALID" } });

    const sharp = (await import("sharp")).default;
    const [sameSizeA, sameSizeB] = await Promise.all([
      sharp({
        create: { width: 1024, height: 1024, channels: 3, background: { r: 220, g: 40, b: 40 } }
      }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer(),
      sharp({
        create: { width: 1024, height: 1024, channels: 3, background: { r: 40, g: 70, b: 220 } }
      }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer()
    ]);
    expect(sameSizeB).toHaveLength(sameSizeA.length);
    const sameSizeAName = `emoji-${crypto.createHash("sha256").update(sameSizeA).digest("hex")}.png`;
    const sameSizeBName = `emoji-${crypto.createHash("sha256").update(sameSizeB).digest("hex")}.png`;
    await Promise.all([
      fs.writeFile(path.join(contentDirectory, sameSizeAName), sameSizeB),
      fs.writeFile(path.join(contentDirectory, sameSizeBName), sameSizeA)
    ]);
    contentStore.upsertEmoji(emojiRecord("换位甲", sameSizeAName, sameSizeA.length));
    contentStore.upsertEmoji(emojiRecord("换位乙", sameSizeBName, sameSizeB.length));
    const swappedList = await list(contentAgent);
    expect(swappedList.emojis.map((item: { key: string }) => item.key)).not.toContain("换位甲");
    expect(swappedList.emojis.map((item: { key: string }) => item.key)).not.toContain("换位乙");
    for (const [key, fileName] of [["换位甲", sameSizeAName], ["换位乙", sameSizeBName]]) {
      const swapped = await content(key, contentAgent, fileName, "original");
      expect(swapped.statusCode).toBe(415);
      expect(swapped.json()).toMatchObject({ error: { code: "EMOJI_IMAGE_INVALID" } });
    }

    const traversal = await app.inject({
      method: "GET",
      url: `/api/emojis/${encodeURIComponent("损坏")}/content?variant=original&agentId=${contentAgent}&v=../bad.png`,
      headers: readHeaders()
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toMatchObject({ error: { code: "EMOJI_CONTENT_VERSION_INVALID" } });
  });

  it("hides poisoned SQLite keys and rejects disabled or not-ready Agent contexts", async () => {
    const poisonConfig = requireConfig("poison-agent");
    applicationDataStore(poisonConfig);
    const database = new DatabaseSync(applicationDatabasePath(poisonConfig));
    const insertPoisoned = database.prepare(`
      INSERT INTO emojis (
        emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPoisoned.run(
      "\ud800",
      emojiFileName("d"),
      "upload",
      128,
      1024,
      1024,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );
    insertPoisoned.run(
      "开\u0085心",
      emojiFileName("e"),
      "upload",
      128,
      1024,
      1024,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );
    database.close();
    const listed = await list("poison-agent");
    expect(listed.emojis).toEqual([]);

    for (const agentId of ["disabled-agent", "not-ready-agent"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/emojis?agentId=${agentId}`,
        headers: readHeaders()
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "EMOJI_AGENT_UNAVAILABLE", message: "Agent 尚未就绪。" }
      });
    }
  });

  it("rejects generated images outside the current Agent media directory without a mapping write", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/emojis/generate?agentId=external-agent",
      headers: mutationHeaders(),
      payload: { key: "认真" }
    });
    expect(response.statusCode, response.body).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "EMOJI_GENERATION_UNAVAILABLE" } });
    expect(applicationDataStore(requireConfig("external-agent")).readEmojis()).toEqual([]);
  });

  it("rejects missing or unreadable Agent references before provider, database, and media writes", async () => {
    for (const agentId of ["zero-reference-agent", "unreadable-reference-agent"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/emojis/generate?agentId=${agentId}`,
        headers: mutationHeaders(),
        payload: { key: "开心" }
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "EMOJI_REFERENCE_REQUIRED" } });
      expect(generatedCalls.get(agentId)).not.toHaveBeenCalled();
      await expect(fs.access(applicationDatabasePath(requireConfig(agentId))))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(agentMediaDirectory(agentId))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

function fakeRuntime(config: AppConfig, agentId: string) {
  const generateImage = vi.fn(async () => {
    const outputPath = agentId === "external-agent"
      ? path.join(root, "outside-generated.png")
      : path.join(agentMediaDirectory(agentId), `provider-${agentId}.png`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, greenPng);
    return {
      url: `/generated-images/provider-${agentId}.png`,
      filePath: outputPath
    };
  });
  generatedCalls.set(agentId, generateImage);
  return {
    config,
    getProvider: () => ({
      generateImage,
      getModelInfo: () => ({ model: "test-model", imageModel: "test-image-model" })
    }),
    loadSelfieReferenceImages: async () => {
      if (agentId === "zero-reference-agent") return [];
      if (agentId === "unreadable-reference-agent") throw new Error("reference unreadable");
      const filePath = referencePath(agentId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, greenPng);
      return [filePath];
    },
    getPersonaStatus: () => ({ name: config.persona.name })
  } as unknown as SunaRuntime;
}

function requireConfig(agentId: string) {
  const config = configs.get(agentId);
  if (!config) throw new Error(`Missing test config: ${agentId}`);
  return config;
}

function requireRuntime(agentId: string) {
  const runtime = runtimes.get(agentId);
  if (!runtime) throw new Error(`Missing test runtime: ${agentId}`);
  return runtime;
}

function readHeaders() {
  return { host: LOGIN_HEADERS.host, cookie };
}

function mutationHeaders() {
  return { ...readHeaders(), origin: LOGIN_HEADERS.origin, "x-sunabot-csrf": csrf };
}

function uploadPayload(key: string, fileName: string, bytes: Buffer) {
  return { key, fileName, dataBase64: bytes.toString("base64") };
}

async function upload(agentId: string, key: string, fileName: string, bytes: Buffer) {
  const response = await app.inject({
    method: "POST",
    url: `/api/emojis?agentId=${agentId}`,
    headers: mutationHeaders(),
    payload: uploadPayload(key, fileName, bytes)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function list(agentId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/emojis?agentId=${agentId}`,
    headers: readHeaders()
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function content(key: string, agentId: string, fileName: string, variant: string) {
  return app.inject({
    method: "GET",
    url: `/api/emojis/${encodeURIComponent(key)}/content?variant=${variant}&agentId=${agentId}&v=${fileName}`,
    headers: readHeaders()
  });
}

function findEmoji(envelope: { emojis: Array<Record<string, unknown>> }, key: string) {
  const record = envelope.emojis.find((emoji) => emoji.key === key);
  if (!record) throw new Error(`Missing emoji: ${key}`);
  return record as {
    key: string;
    fileName: string;
    source: string;
    sizeBytes: number;
    width: number;
    height: number;
    createdAt: string;
    updatedAt: string;
    originalUrl: string;
    displayUrl: string;
    placeholderUrl: string;
  };
}

function agentMediaDirectory(agentId: string) {
  return path.join(root, "business", "media", "images", "agents", agentId);
}

function referencePath(agentId: string) {
  return path.join(root, "references", `${agentId}.png`);
}

async function sortedFiles(directory: string) {
  return (await fs.readdir(directory)).sort();
}

function emojiFileName(seed: string) {
  return `emoji-${seed.repeat(64)}.png`;
}

function emojiRecord(key: string, fileName: string, sizeBytes: number) {
  return {
    key,
    fileName,
    source: "upload" as const,
    sizeBytes,
    width: 1024,
    height: 1024,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z"
  };
}

async function solidPng(
  sharp: typeof import("sharp")["default"],
  background: { r: number; g: number; b: number }
) {
  return sharp({
    create: { width: 24, height: 32, channels: 3, background }
  }).png().toBuffer();
}
