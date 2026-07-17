import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("群聊回复联动在离开前完成自动同步", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/orchestrator");

  const groupReply = page.getByLabel("启用", { exact: true });
  await expect(groupReply).toBeChecked();
  await groupReply.uncheck();

  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect.poll(() => state.config.onebot.autoReplyUserGroup).toBe(false);
  await expect(page.getByRole("dialog", { name: "放弃未保存的设置？" })).toHaveCount(0);

  await page.goto("/agent-settings/orchestrator");
  await expect(groupReply).not.toBeChecked();
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
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

test("提示词高亮层保持与输入框一致的字符度量", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/agent-prompts/persona.soul");

  const editor = page.getByLabel("提示词正文");
  await editor.fill("# 标题\n**重点**与*斜体*\n> 引用\n```text\n代码块\n```");

  const metrics = await editor.evaluate((textarea) => {
    const highlight = textarea.previousElementSibling;
    if (!(highlight instanceof HTMLElement)) throw new Error("Missing prompt highlight layer");
    const inputStyle = getComputedStyle(textarea);
    const properties = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "wordSpacing",
      "whiteSpace",
      "wordBreak",
      "overflowWrap",
      "tabSize"
    ] as const;
    const expected = Object.fromEntries(properties.map((property) => [property, inputStyle[property]]));
    return Array.from(highlight.querySelectorAll(".markup-heading, .markup-bold, .markup-italic, .markup-quote, .markup-code-block"))
      .map((element) => ({
        className: element.className,
        display: getComputedStyle(element).display,
        metrics: Object.fromEntries(properties.map((property) => [property, getComputedStyle(element)[property]]))
      }))
      .map((element) => ({ ...element, expected }));
  });

  expect(metrics).not.toHaveLength(0);
  for (const element of metrics) {
    expect(element.metrics).toEqual(element.expected);
    expect(element.display).toBe("inline");
  }
});
