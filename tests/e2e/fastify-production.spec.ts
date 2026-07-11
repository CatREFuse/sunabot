import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { expect, test } from "@playwright/test";
import { defaultConfig, saveConfig } from "../../src/config.js";
import { createApp } from "../../src/server.js";

let app: FastifyInstance;
let origin = "";
let temporaryDirectory = "";
let previousConfigPath: string | undefined;
let previousAdminToken: string | undefined;

test.beforeAll(async () => {
  previousConfigPath = process.env.SUNABOT_CONFIG;
  previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-fastify-e2e-"));
  process.env.SUNABOT_CONFIG = path.join(temporaryDirectory, "sunabot.json");
  process.env.SUNABOT_ADMIN_TOKEN = "fastify-production-token";

  const config = defaultConfig();
  config.persona.agentWorkspace = path.join(temporaryDirectory, "agent");
  await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  await saveConfig(config);
  app = await createApp({ config, initializeRuntime: false });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  if (previousConfigPath == null) delete process.env.SUNABOT_CONFIG;
  else process.env.SUNABOT_CONFIG = previousConfigPath;
  if (previousAdminToken == null) delete process.env.SUNABOT_ADMIN_TOKEN;
  else process.env.SUNABOT_ADMIN_TOKEN = previousAdminToken;
});

test("Fastify 生产服务提供静态资源、深链接回退与管理鉴权", async ({ request }) => {
  const deepLink = await request.get(`${origin}/settings/providers`);
  expect(deepLink.status()).toBe(200);
  expect(deepLink.headers()["content-type"]).toContain("text/html");
  const html = await deepLink.text();
  expect(html).toContain('<div id="app"></div>');

  const assetPath = html.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = await request.get(new URL(assetPath!, origin).toString());
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("javascript");

  const unauthorized = await request.get(`${origin}/api/status`, {
    headers: { "x-forwarded-for": "203.0.113.9" }
  });
  expect(unauthorized.status()).toBe(401);
  expect((await unauthorized.json()).error.code).toBe("ADMIN_UNAUTHORIZED");

  const authorized = await request.get(`${origin}/api/status`, {
    headers: {
      "x-forwarded-for": "203.0.113.9",
      authorization: "Bearer fastify-production-token"
    }
  });
  expect(authorized.status()).toBe(200);
});
