import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import { captureVisual, prepareVisualPage, visualViewports } from "./support/visual";

test("Quasar 管理台 Demo 视觉矩阵", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);

  for (const viewport of visualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/design-demo");

    await expect(page.getByRole("heading", { name: "Sunabot" })).toBeVisible();
    await expect(page.getByRole("search")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "快捷入口" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "quasar-design-demo-overview", { checkPageShell: true });

    await page.getByRole("button", { name: "界面设置" }).click();
    await expect(page).toHaveURL(/\/design-demo\/settings$/u);
    await expect(page.getByRole("heading", { name: "界面设置" })).toBeVisible();
    await expect(page.getByRole("group", { name: "切换外观" })).toBeVisible();
    await expect(page.getByRole("group", { name: "鼠标特效" })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "quasar-design-demo-settings", { checkPageShell: true });

    await page.getByRole("button", { name: "返回管理台" }).click();
    await expect(page).toHaveURL(/\/design-demo$/u);
  }
});

test("Quasar 动态鼠标按控件语义切换形态", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
  await installMockApi(page);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/design-demo");

  const settingsButton = page.getByRole("button", { name: "界面设置" });
  const buttonBounds = await settingsButton.boundingBox();
  expect(buttonBounds).not.toBeNull();
  await page.mouse.move(40, 120);
  await page.mouse.move(
    buttonBounds!.x + buttonBounds!.width / 2,
    buttonBounds!.y + buttonBounds!.height / 2,
    { steps: 12 }
  );
  const cursor = page.locator(".dynamic-cursor-shape");
  await expect(cursor).toHaveClass(/is-action/u);
  await expect(cursor).toBeVisible();
  await captureVisual(page, "1440x900", theme, "quasar-design-demo-cursor", {
    fullPage: false,
    checkPageShell: true
  });
});
