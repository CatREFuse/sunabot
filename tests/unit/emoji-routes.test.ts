// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applicationDatabasePath,
  closeApplicationDataStores,
  applicationDataStore
} from "../../adapters/sqlite/applicationDataStore.js";
import { registerEmojiRoutes } from "../../apps/api/plugins/emojiRoutes.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { currentAgentRuntimeConfig } from "../../packages/platform/runtimeAgentContext.js";
import { emojiGenerationPrompt, PRESET_EMOJI_KEYS } from "../../services/emojis/emojiCatalog.js";
import {
  EmojiGenerationGate,
  EmojiNormalizationBusyError
} from "../../services/emojis/emojiOperationGate.js";
import type { EmojiEnvelope, EmojiLibraryRepository } from "../../src/admin/emojiLibrary.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES } from "../../src/runtime/runtimeContracts.js";
import type { AppConfig, ImageResult } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-routes-"));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeApplicationDataStores();
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("emoji routes", () => {
  it("reads and updates an Agent-scoped sending size with a config revision", async () => {
    const repository = fakeRepository(envelope("开心", "a"));
    const read = vi.fn(async (agentId: string) => ({
      sendSize: 512 as const,
      sendSeparately: false,
      revision: `${agentId}-r1`
    }));
    const update = vi.fn(async (agentId: string, input: {
      sendSize: 64 | 128 | 256 | 512 | 1024;
      sendSeparately: boolean;
      revision: string;
    }) => ({
      sendSize: input.sendSize,
      sendSeparately: input.sendSeparately,
      revision: `${agentId}-r2`
    }));
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => createAdminTestConfig(root),
      runtime: {} as SunaRuntime,
      settings: { read, update }
    });

    const listed = await app.inject({ method: "GET", url: "/api/emojis?agentId=arona" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ sendSize: 512, sendSeparately: false, revision: "arona-r1" });
    expect(read).toHaveBeenCalledWith("arona");

    const changed = await app.inject({
      method: "PATCH",
      url: "/api/emojis/settings?agentId=arona",
      payload: { sendSize: 128, sendSeparately: true, revision: "arona-r1" }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ sendSize: 128, sendSeparately: true, revision: "arona-r2" });
    expect(update).toHaveBeenCalledWith("arona", {
      sendSize: 128,
      sendSeparately: true,
      revision: "arona-r1"
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/emojis/settings?agentId=arona",
      payload: { sendSize: 96, sendSeparately: true, revision: "arona-r2" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: "EMOJI_SETTINGS_INVALID", field: "sendSize" });
    expect(update).toHaveBeenCalledOnce();

    const invalidMode = await app.inject({
      method: "PATCH",
      url: "/api/emojis/settings?agentId=arona",
      payload: { sendSize: 128, sendSeparately: "yes", revision: "arona-r2" }
    });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json().error).toMatchObject({
      code: "EMOJI_SETTINGS_INVALID",
      field: "sendSeparately"
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it("isolates list, upload, content and deletion by explicit Agent ID", async () => {
    const plana = fakeRepository(envelope("认真", "a"));
    const koharu = fakeRepository(envelope("开心", "b"));
    const getRepository = vi.fn((agentId: string) => {
      if (agentId === "koharu") return koharu.repository;
      if (agentId === "plana") return plana.repository;
      throw new Error(`Unknown test Agent: ${agentId}`);
    });
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: plana.repository,
      getRepository,
      getConfig: () => createAdminTestConfig(root),
      runtime: {} as SunaRuntime
    });

    const listed = await app.inject({ method: "GET", url: "/api/emojis?agentId=koharu" });
    expect(listed.statusCode).toBe(200);
    expect(koharu.list).toHaveBeenCalledOnce();
    expect(plana.list).not.toHaveBeenCalled();
    expect(listed.json().emojis[0]).toMatchObject({
      key: "开心",
      originalUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=original&agentId=koharu&v=emoji-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png",
      displayUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=display&agentId=koharu&v=emoji-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png",
      placeholderUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=placeholder&agentId=koharu&v=emoji-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"
    });

    const uploadBody = {
      key: "害羞",
      fileName: "koharu.png",
      dataBase64: Buffer.from("test-image").toString("base64")
    };
    koharu.upload.mockResolvedValueOnce(envelope("害羞", "c"));
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/emojis?agentId=koharu",
      payload: uploadBody
    });
    expect(uploaded.statusCode).toBe(200);
    expect(koharu.upload).toHaveBeenCalledWith(uploadBody);
    expect(uploaded.json().emojis[0].displayUrl).toBe(
      "/api/emojis/%E5%AE%B3%E7%BE%9E/content?variant=display&agentId=koharu&v=emoji-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png"
    );

    const contentBytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    koharu.content.mockResolvedValueOnce({ bytes: contentBytes, contentType: "image/webp" });
    const content = await app.inject({
      method: "GET",
      url: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=display&agentId=koharu&v=emoji-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.equals(contentBytes)).toBe(true);
    expect(content.headers["content-type"]).toContain("image/webp");
    expect(content.headers["cache-control"]).toBe("private, max-age=604800, immutable");
    expect(content.headers.vary).toBe("Authorization");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(koharu.content).toHaveBeenCalledWith(
      "开心",
      "display",
      "emoji-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"
    );

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/emojis/%E5%BC%80%E5%BF%83?agentId=koharu"
    });
    expect(removed.statusCode).toBe(204);
    expect(koharu.remove).toHaveBeenCalledWith("开心");
    expect(getRepository).toHaveBeenCalledTimes(4);
    expect(getRepository).toHaveBeenNthCalledWith(1, "koharu");
    expect(getRepository).toHaveBeenNthCalledWith(4, "koharu");
  });

  it("rejects illegal keys and content variants before generation or content access", async () => {
    const repository = fakeRepository(envelope());
    const getProvider = vi.fn();
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => createAdminTestConfig(root),
      runtime: { getProvider } as unknown as SunaRuntime
    });

    const invalidKey = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "bad/key" }
    });
    expect(invalidKey.statusCode).toBe(400);
    expect(invalidKey.json()).toEqual({
      error: {
        code: "EMOJI_KEY_INVALID",
        message: "表情 key 需为 1 至 24 个字符，且不能包含括号、斜杠或控制字符。",
        field: "key"
      }
    });
    expect(getProvider).not.toHaveBeenCalled();

    const invalidVariant = await app.inject({
      method: "GET",
      url: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=giant"
    });
    expect(invalidVariant.statusCode).toBe(400);
    expect(invalidVariant.json()).toEqual({
      error: {
        code: "EMOJI_VARIANT_INVALID",
        message: "表情图片尺寸无效。",
        field: "variant"
      }
    });
    expect(repository.content).not.toHaveBeenCalled();
  });

  it("rejects isolated surrogate keys before upload repository or image provider access", async () => {
    const repository = fakeRepository(envelope());
    const generateImage = vi.fn(async () => ({ url: "/generated-images/invalid.png" }));
    const getProvider = vi.fn(() => ({
      generateImage,
      getModelInfo: () => ({ model: "test-text", imageModel: "test-image" })
    }));
    const runtime = {
      getProvider,
      loadSelfieReferenceImages: vi.fn(async () => []),
      getPersonaStatus: vi.fn(() => ({ name: "普拉娜" }))
    } as unknown as SunaRuntime;
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => createAdminTestConfig(root),
      runtime
    });
    for (const invalidKey of ["\ud800", "开\u0085心"]) {
      const upload = await app.inject({
        method: "POST",
        url: "/api/emojis",
        payload: {
          key: invalidKey,
          fileName: "invalid.png",
          dataBase64: Buffer.from("not-written").toString("base64")
        }
      });
      const generate = await app.inject({
        method: "POST",
        url: "/api/emojis/generate",
        payload: { key: invalidKey }
      });

      expect(upload.statusCode).toBeGreaterThanOrEqual(400);
      expect(upload.statusCode).toBeLessThan(500);
      expect(generate.statusCode).toBeGreaterThanOrEqual(400);
      expect(generate.statusCode).toBeLessThan(500);
      expect(upload.json().error?.code).toBe("EMOJI_KEY_INVALID");
      expect(generate.json().error?.code).toBe("EMOJI_KEY_INVALID");
    }
    expect(repository.upload).not.toHaveBeenCalled();
    expect(repository.bindGenerated).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("rejects missing or unreadable character references before provider and persistence access", async () => {
    for (const loadReferences of [
      vi.fn(async () => [] as string[]),
      vi.fn(async () => { throw new Error("reference unreadable"); })
    ]) {
      const config = createAdminTestConfig(root);
      const repository = fakeRepository(envelope());
      const getProvider = vi.fn();
      const app = testApp();
      registerEmojiRoutes(app, {
        repository: repository.repository,
        getConfig: () => config,
        runtime: {
          getProvider,
          loadSelfieReferenceImages: loadReferences,
          getPersonaStatus: vi.fn(() => ({ name: "普拉娜" }))
        } as unknown as SunaRuntime
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/emojis/generate",
        payload: { key: "开心" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "EMOJI_REFERENCE_REQUIRED", message: "请先添加角色参考图。" }
      });
      expect(loadReferences).toHaveBeenCalledOnce();
      expect(getProvider).not.toHaveBeenCalled();
      expect(repository.bindGenerated).not.toHaveBeenCalled();
      await expect(fs.access(applicationDatabasePath(config)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("returns retryable generation conflicts before provider access and releases capacity in finally", async () => {
    const config = createAdminTestConfig(root);
    const firstGeneration = deferred<ImageResult>();
    const secondGeneration = deferred<ImageResult>();
    const generateImage = vi.fn()
      .mockImplementationOnce(() => firstGeneration.promise)
      .mockImplementationOnce(() => secondGeneration.promise)
      .mockResolvedValue({ url: "/generated-images/retry.png" });
    const getProvider = vi.fn(() => ({
      generateImage,
      getModelInfo: () => ({ model: "test-text", imageModel: "test-image" })
    }));
    const loadSelfieReferenceImages = vi.fn(async () => [path.join(root, "reference.png")]);
    const repository = fakeRepository(envelope());
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => config,
      runtime: {
        getProvider,
        loadSelfieReferenceImages,
        getPersonaStatus: vi.fn(() => ({ name: "普拉娜" }))
      } as unknown as SunaRuntime,
      generationGate: new EmojiGenerationGate(2)
    });

    const firstRequest = app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "开心" }
    });
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "开心" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.headers["retry-after"]).toBe("2");
    expect(duplicate.json()).toEqual({
      error: {
        code: "EMOJI_GENERATION_IN_PROGRESS",
        message: "该表情正在生成，请稍后重试。"
      }
    });
    expect(generateImage).toHaveBeenCalledTimes(1);

    const secondRequest = app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "哭" }
    });
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));

    const capacity = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "认真" }
    });
    expect(capacity.statusCode).toBe(429);
    expect(capacity.headers["retry-after"]).toBe("2");
    expect(capacity.json()).toEqual({
      error: {
        code: "EMOJI_GENERATION_BUSY",
        message: "表情生成任务较多，请稍后重试。"
      }
    });
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(loadSelfieReferenceImages).toHaveBeenCalledTimes(2);
    expect(repository.bindGenerated).not.toHaveBeenCalled();

    firstGeneration.resolve({ url: "/generated-images/first.png" });
    secondGeneration.resolve({ url: "/generated-images/second.png" });
    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);

    const retry = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "开心" }
    });
    expect(retry.statusCode).toBe(200);
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(repository.bindGenerated).toHaveBeenCalledTimes(3);
  });

  it("isolates generation capacity by Agent", async () => {
    const koharuGeneration = deferred<ImageResult>();
    const koharuConfig = agentConfig(path.join(root, "agents", "koharu"), "koharu", "小春", "low");
    const planaConfig = createAdminTestConfig(path.join(root, "plana"));
    const koharuGenerateImage = vi.fn(() => koharuGeneration.promise);
    const planaGenerateImage = vi.fn(async () => ({ url: "/generated-images/plana.png" }));
    const koharuRuntime = generationRuntime(koharuGenerateImage, "小春", path.join(root, "koharu-reference.png"));
    const planaRuntime = generationRuntime(planaGenerateImage, "普拉娜", path.join(root, "plana-reference.png"));
    const koharu = fakeRepository(envelope());
    const plana = fakeRepository(envelope());
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: plana.repository,
      getRepository: (agentId) => agentId === "koharu" ? koharu.repository : plana.repository,
      getConfig: () => planaConfig,
      runtime: planaRuntime,
      getAgentContext: (agentId) => agentId === "koharu"
        ? { config: koharuConfig, runtime: koharuRuntime }
        : { config: planaConfig, runtime: planaRuntime },
      generationGate: new EmojiGenerationGate(1)
    });

    const koharuRequest = app.inject({
      method: "POST",
      url: "/api/emojis/generate?agentId=koharu",
      payload: { key: "开心" }
    });
    await vi.waitFor(() => expect(koharuGenerateImage).toHaveBeenCalledOnce());

    const planaResponse = await app.inject({
      method: "POST",
      url: "/api/emojis/generate?agentId=plana",
      payload: { key: "开心" }
    });
    expect(planaResponse.statusCode).toBe(200);
    expect(planaGenerateImage).toHaveBeenCalledOnce();
    expect(plana.bindGenerated).toHaveBeenCalledOnce();

    koharuGeneration.resolve({ url: "/generated-images/koharu.png" });
    expect((await koharuRequest).statusCode).toBe(200);
    expect(koharu.bindGenerated).toHaveBeenCalledOnce();
  });

  it("maps normalization capacity to retryable 429 for upload and generated binding", async () => {
    const config = createAdminTestConfig(root);
    const repository = fakeRepository(envelope());
    repository.upload.mockRejectedValueOnce(new EmojiNormalizationBusyError());
    repository.bindGenerated.mockRejectedValueOnce(new EmojiNormalizationBusyError());
    const generateImage = vi.fn(async () => ({ url: "/generated-images/busy.png" }));
    const runtime = {
      getProvider: vi.fn(() => ({
        generateImage,
        getModelInfo: () => ({ model: "test-text", imageModel: "test-image" })
      })),
      loadSelfieReferenceImages: vi.fn(async () => [path.join(root, "reference.png")]),
      getPersonaStatus: vi.fn(() => ({ name: "普拉娜" }))
    } as unknown as SunaRuntime;
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => config,
      runtime
    });

    const upload = await app.inject({
      method: "POST",
      url: "/api/emojis",
      payload: { key: "开心", fileName: "bad.png", dataBase64: "%%%%" }
    });
    expect(upload.statusCode).toBe(429);
    expect(upload.headers["retry-after"]).toBe("2");
    expect(upload.json()).toEqual({
      error: { code: "EMOJI_NORMALIZATION_BUSY", message: "表情处理任务较多，请稍后重试。" }
    });

    const generated = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "开心" }
    });
    expect(generated.statusCode).toBe(429);
    expect(generated.headers["retry-after"]).toBe("2");
    expect(generated.json()).toEqual({
      error: { code: "EMOJI_NORMALIZATION_BUSY", message: "表情处理任务较多，请稍后重试。" }
    });
    expect(applicationDataStore(config).readImageHistory()).toEqual([]);

    repository.bindGenerated.mockResolvedValueOnce(envelope("开心", "e", "generated"));
    const retry = await app.inject({
      method: "POST",
      url: "/api/emojis/generate",
      payload: { key: "开心" }
    });
    expect(retry.statusCode).toBe(200);
    expect(generateImage).toHaveBeenCalledTimes(2);
  });

  it("changes content URL versions on replacement and refuses stale versions without returning current bytes", async () => {
    const firstFileName = `emoji-${"1".repeat(64)}.png`;
    const currentFileName = `emoji-${"2".repeat(64)}.png`;
    const repository = fakeRepository(envelope("认真", "1"));
    repository.list
      .mockResolvedValueOnce(envelope("认真", "1"))
      .mockResolvedValueOnce(envelope("认真", "2"));
    const currentBytes = Buffer.from("current-emoji-bytes");
    repository.content.mockImplementation(async (_key, _variant, expectedFileName?: string) => {
      if (expectedFileName !== currentFileName) {
        throw new ServiceError(409, "EMOJI_CONTENT_VERSION_MISMATCH", "表情图片版本已更新。");
      }
      return { bytes: currentBytes, contentType: "image/png" as const };
    });
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: repository.repository,
      getConfig: () => createAdminTestConfig(root),
      runtime: {} as SunaRuntime
    });

    const before = (await app.inject({ method: "GET", url: "/api/emojis?agentId=plana" })).json();
    const after = (await app.inject({ method: "GET", url: "/api/emojis?agentId=plana" })).json();
    expect(before.emojis[0].displayUrl).toContain(`&v=${firstFileName}`);
    expect(after.emojis[0].displayUrl).toContain(`&v=${currentFileName}`);
    expect(after.emojis[0].displayUrl).not.toBe(before.emojis[0].displayUrl);

    const current = await app.inject({ method: "GET", url: after.emojis[0].originalUrl });
    expect(current.statusCode).toBe(200);
    expect(current.rawPayload.equals(currentBytes)).toBe(true);
    expect(repository.content).toHaveBeenLastCalledWith("认真", "original", currentFileName);

    const stale = await app.inject({ method: "GET", url: before.emojis[0].originalUrl });
    expect([404, 409]).toContain(stale.statusCode);
    expect(stale.rawPayload.equals(currentBytes)).toBe(false);
    expect(repository.content).toHaveBeenLastCalledWith("认真", "original", firstFileName);
  });

  it("generates at 1024 square with the selected Agent runtime, references and quality, then binds the key", async () => {
    const defaultConfig = createAdminTestConfig(path.join(root, "plana"));
    const koharuConfig = agentConfig(path.join(root, "agents", "koharu"), "koharu", "小春", "low");
    const generated: ImageResult = {
      url: "/generated-images/koharu-happy.png",
      filePath: path.join(root, "agents", "koharu", "generated-images", "koharu-happy.png"),
      revisedPrompt: "小春开心表情"
    };
    const references = Array.from(
      { length: MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES },
      (_, index) => path.join(root, "agents", "koharu", "selfie", `reference-${index}.png`)
    );
    let activeAgentId: string | undefined;
    const generateImage = vi.fn(async () => {
      activeAgentId = currentAgentRuntimeConfig()?.persona.defaultAgentId;
      return generated;
    });
    const provider = {
      generateImage,
      getModelInfo: () => ({ model: "koharu-text", imageModel: "koharu-image-model" })
    };
    const koharuRuntime = {
      getProvider: vi.fn(() => provider),
      loadSelfieReferenceImages: vi.fn(async () => references),
      getPersonaStatus: vi.fn(() => ({ name: "小春" }))
    } as unknown as SunaRuntime;
    const defaultRuntime = {
      getProvider: vi.fn(() => {
        throw new Error("default runtime must not be used");
      })
    } as unknown as SunaRuntime;
    const plana = fakeRepository(envelope());
    const koharu = fakeRepository(envelope());
    koharu.bindGenerated.mockResolvedValueOnce(envelope("开心", "d", "generated"));
    const getRepository = vi.fn((agentId: string) => agentId === "koharu" ? koharu.repository : plana.repository);
    const getAgentContext = vi.fn((agentId: string) => {
      if (agentId !== "koharu") throw new Error(`Unexpected Agent: ${agentId}`);
      return { config: koharuConfig, runtime: koharuRuntime };
    });
    const app = testApp();
    registerEmojiRoutes(app, {
      repository: plana.repository,
      getRepository,
      getConfig: () => defaultConfig,
      runtime: defaultRuntime,
      getAgentContext
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/emojis/generate?agentId=koharu",
      payload: { key: "开心", providerId: "koharu-provider" }
    });
    expect(response.statusCode).toBe(200);
    const prompt = emojiGenerationPrompt("开心", "小春");
    expect(koharuRuntime.getProvider).toHaveBeenCalledWith("koharu-provider");
    expect(koharuRuntime.loadSelfieReferenceImages).toHaveBeenCalledOnce();
    expect(koharuRuntime.getPersonaStatus).toHaveBeenCalledOnce();
    expect(generateImage).toHaveBeenCalledWith(
      prompt,
      "1024x1024",
      "low",
      references,
      { stage: "emoji_generation", promptFamily: "image.emoji" }
    );
    expect(activeAgentId).toBe("koharu");
    expect(koharu.bindGenerated).toHaveBeenCalledWith("开心", generated);
    expect(getRepository).toHaveBeenCalledWith("koharu");
    expect(getAgentContext).toHaveBeenCalledWith("koharu");
    expect(response.json().emojis[0]).toMatchObject({
      key: "开心",
      source: "generated",
      displayUrl: "/api/emojis/%E5%BC%80%E5%BF%83/content?variant=display&agentId=koharu&v=emoji-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png"
    });
    expect(applicationDataStore(koharuConfig).readImageHistory()[0]).toMatchObject({
      id: "koharu-happy.png",
      prompt,
      size: "1024x1024",
      resolution: "1K",
      model: "koharu-image-model"
    });
  });
});

function testApp() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ServiceError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    throw error;
  });
  return app;
}

function fakeRepository(initial: EmojiEnvelope) {
  const list = vi.fn(async () => initial);
  const upload = vi.fn(async () => initial);
  const bindGenerated = vi.fn(async () => initial);
  const content = vi.fn(async () => ({ bytes: Buffer.from([1]), contentType: "image/png" as const }));
  const remove = vi.fn(async () => undefined);
  return {
    list,
    upload,
    bindGenerated,
    content,
    remove,
    repository: { list, upload, bindGenerated, content, remove } as unknown as EmojiLibraryRepository
  };
}

function envelope(key?: string, hashSeed = "a", source: "upload" | "generated" = "upload"): EmojiEnvelope {
  return {
    presetKeys: PRESET_EMOJI_KEYS,
    emojis: key ? [{
      key,
      fileName: `emoji-${hashSeed.repeat(64)}.png`,
      source,
      sizeBytes: 1_024,
      width: 1_024,
      height: 1_024,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    }] : []
  };
}

function agentConfig(
  workspace: string,
  agentId: string,
  name: string,
  quality: AppConfig["bot"]["tools"]["generateImg"]["quality"]
) {
  const config = createAdminTestConfig(path.dirname(workspace));
  return {
    ...config,
    persona: {
      ...config.persona,
      defaultAgentId: agentId,
      name,
      agentWorkspace: workspace
    },
    bot: {
      ...config.bot,
      tools: {
        ...config.bot.tools,
        generateImg: {
          ...config.bot.tools.generateImg,
          quality
        }
      }
    }
  } satisfies AppConfig;
}

function generationRuntime(
  generateImage: ReturnType<typeof vi.fn>,
  personaName: string,
  referencePath: string
) {
  return {
    getProvider: vi.fn(() => ({
      generateImage,
      getModelInfo: () => ({ model: "test-text", imageModel: "test-image" })
    })),
    loadSelfieReferenceImages: vi.fn(async () => [referencePath]),
    getPersonaStatus: vi.fn(() => ({ name: personaName }))
  } as unknown as SunaRuntime;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
