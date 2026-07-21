import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 }
];

test("梦境与长期记忆召回统计桌面和移动端", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/memory");

    const sourceTabs = page.getByRole("navigation", { name: "记忆类别" });
    await expect(sourceTabs.getByRole("button")).toHaveText(["工作记忆", "长期记忆", "用户画像", "梦境"]);
    await sourceTabs.getByRole("button", { name: "梦境", exact: true }).click();
    await expect(page.getByLabel("排序字段")).toBeVisible();
    await expect(page.getByLabel("排序方向")).toBeVisible();
    const dream = page.getByRole("region", { name: "梦境" });
    await expect(dream.getByRole("button", { name: "立即做梦", exact: true })).toBeVisible();
    await expect(dream.getByText(/我沿着潮湿的石阶走进旧车站/)).toBeVisible();
    await expect(dream.getByText("合并 2 · 归档 1 · 转存 1", { exact: true })).toBeVisible();
    await expect(dream.getByText("人格已微调", { exact: true })).toBeVisible();
    await dream.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-dream");

    await sourceTabs.getByRole("button", { name: "长期记忆" }).click();
    await page.getByLabel("排序字段").selectOption("lastRecalledAt");
    const recall = page.locator("article").filter({ hasText: "管理台完成了第一轮视觉检查。" });
    await expect(recall.getByText("召回 4 次", { exact: true })).toBeVisible();
    await expect(recall.getByText("跨 3 天", { exact: true })).toBeVisible();
    await recall.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-recall-stats");
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
