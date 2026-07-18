import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installEmojiManagementMock } from "./emoji-management.fixture";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1_440, height: 900 }
];

test("表情管理台 desktop/mobile light/dark 视觉矩阵", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript(({ selectedTheme }) => {
    localStorage.setItem("sunabot.current-agent", "plana");
    localStorage.setItem("sunabot.theme", selectedTheme);
  }, { selectedTheme: theme });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installEmojiManagementMock(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await navigateFromAgentMenu(page, viewport.width);
    await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "预设表情", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "摸鱼", exact: true })).toBeAttached();
    await expect(page.getByAltText("开心表情")).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-catalog");

    await page.getByRole("heading", { name: "自定义表情", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "摸鱼", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-custom");

    await page.locator(".page-shell").evaluate((element) => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "新增", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新增表情" });
    await expect(editor).toBeVisible();
    await expectDialogInViewport(editor, viewport.width, viewport.height);
    await capture(page, viewport.name, theme, "emoji-upload-dialog");
    await editor.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

async function navigateFromAgentMenu(page: import("@playwright/test").Page, viewportWidth: number) {
  await page.goto("/overview");
  if (viewportWidth >= 1_024) {
    await page.getByRole("link", { name: "表情", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "更多" });
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: /^表情/u }).click();
  }
  await expect(page).toHaveURL(/\/emojis$/u);
}

async function capture(
  page: import("@playwright/test").Page,
  viewport: string,
  theme: string,
  name: string
) {
  await page.evaluate(async () => {
    if ("fonts" in document) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  });
  const overflow = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".page-shell");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      shell: shell ? shell.scrollWidth - shell.clientWidth : 0
    };
  });
  expect(overflow.document, `${name}: document horizontal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.body, `${name}: body horizontal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.shell, `${name}: page shell horizontal overflow`).toBeLessThanOrEqual(1);

  const output = path.resolve("test-results/emoji-management", viewport, theme);
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

async function expectDialogInViewport(
  dialog: import("@playwright/test").Locator,
  viewportWidth: number,
  viewportHeight: number
) {
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight + 1);
}
