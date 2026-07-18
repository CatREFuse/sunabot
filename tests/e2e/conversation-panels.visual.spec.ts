import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

test("会话快捷操作与侧栏视觉检查", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/conversations/group%3A10001");

    const quick = page.getByLabel("会话快捷操作");
    await expect(quick.getByLabel("回复", { exact: true })).toBeVisible();
    await expect(quick.getByLabel("编排", { exact: true })).toBeVisible();
    await expect(quick.getByRole("button", { name: "查看 Token 消耗详情" })).toContainText("128.4K");
    await expect(page.getByLabel("模型调用统计")).toHaveCount(0);
    await capture(page, viewport.name, theme, "conversation-quick-controls");

    await quick.getByRole("button", { name: "查看 Token 消耗详情" }).click();
    const usage = page.getByRole("dialog", { name: "Token 消耗详情" });
    await expect(usage.getByLabel("模型调用统计")).toContainText("128.4K Token");
    await capture(page, viewport.name, theme, "conversation-token-panel");
    await usage.getByRole("button", { name: "关闭 Token 消耗详情" }).click();

    await page.getByRole("button", { name: "会话设置" }).click();
    const settings = page.getByRole("dialog", { name: "会话设置" });
    await expect(settings.getByRole("heading", { name: "回复控制" })).toBeVisible();
    await capture(page, viewport.name, theme, "conversation-settings-panel");
    await settings.getByRole("button", { name: "关闭会话设置" }).click();
  }
});

async function capture(
  page: import("@playwright/test").Page,
  viewport: string,
  theme: string,
  name: string
) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth
  }));
  expect(overflow.document, `${name}: document horizontal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.body, `${name}: body horizontal overflow`).toBeLessThanOrEqual(1);

  const output = path.resolve("test-results/webui-visual", viewport, theme);
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: false,
    animations: "disabled"
  });
}
