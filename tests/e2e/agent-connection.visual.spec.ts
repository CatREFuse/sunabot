import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import { captureVisual, compactVisualViewports, prepareVisualPage } from "./support/visual";

test("Agent 切换与本地、远程 QQ 接入", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/overview");
    const switcher = page.getByRole("group", { name: "Agent 与统计范围" });
    await expect(page.getByRole("combobox", { name: "当前 QQ 账号" })).toHaveCount(0);
    await switcher.getByRole("button", { name: "阿罗娜", exact: true }).click();
    await expect(switcher.getByRole("button", { name: "阿罗娜", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("阿罗娜主账号", { exact: true })).toBeVisible();
    await switcher.getByRole("button", { name: "普拉娜", exact: true }).click();
    await expect(page.getByText("主账号", { exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "agent-overview-switch");

    await page.goto("/agent-settings/connection");
    await expect(page.getByText("本地自启动", { exact: true })).toBeVisible();
    await expect(page.getByText("OneBot 已连接", { exact: true })).toBeVisible();
    await expect(page.getByText("QQ 在线", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "接入 QQ", exact: true })).toHaveCount(0);
    await captureVisual(page, viewport.name, theme, "agent-connection-local");
    await page.getByText("OneBot 已连接", { exact: true }).scrollIntoViewIfNeeded();
    await captureVisual(page, viewport.name, theme, "agent-connection-local-account");
    await page.route("**/api/agents/*/connection*", (route) => route.fulfill({ json: {
      mode: "remote", host: "ecs.example.test", transport: "ssh", onebotPort: 8788,
      onebotUrl: "ws://172.30.77.1:8788/onebot/v11/ws",
      coreUrl: "ws://127.0.0.1:8788/onebot/v11/ws"
    } }));
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(page.getByText("远程托管", { exact: true })).toBeVisible();
    await expect(page.getByText("ecs.example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("SSH 隧道", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "QQ 接入", exact: true }).scrollIntoViewIfNeeded();
    await captureVisual(page, viewport.name, theme, "agent-connection-remote");
    const accountStatus = page.getByText("OneBot 已连接", { exact: true });
    await accountStatus.scrollIntoViewIfNeeded();
    const statusBounds = await accountStatus.boundingBox();
    expect(statusBounds!.y + statusBounds!.height).toBeLessThanOrEqual(viewport.height - (viewport.width < 1024 ? 68 : 0));
    await expect(page.getByRole("button", { name: "账号", exact: true })).toBeInViewport();
    await captureVisual(page, viewport.name, theme, "agent-connection-remote-account");
    await page.unroute("**/api/agents/*/connection*");
  }
});
