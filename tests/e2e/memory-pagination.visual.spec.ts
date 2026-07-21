import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

test("记忆分页桌面与移动端", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/memory");
    await expect(page.getByLabel("排序字段")).toHaveValue("updatedAt");
    await expect(page.getByLabel("排序方向")).toHaveValue("desc");
    const memoryRows = page.locator("article").filter({ has: page.getByRole("button", { name: "编辑记忆" }) });
    await expect(memoryRows).toHaveCount(20);
    const pagination = page.getByRole("navigation", { name: "记忆分页" });
    await expect(pagination).toContainText("共 21 条 · 每页 20 条");
    await pagination.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-pagination");
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
