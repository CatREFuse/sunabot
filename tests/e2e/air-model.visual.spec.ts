import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import { captureVisual, compactVisualViewports, prepareVisualPage } from "./support/visual";

test("Agent 行为中的互动约定模型可保存并恢复跟随", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  const state = await installMockApi(page);
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/agents/bot");
    await expect(page.getByRole("heading", { name: "Agent 行为", exact: true })).toBeVisible();
    const model = page.getByRole("combobox", { name: "互动约定模型", exact: true });
    await expect(model).toHaveValue("");
    await model.scrollIntoViewIfNeeded();
    const before = state.patchRequests.length;
    await captureVisual(page, viewport.name, theme, "air-model-follow");
    expect(state.patchRequests).toHaveLength(before);
    await model.selectOption("gpt-5.6-sol");
    await expect.poll(() => state.config.bot.airModel).toBe("gpt-5.6-sol");
    await page.reload();
    await expect(model).toHaveValue("gpt-5.6-sol");
    await model.scrollIntoViewIfNeeded();
    await captureVisual(page, viewport.name, theme, "air-model-selected");
    await model.selectOption("");
    await expect.poll(() => state.config.bot.airModel).toBe("");
  }
});
