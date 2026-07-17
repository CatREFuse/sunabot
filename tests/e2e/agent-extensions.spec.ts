import { expect, test } from "@playwright/test";
import type { AgentMcpHttpServer } from "../../apps/admin-web/src/types/agentExtensions";
import { mcpStdioCredentialEnvironmentKey } from "../../packages/contracts/extensions/agentExtensions.js";
import { installMockApi } from "./mock-api";

const connectedOAuthHandle = `mcpcred_${"C".repeat(24)}`;

test("Agent 扩展可审核、启用、迁移 Skill 并批准 MCP 请求", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/extensions");

  await expect(page.getByRole("heading", { name: "扩展", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP 服务", exact: true })).toBeVisible();
  await expect(page.getByText("status-report", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "待批准的 MCP 请求" })).toBeVisible();
  await expect(page.getByText(`SUNABOT_MCP_STDIO_SECRET_${"A".repeat(32)}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`SUNABOT_MCP_HTTP_BEARER_${"B".repeat(32)}`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "批准一次", exact: true }).click();
  await expect(page.getByRole("heading", { name: "待批准的 MCP 请求" })).toHaveCount(0);

  await page.getByRole("button", { name: "审核", exact: true }).click();
  const review = page.getByRole("dialog", { name: "status-report" });
  await expect(review.getByText("仅指令", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "确认批准", exact: true }).click();
  await page.getByRole("button", { name: "启用", exact: true }).click();
  expect(state.extensions.plana?.skills[0]?.enabled).toBe(true);

  await page.getByRole("button", { name: "迁移", exact: true }).click();
  const copy = page.getByRole("dialog", { name: "迁移 status-report" });
  await expect(copy.getByLabel("目标 Agent")).toHaveValue("arona");
  await copy.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(copy.getByText("依赖已满足", { exact: true })).toBeVisible();
  await expect(copy.getByText("Workspace Search", { exact: true })).toBeVisible();
  await expect(copy.getByText("目标已停用", { exact: true })).toBeVisible();
  await expect(copy.getByText("需要重新授权", { exact: true })).toBeVisible();
  await expect(copy.getByText(`${mcpStdioCredentialEnvironmentKey("plana", "workspace-search", "WORKSPACE_SEARCH_TOKEN")} · 已配置`, { exact: true })).toBeVisible();
  await expect(copy.getByText(`${mcpStdioCredentialEnvironmentKey("arona", "workspace-search", "WORKSPACE_SEARCH_TOKEN")} · 缺失`, { exact: true })).toBeVisible();
  await expect(copy.getByText("111111111111…", { exact: true })).toBeVisible();
  await expect(copy.getByText("222222222222…", { exact: true })).toBeVisible();
  await expect(copy.getByText("333333333333…", { exact: true })).toBeVisible();
  await expect(copy.getByText("444444444444…", { exact: true })).toBeVisible();
  await expect(copy.getByText("无冲突", { exact: true })).toHaveCount(2);

  const staleStatus = await page.evaluate(async () => (await fetch("/api/agent-extensions/skills/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceAgentId: "plana",
      targetAgentId: "arona",
      skillId: "status-report",
      mcpServerIds: ["workspace-search"],
      previewRevision: "0".repeat(64),
      conflictStrategy: "skip"
    })
  })).status);
  expect(staleStatus).toBe(409);
  const invalidStrategyStatus = await page.evaluate(async () => (await fetch("/api/agent-extensions/skills/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceAgentId: "plana",
      targetAgentId: "arona",
      skillId: "status-report",
      mcpServerIds: ["workspace-search"],
      previewRevision: "f".repeat(64),
      conflictStrategy: "merge"
    })
  })).status);
  expect(invalidStrategyStatus).toBe(400);

  await copy.getByLabel("同名处理").selectOption("replace");
  await copy.getByRole("button", { name: "确认迁移", exact: true }).click();
  expect(state.extensions.arona?.skills.map((skill) => skill.id)).toContain("status-report");
  expect(state.extensions.arona?.servers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "workspace-search", enabled: false, migrationStatus: "reauthorization_required" })
  ]));
  const applyRequest = state.extensionRequests.find((request) => request.path === "/api/agent-extensions/skills/copy");
  expect(applyRequest?.body).toMatchObject({
    sourceAgentId: "plana",
    targetAgentId: "arona",
    skillId: "status-report",
    mcpServerIds: ["workspace-search"],
    previewRevision: "f".repeat(64),
    conflictStrategy: "replace"
  });
});

test("Agent 扩展可安装 Skill、确认完整 stdio 命令并查看 MCP 目录", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/extensions");

  await page.getByRole("button", { name: "安装 ZIP", exact: true }).click();
  const install = page.getByRole("dialog", { name: "安装 Skill" });
  await install.getByLabel("Skill ZIP").setInputFiles({
    name: "installed-skill.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK\u0003\u0004mock-skill")
  });
  await install.getByRole("button", { name: "安装", exact: true }).click();
  await expect(page.getByText("installed-skill", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  const server = page.getByRole("dialog", { name: "添加 MCP" });
  await server.getByLabel("服务 ID").fill("test-mcp");
  await server.getByLabel("名称", { exact: true }).fill("Test MCP");
  await server.getByLabel("描述").fill("测试本地 MCP 服务");
  await server.getByLabel("可执行文件").fill("/usr/bin/test-mcp");
  await server.getByLabel("参数").fill("--stdio\n--pattern=a,b");
  await server.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(server.getByText("/usr/bin/test-mcp --stdio --pattern=a,b", { exact: true })).toBeVisible();
  await server.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByText("Test MCP", { exact: true })).toBeVisible();
  expect(state.extensions.plana?.servers.some((item) => item.id === "test-mcp")).toBe(true);

  await page.getByRole("button", { name: "查看 Workspace Search 目录" }).click();
  const catalog = page.getByRole("dialog", { name: "Workspace Search" });
  await expect(catalog.getByText("search", { exact: true })).toBeVisible();
  await catalog.getByText("资源", { exact: true }).click();
  await expect(catalog.getByText("file:///workbench/README.md", { exact: true })).toBeVisible();
});

test("OAuth 显示授权身份并在主页面回流后刷新真实连接状态", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: () => ({
        opener: null,
        location: {
          replace: (url: string) => { (window as Window & { __oauthUrl?: string }).__oauthUrl = url; }
        },
        close: () => undefined
      })
    });
  });
  const state = await installMockApi(page);
  const oauthServer = remoteOAuthServer();
  state.extensions.plana?.servers.push(oauthServer);
  await page.goto("/extensions");

  await page.getByRole("button", { name: "连接 OAuth", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remote Search" });
  const target = dialog.getByLabel("OAuth 授权目标");
  await expect(target).toContainText("普拉娜");
  await expect(target).toContainText("plana");
  await expect(target).toContainText("remote-search");
  await expect(target).toContainText("https://mcp.example.test/v1");

  await dialog.getByLabel("授权端点").fill("https://auth.example.test/authorize");
  await dialog.getByLabel("Token 端点").fill("https://auth.example.test/token");
  await dialog.getByLabel("Client ID").fill("sunabot-web");
  await dialog.getByLabel("Scopes").fill("tools resources");
  await dialog.getByRole("button", { name: "打开授权", exact: true }).click();

  await expect(target).toContainText("https://auth.example.test");
  await expect.poll(() => page.evaluate(() => (window as Window & { __oauthUrl?: string }).__oauthUrl)).toBe("https://auth.example.test/authorize");

  oauthServer.auth = { kind: "oauth", credentialRef: connectedOAuthHandle };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("status")).toHaveText("已连接");
  await expect(page.locator("body")).not.toContainText(connectedOAuthHandle);
});

test("OAuth 弹窗被拦截时保留行内错误", async ({ page }) => {
  const state = await installMockApi(page);
  state.extensions.plana?.servers.push(remoteOAuthServer());
  await page.goto("/extensions");
  await page.evaluate(() => {
    Object.defineProperty(window, "open", { configurable: true, value: () => null });
  });

  await page.getByRole("button", { name: "连接 OAuth", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remote Search" });
  await dialog.getByLabel("授权端点").fill("https://auth.example.test/authorize");
  await dialog.getByLabel("Token 端点").fill("https://auth.example.test/token");
  await dialog.getByLabel("Client ID").fill("sunabot-web");
  await dialog.getByRole("button", { name: "打开授权", exact: true }).click();

  await expect(dialog.getByRole("alert")).toContainText("浏览器拦截了授权窗口");
});

function remoteOAuthServer(): AgentMcpHttpServer {
  return {
    id: "remote-search",
    name: "Remote Search",
    description: "远程搜索服务。",
    enabled: true,
    transport: "streamable_http",
    url: "https://mcp.example.test/v1",
    auth: { kind: "oauth", credentialRef: "pending" }
  };
}
