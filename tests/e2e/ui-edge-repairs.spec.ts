import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("群聊回复联动在离开前完成自动同步", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/orchestrator");

  const groupReply = page.getByLabel("启用群聊回复", { exact: true });
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

test("提示词使用带行号的标准 Markdown 编辑器", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/agent-prompts/persona.soul");

  const editor = page.getByLabel("提示词正文");
  await editor.fill("# 标题\n**重点**与*斜体*\n> 引用\n<context>@{bot.name}</context>\n```text\n代码块\n```");

  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).toHaveAttribute("data-language", "markdown");
  await expect(page.locator(".prompt-field__editor .cm-lineNumbers")).toBeVisible();
  await expect(page.locator(".prompt-field__editor .cm-lineNumbers .cm-gutterElement").filter({ hasText: "7" })).toBeVisible();
  await expect(page.locator(".prompt-field__editor .cm-prompt-variable")).toHaveText("@{bot.name}");
  await expect(page.locator(".prompt-field__editor textarea, .prompt-field__highlight")).toHaveCount(0);
});

test("Final Prompt 全选时保持单层文本", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 1532, height: 842 });
  await page.goto("/system-prompts/memory.user-profile");

  const editor = page.getByRole("textbox", { name: "system 提示词" });
  await expect(editor).toBeVisible();
  await editor.fill(Array.from({ length: 48 }, (_, index) => (
    `${index + 1}. 你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。`
  )).join("\n"));

  await editor.press("ControlOrMeta+a");
  const editorFrame = page.locator(".prompt-field__editor").filter({ has: editor });
  const selection = editorFrame.locator(".cm-selectionBackground").first();
  await expect(selection).toBeVisible();
  const structure = await editorFrame.evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(".cm-scroller");
    const selectionLayer = element.querySelector<HTMLElement>(".cm-selectionBackground");
    if (!scroller || !selectionLayer) throw new Error("Missing CodeMirror selection layer");
    return {
      contentLayers: element.querySelectorAll(".cm-content").length,
      legacyLayers: element.querySelectorAll("textarea, .prompt-field__highlight").length,
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      scrollbarGutter: getComputedStyle(scroller).scrollbarGutter,
      selectionBackground: getComputedStyle(selectionLayer).backgroundColor
    };
  });

  expect(structure.contentLayers).toBe(1);
  expect(structure.legacyLayers).toBe(0);
  expect(structure.scrolls).toBe(true);
  expect(structure.scrollbarGutter).toBe("stable");
  expect(structure.selectionBackground).toContain("215, 25, 33");
});
