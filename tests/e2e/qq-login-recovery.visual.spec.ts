import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import {
  captureVisual,
  prepareVisualPage,
  visualViewports
} from "./support/visual";

test("QQ 被踢下线后自动恢复四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = await prepareVisualPage(page, testInfo);
  const state = await installMockApi(page);

  for (const viewport of visualViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const primaryAccount = state.agents.find((agent) => agent.id === "plana")?.accounts[0];
    if (!primaryAccount) throw new Error("Primary account fixture is missing");
    primaryAccount.connected = true;
    state.offline = false;
    state.qqOnline = true;
    state.qqKickedOffline = true;

    await page.goto("/agents");
    const primaryAccountRow = page.locator("section").filter({ hasText: "主账号" }).last();
    await primaryAccountRow.getByRole("button", { name: "账号", exact: true }).click();
    await expect(page.getByText("正在恢复登录", { exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "agents-qq-login-recovery");

    await expect(page.getByAltText("QQ 登录二维码")).toBeVisible({ timeout: 10_000 });
    await captureVisual(page, viewport.name, theme, "agents-qq-login-recovered");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
});
