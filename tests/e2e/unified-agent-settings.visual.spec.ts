import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import { captureVisual, compactVisualViewports, prepareVisualPage } from "./support/visual";

test("统一 Agent 设置和创建弹窗", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo, { agentId: "arona" });
  await installMockApi(page);
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agent 设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "阿罗娜", exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "unified-agents");
    await page.getByRole("button", { name: "新增 Agent", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "新增 Agent" })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "unified-agents-create");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.goto("/agent-settings/connection?from=bookmark#main-content");
    await expect(page).toHaveURL(/\/agents\/connection\?from=bookmark#main-content$/);
    await expect(page.getByText("QQ 未登录", { exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "unified-agents-connection");
  }
});
