import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import {
  captureVisual,
  prepareVisualPage,
  visualViewports
} from "./support/visual";

test("completed Dream 可再次手动触发", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  const state = await installMockApi(page);

  for (const viewport of visualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/memory");
    await page.getByRole("tab", { name: "梦境", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "梦境" });
    const trigger = panel.getByRole("button", { name: "立即做梦", exact: true });

    await expect(panel.getByRole("heading", { name: "已完成", exact: true })).toBeVisible();
    await expect(trigger).toBeEnabled();
    await captureVisual(page, viewport.name, theme, "memory-dream-manual-ready", {
      fullPage: false,
      checkPageShell: true
    });

    const triggerCount = state.dreamTriggers;
    await trigger.click();
    await expect(panel.getByText("梦境已完成", { exact: true })).toBeVisible();
    expect(state.dreamTriggers).toBe(triggerCount + 1);
    await captureVisual(page, viewport.name, theme, "memory-dream-manual-completed", {
      fullPage: false,
      checkPageShell: true
    });
  }
});
