import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import {
  captureVisual,
  prepareVisualPage,
  visualViewports
} from "./support/visual";

test("Dream 重试与终止状态", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  let terminal = false;
  await page.route("**/api/memory/dreams?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          id: terminal ? "dream-terminal" : "dream-retry",
          date: "2026-07-20",
          status: "failed",
          attemptCount: terminal ? 3 : 1,
          maxAttempts: 3,
          scheduledFor: "2026-07-20T04:00:00.000Z",
          errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
          errorText: "Dream 输出格式校验未通过。",
          ...(terminal ? {} : { nextRetryAt: "2026-07-20T04:20:00.000Z" }),
          failedAt: "2026-07-20T04:05:00.000Z"
        }],
        timeZone: "Asia/Shanghai",
        nextScheduledFor: "2026-07-21T04:00:00.000Z"
      })
    });
  });

  for (const viewport of visualViewports) {
    terminal = false;
    await page.setViewportSize(viewport);
    await page.goto("/memory");
    await page.getByRole("tab", { name: "梦境", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "梦境" });

    await expect(panel.getByText("输出格式未通过 · 第 1/3 次 · 等待重试", { exact: true })).toBeVisible();
    await expect(panel.getByText("DREAM_OUTPUT_CONTRACT_INVALID", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("dream-retry-time")).toContainText("12:20");
    await expect(panel.getByRole("button", { name: "立即做梦", exact: true })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "memory-dream-retry", {
      fullPage: false,
      checkPageShell: true
    });

    terminal = true;
    await panel.getByRole("button", { name: "刷新梦境", exact: true }).click();
    await expect(panel.getByText("Dream 输出格式连续 3 次未通过", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("dream-retry-time")).toHaveCount(0);
    await captureVisual(page, viewport.name, theme, "memory-dream-terminal", {
      fullPage: false,
      checkPageShell: true
    });
  }
});
