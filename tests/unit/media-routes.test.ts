// @vitest-environment node
import path from "node:path";
import Fastify, { type FastifySchema } from "fastify";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMediaRoutes } from "../../apps/api/plugins/mediaRoutes.js";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { defaultConfig } from "../../src/config.js";
import type { SunaRuntime } from "../../src/runtime.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeApplicationDataStores();
});

describe("media API plugin", () => {
  it("registers schemas, proxies binary media and records generated images", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const config = defaultConfig();
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/plugin-test.png",
      filePath: path.resolve("plugin-test.png"),
      revisedPrompt: "portrait"
    }));
    const runtime = {
      getProvider: vi.fn(() => ({
        generateImage,
        getModelInfo: () => ({ model: "text-model", imageModel: "image-model" })
      }))
    } as unknown as SunaRuntime;
    registerMediaRoutes(app, { getConfig: () => config, runtime });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" }
    }));
    const image = await app.inject({
      method: "GET",
      url: `/api/media/image?url=${encodeURIComponent("https://8.8.8.8/image.jpg")}`
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/jpeg");
    expect([...image.rawPayload]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://8.8.8.8/image.jpg"), expect.objectContaining({
      redirect: "manual"
    }));

    const source = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#d71921" } }).png().toBuffer();
    fetchMock.mockResolvedValueOnce(new Response(source, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(source.length) }
    }));
    const thumbnail = await app.inject({
      method: "GET",
      url: `/api/media/thumbnail?url=${encodeURIComponent("https://8.8.8.8/large.png")}`
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/webp");
    expect(await sharp(thumbnail.rawPayload).metadata()).toMatchObject({ width: 480, height: 360, format: "webp" });

    fetchMock.mockResolvedValueOnce(new Response(source, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(source.length) }
    }));
    const placeholder = await app.inject({
      method: "GET",
      url: `/api/media/thumbnail?variant=placeholder&url=${encodeURIComponent("https://8.8.8.8/placeholder.png")}`
    });
    expect(placeholder.statusCode).toBe(200);
    expect(await sharp(placeholder.rawPayload).metadata()).toMatchObject({ width: 48, height: 48, format: "webp" });
    expect(placeholder.rawPayload.byteLength).toBeLessThan(8 * 1024);
    expect(placeholder.headers["cache-control"]).toContain("max-age=604800");

    const generated = await app.inject({
      method: "POST",
      url: "/api/playground/image",
      payload: {
        prompt: "portrait",
        size: "1024x1536",
        resolution: "4K",
        quality: "high"
      }
    });
    expect(generated.statusCode).toBe(200);
    expect(generateImage).toHaveBeenCalledWith("portrait", "2160x3840", "high");

    const history = await app.inject({ method: "GET", url: "/api/images" });
    expect(history.json().images).toContainEqual(expect.objectContaining({
      id: "plugin-test.png",
      size: "2160x3840",
      resolution: "4K",
      model: "image-model"
    }));

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/images",
      "/api/media/image",
      "/api/media/qq-avatar",
      "/api/media/thumbnail",
      "/api/playground/image",
      "/api/request-logs",
      "/api/token-usage"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
