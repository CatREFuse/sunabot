import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

test("知识库移动端与桌面端视觉", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/knowledge");
    await expect(page.getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
    await page.getByLabel("检索知识库").fill("火星基地供电");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await expect(page.getByText("火星基地采用核能供电，水循环系统保持独立冗余。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`knowledge-${viewport.name}-${theme}.png`),
      fullPage: true
    });

    await page.getByRole("button", { name: "添加 Markdown", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "添加 Markdown" });
    await dialog.getByLabel("Markdown 文件").setInputFiles({
      name: "应急手册.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 应急手册\n\n检查恢复点。")
    });
    await dialog.getByLabel("保存位置").fill("运维/应急手册.md");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`knowledge-upload-${viewport.name}-${theme}.png`),
      fullPage: true
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
});
