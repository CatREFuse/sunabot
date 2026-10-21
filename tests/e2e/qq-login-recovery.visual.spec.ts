import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import {
  captureVisual,
  prepareVisualPage,
  visualViewports
} from "./support/visual";

test("QQ 二维码倒计时和过期遮罩", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  const state = await installMockApi(page);
  state.offline = true;
  state.qqOnline = false;
  let posts = 0;
  let expiresAt = Date.now() + 60_000;
  await page.route(/\/api\/agents\/plana\/accounts\/primary\/login(?:\/status)?(?:\?|$)/, async (route) => {
    if (route.request().method() === "POST") {
      posts += 1;
      expiresAt = Date.now() + 60_000;
    }
    await route.fulfill({ json: {
      connected: false, online: false, available: true, phase: "waiting_scan",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      imageUpdatedAt: new Date(expiresAt - 60_000).toISOString(), imageExpiresAt: new Date(expiresAt).toISOString()
    } });
  });
  for (const viewport of [visualViewports[0], visualViewports[3]]) {
    await page.setViewportSize(viewport);
    await page.goto("/agents/connection");
    await page.locator("section").filter({ hasText: "主账号" }).last().getByRole("button", { name: "账号", exact: true }).click();
    await expect(page.getByAltText("QQ 登录二维码")).toBeVisible();
    await expect(page.getByText(/秒后过期/)).toBeVisible();
    await captureVisual(page, viewport.name, theme, "qr-countdown");
    const originalPosts = posts;
    await page.clock.install();
    await page.clock.fastForward(61_000);
    await expect(page.getByTestId("qr-mask")).toBeVisible();
    await expect(page.getByAltText("QQ 登录二维码")).toHaveCount(0);
    expect(posts).toBe(originalPosts);
    await captureVisual(page, viewport.name, theme, "qr-expired-mask");
    // Return the browser clock to wall time before requesting the next synthetic QR.
    await page.clock.setSystemTime(new Date());
    await page.getByRole("button", { name: "点击刷新", exact: true }).click();
    await expect(page.getByAltText("QQ 登录二维码")).toBeVisible();
    expect(posts).toBe(originalPosts + 1);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("QQ 被踢下线后自动恢复四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = await prepareVisualPage(page, testInfo);
  const state = await installMockApi(page);
  let recoveryGate = Promise.resolve();
  await page.route(/\/api\/agents\/plana\/accounts\/primary\/login(?:\?|$)/, async (route) => {
    if (route.request().method() === "POST") await recoveryGate;
    await route.fallback();
  });

  for (const viewport of visualViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const primaryAccount = state.agents.find((agent) => agent.id === "plana")?.accounts[0];
    if (!primaryAccount) throw new Error("Primary account fixture is missing");
    primaryAccount.connected = true;
    state.offline = false;
    state.qqOnline = true;
    state.qqKickedOffline = true;
    let releaseRecovery!: () => void;
    recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });

    await page.goto("/agents/connection");
    const primaryAccountRow = page.locator("section").filter({ hasText: "主账号" }).last();
    await primaryAccountRow.getByRole("button", { name: "账号", exact: true }).click();
    await expect(page.getByText("正在恢复登录", { exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "agents-qq-login-recovery");
    releaseRecovery();

    await expect(page.getByAltText("QQ 登录二维码")).toBeVisible({ timeout: 10_000 });
    await captureVisual(page, viewport.name, theme, "agents-qq-login-recovered");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
});
