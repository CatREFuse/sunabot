import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("会话快捷开关与设置、Token 侧栏保持独立", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/conversations/group%3A10001");

  const quick = page.getByLabel("会话快捷操作");
  const reply = quick.getByLabel("回复", { exact: true });
  const orchestrator = quick.getByLabel("编排", { exact: true });
  const tokenWidget = quick.getByRole("button", { name: "查看 Token 消耗详情" });

  await expect(reply).toBeChecked();
  await expect(orchestrator).toBeChecked();
  await expect(tokenWidget).toContainText("128.4K");
  await expect(page.getByLabel("模型调用统计")).toHaveCount(0);

  await reply.uncheck();
  await expect(reply).not.toBeChecked();
  await expect(orchestrator).toBeDisabled();
  await reply.check();
  await expect(reply).toBeChecked();
  await expect(orchestrator).toBeEnabled();

  await tokenWidget.click();
  const usagePanel = page.getByRole("dialog", { name: "Token 消耗详情" });
  await expect(usagePanel).toBeVisible();
  await expect(usagePanel.getByLabel("模型调用统计")).toContainText("128.4K Token");
  const usageClose = usagePanel.getByRole("button", { name: "关闭 Token 消耗详情" });
  expect(await usagePanel.locator('[data-slot="conversation-side-panel-header"]').evaluate((header) => header.firstElementChild?.getAttribute("aria-label"))).toBe("关闭 Token 消耗详情");
  await page.keyboard.press("Escape");
  await expect(usagePanel).toBeHidden();

  await page.getByRole("button", { name: "会话设置" }).click();
  const settingsPanel = page.getByRole("dialog", { name: "会话设置" });
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel.getByRole("heading", { name: "回复控制" })).toBeVisible();
  const responseTimeOverride = settingsPanel.getByLabel("编排器时间覆盖");
  await expect(responseTimeOverride).not.toBeChecked();
  await expect(settingsPanel.getByLabel("编排器响应时间")).toHaveCount(0);
  await responseTimeOverride.check();
  const responseTime = settingsPanel.getByLabel("编排器响应时间");
  await expect(responseTime).toBeVisible();
  await expect(responseTime).toBeEnabled();
  await expect(responseTime).toHaveValue("60");
  await responseTime.fill("12");
  await responseTime.blur();
  await expect.poll(() => state.conversationReplySettings["group:10001"]).toMatchObject({
    orchestratorResponseTimeOverrideEnabled: true,
    orchestratorResponseTimeMs: 12_000
  });
  const settingsClose = settingsPanel.getByRole("button", { name: "关闭会话设置" });
  expect(await settingsPanel.locator('[data-slot="conversation-side-panel-header"]').evaluate((header) => header.firstElementChild?.getAttribute("aria-label"))).toBe("关闭会话设置");
  await settingsClose.click();
  await expect(settingsPanel).toBeHidden();
});

test("会话侧栏适配移动端且私聊只保留回复开关", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/conversations/private%3A20002");

  const quick = page.getByLabel("会话快捷操作");
  await expect(quick.getByLabel("回复", { exact: true })).toBeVisible();
  await expect(quick.getByLabel("编排", { exact: true })).toHaveCount(0);

  await quick.getByRole("button", { name: "查看 Token 消耗详情" }).click();
  const panel = page.getByRole("dialog", { name: "Token 消耗详情" });
  await expect(panel).toBeVisible();
  const bounds = await panel.locator('[data-slot="conversation-side-panel"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
