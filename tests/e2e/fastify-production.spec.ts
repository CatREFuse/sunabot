import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { expect, test } from "@playwright/test";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";

let app: FastifyInstance;
let origin = "";
let knowledgeApp: FastifyInstance;
let knowledgeOrigin = "";
let temporaryDirectory = "";
let previousConfigPath: string | undefined;
let previousAdminToken: string | undefined;
let previousWorkspace: string | undefined;

test.beforeAll(async () => {
  previousConfigPath = process.env.SUNABOT_CONFIG;
  previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
  previousWorkspace = process.env.SUNABOT_WORKSPACE;
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-fastify-e2e-"));
  process.env.SUNABOT_WORKSPACE = temporaryDirectory;
  process.env.SUNABOT_CONFIG = path.join(temporaryDirectory, "sunabot.json");
  process.env.SUNABOT_ADMIN_TOKEN = "fastify-production-token";
  const [{ defaultConfig, saveConfig }, { createApp }] = await Promise.all([
    import("../../src/config.js"),
    import("../../apps/api/server.js")
  ]);
  const config = defaultConfig();
  await saveConfig(config);
  app = await createApp({
    config,
    initializeRuntime: false,
    agentRegistry: {
      workspaceRoot: path.join(temporaryDirectory, WORKSPACE_LAYOUT.agentRoot),
      allowUnmarkedMigration: true
    }
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });

  const [{ registerKnowledgeRoutes }, { KnowledgeBaseService }] = await Promise.all([
    import("../../apps/api/plugins/knowledgeRoutes.js"),
    import("../../services/knowledge/public.js")
  ]);
  const knowledgeRoot = path.join(temporaryDirectory, WORKSPACE_LAYOUT.defaultAgent, "knowledge");
  await Promise.all([
    fs.mkdir(path.join(knowledgeRoot, "产品"), { recursive: true }),
    fs.mkdir(path.join(knowledgeRoot, "事件"), { recursive: true })
  ]);
  await fs.writeFile(
    path.join(knowledgeRoot, "产品", "路线.md"),
    "# 火星基地\n\n火星基地采用核能供电，水循环系统保持独立冗余。\n"
  );
  await fs.writeFile(
    path.join(knowledgeRoot, "事件", "运行记录.md"),
    "# 运行记录\n\nWorkbench 运行记录。\n"
  );
  const knowledgeService = new KnowledgeBaseService({
    sourceRoot: knowledgeRoot,
    indexPath: path.join(temporaryDirectory, "cache", "knowledge", "plana.sqlite")
  });
  knowledgeApp = Fastify({ logger: false });
  registerKnowledgeRoutes(knowledgeApp, {
    getService(agentId) {
      if (agentId !== "plana") throw new Error(`Unexpected knowledge Agent: ${agentId}`);
      return knowledgeService;
    }
  });
  knowledgeOrigin = await knowledgeApp.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await Promise.all([app?.close(), knowledgeApp?.close()]);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  if (previousConfigPath == null) delete process.env.SUNABOT_CONFIG;
  else process.env.SUNABOT_CONFIG = previousConfigPath;
  if (previousAdminToken == null) delete process.env.SUNABOT_ADMIN_TOKEN;
  else process.env.SUNABOT_ADMIN_TOKEN = previousAdminToken;
  if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
  else process.env.SUNABOT_WORKSPACE = previousWorkspace;
});

test("Fastify 生产服务提供静态资源、深链接回退与管理鉴权", async ({ request }) => {
  const deepLinks = [
    "/settings/providers",
    "/agent-settings/persona",
    "/agent-prompts/persona.soul",
    "/agent-prompts/image.selfie-rewrite",
    "/system-prompts/conversation.private-reply",
    "/web-chat",
    "/extensions",
    "/releases"
  ];
  let html = "";
  for (const pathname of deepLinks) {
    const deepLink = await request.get(`${origin}${pathname}`);
    expect(deepLink.status(), pathname).toBe(200);
    expect(deepLink.headers()["content-type"], pathname).toContain("text/html");
    const content = await deepLink.text();
    expect(content, pathname).toContain('<div id="app"></div>');
    html ||= content;
  }

  const assetPath = html.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = await request.get(new URL(assetPath!, origin).toString());
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("javascript");

  const unauthorized = await request.get(`${origin}/api/status?agentId=plana`, {
    headers: { "x-forwarded-for": "203.0.113.9" }
  });
  expect(unauthorized.status()).toBe(401);
  expect((await unauthorized.json()).error.code).toBe("ADMIN_UNAUTHORIZED");

  const authorized = await request.get(`${origin}/api/status?agentId=plana`, {
    headers: {
      "x-forwarded-for": "203.0.113.9",
      authorization: "Bearer fastify-production-token"
    }
  });
  expect(authorized.status()).toBe(200);

  const unauthorizedRelease = await request.get(`${origin}/api/releases`, {
    headers: { "x-forwarded-for": "203.0.113.9" }
  });
  expect(unauthorizedRelease.status()).toBe(401);

  const releaseCatalog = await request.get(`${origin}/api/releases`, {
    headers: {
      "x-forwarded-for": "203.0.113.9",
      authorization: "Bearer fastify-production-token"
    }
  });
  expect(releaseCatalog.status()).toBe(200);
  expect(releaseCatalog.headers()["cache-control"]).toBe("no-store");
  expect(await releaseCatalog.json()).toMatchObject({
    schemaVersion: 1,
    currentVersion: "0.3.0"
  });
});

test("知识库 WebUI 通过真实 Fastify 临时 workspace 完成检索、上传和删除", async ({ page }) => {
  const { installMockApi } = await import("./mock-api");
  await installMockApi(page);
  await page.route("**/api/knowledge**", async (route) => {
    const request = route.request();
    const source = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host;
    const response = await route.fetch({
      url: new URL(`${source.pathname}${source.search}`, knowledgeOrigin).toString(),
      headers
    });
    await route.fulfill({ response });
  });

  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
  await expect(page.getByText("产品", { exact: true })).toBeVisible();
  await expect(page.getByText("事件", { exact: true })).toBeVisible();
  await expect(page.getByText("路线.md", { exact: true })).toBeVisible();
  await expect(page.getByText("运行记录.md", { exact: true })).toBeVisible();
  await page.getByLabel("检索知识库").fill("火星基地供电");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText("火星基地采用核能供电，水循环系统保持独立冗余。", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加 Markdown", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "添加 Markdown" });
  await dialog.getByLabel("Markdown 文件").setInputFiles({
    name: "应急手册.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 应急手册\n\n检查恢复点。")
  });
  await dialog.getByLabel("保存位置").fill("运维/应急手册.md");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("应急手册.md", { exact: true })).toBeVisible();
  const uploadedPath = path.join(
    temporaryDirectory,
    WORKSPACE_LAYOUT.defaultAgent,
    "knowledge",
    "运维",
    "应急手册.md"
  );
  await expect(fs.readFile(uploadedPath, "utf8")).resolves.toContain("检查恢复点");

  await page.getByRole("button", { name: "删除 运维/应急手册.md" }).click();
  await page.getByRole("button", { name: "确认删除 运维/应急手册.md" }).click();
  await expect(page.getByText("应急手册.md", { exact: true })).toHaveCount(0);
  await expect(fs.stat(uploadedPath)).rejects.toMatchObject({ code: "ENOENT" });
});
