import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("放弃离开会清除群聊回复联动草稿", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/orchestrator");

  const groupReply = page.getByLabel("启用", { exact: true });
  await expect(groupReply).toBeChecked();
  await groupReply.uncheck();

  await page.getByRole("link", { name: "状态", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未保存的设置？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "放弃并离开" }).click();

  await expect(page).toHaveURL(/\/overview$/);
  expect(state.patchRequests).toHaveLength(0);

  await page.goto("/agent-settings/orchestrator");
  await expect(groupReply).toBeChecked();
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(dialog).toBeHidden();
});

test("桌面 Agent 菜单不会让侧栏横向滚动", async ({ page }) => {
  await installMockApi(page);

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/overview");
    await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();

    const navigation = page.getByRole("navigation", { name: "主导航" });
    await page.getByRole("button", { name: /^当前 Agent：/ }).click();
    const menu = page.getByRole("listbox", { name: "Agent" });
    await expect(menu).toBeVisible();

    const overflow = await navigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
    expect((await menu.boundingBox())?.width).toBeGreaterThanOrEqual(256);
  }
});
