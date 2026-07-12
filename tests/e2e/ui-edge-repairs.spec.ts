import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("放弃离开会清除群聊回复联动草稿", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/orchestrator");

  const groupReply = page.getByLabel("启用", { exact: true });
  await expect(groupReply).toBeChecked();
  await groupReply.uncheck();

  await page.getByRole("link", { name: "状态", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未保存的设置？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "放弃并离开" }).click();

  await expect(page).toHaveURL(/\/overview$/);
  expect(state.patchRequests).toHaveLength(0);

  await page.goto("/settings/orchestrator");
  await expect(groupReply).toBeChecked();
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(dialog).toBeHidden();
});
