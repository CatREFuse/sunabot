import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "900x844", width: 900, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

test("会话标题栏四视口矩阵", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/conversations/group%3A10001");

    const header = page.getByLabel("会话快捷操作");
    await expect(header.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
    await expect(header.getByRole("button", { name: "查看 Token 消耗详情" })).toContainText("128.4K");
    await expect(header.getByRole("status", { name: "编排器状态" })).toBeVisible();
    await expect(header.getByRole("button", { name: "会话设置" })).toBeVisible();
    await expect(header.getByRole("button", { name: "刷新消息" })).toBeVisible();
    await expect(header.getByRole("button", { name: "请求日志" })).toBeVisible();

    const bounds = await header.evaluate((element) => {
      const headerRect = element.getBoundingClientRect();
      const children = [...element.querySelectorAll<HTMLElement>(".conversation-identity, .conversation-instruments, .conversation-tools")];
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        childrenInside: children.every((child) => {
          const rect = child.getBoundingClientRect();
          return rect.left >= headerRect.left - 1 && rect.right <= headerRect.right + 1;
        })
      };
    });
    expect(bounds.pageOverflow).toBeLessThanOrEqual(1);
    expect(bounds.childrenInside).toBe(true);

    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${theme}-conversation-header.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/conversations/group%3A10001");
  await page.getByLabel("回复", { exact: true }).uncheck();
  await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("已关闭");
  await expect(page.getByLabel("编排", { exact: true })).toBeDisabled();
});
