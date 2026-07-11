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

test("四视口界面矩阵", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  const state = await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    state.requiredToken = "";
    state.offline = false;

    await page.goto("/overview");
    await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();
    await expect(page.getByText("QQ 状态", { exact: true }).locator("..").getByText("在线", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "overview-online");

    await page.getByRole("button", { name: "诊断", exact: true }).click();
    await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "overview-diagnostics");
    await page.getByRole("button", { name: "关闭诊断" }).click();

    if (viewport.width < 768) {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await expect(page.getByRole("heading", { name: "更多", exact: true })).toBeVisible();
      await capture(page, viewport.name, theme, "mobile-more-theme");
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    }

    state.offline = true;
    await page.reload();
    await expect(page.locator("main").getByText("OFFLINE", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "overview-offline");
    state.offline = false;

    await page.goto("/conversations/group%3A10001");
    await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
    await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("编排器状态");
    await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("[判断中...]");
    await expect(page.getByRole("status", { name: "编排器状态" })).not.toContainText("消息");
    await expect(page.getByRole("status", { name: "编排器状态" })).not.toContainText("时间");
    await expect(page.getByText("用户不可见", { exact: true })).toBeVisible();
    await expect(page.getByText("判断失败", { exact: true })).toBeVisible();
    await expect(page.getByText("编排器判断失败，请查看请求日志。", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "正在输入" })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看请求日志" })).toHaveCount(2);
    await capture(page, viewport.name, theme, "conversations-detail");

    await page.goto("/prompts");
    await expect(page.getByLabel("搜索文件")).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-list");

    await page.goto("/prompts/persona.soul");
    const editor = page.getByLabel("提示词正文");
    await expect(editor).toBeVisible();
    await editor.fill(`${Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行：保持清醒、可靠与坦诚。`).join("\n")}\n`);
    const serverFile = state.files.find((file) => file.id === "persona.soul");
    if (!serverFile) throw new Error("Missing persona.soul fixture");
    serverFile.revision = `${serverFile.revision}-external`;
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("[CONFLICT · SERVER VERSION CHANGED]", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-dirty-conflict");
    await page.getByRole("button", { name: "加载服务器版本" }).click();

    await page.goto("/prompts/conversation.reply");
    await expect(page.getByRole("textbox", { name: "system 提示词" })).toBeVisible();
    if (viewport.width >= 1920) {
      await expect(page.getByRole("tabpanel", { name: "Function Call" })).toBeVisible();
    } else {
      await expect(page.getByRole("tab", { name: "Function Call" })).toBeVisible();
    }
    await capture(page, viewport.name, theme, "prompts-final-request");

    await page.goto("/settings/providers");
    await expect(page.getByRole("heading", { name: "模型服务" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-providers");

    await page.goto("/settings/tools");
    await expect(page.getByLabel("模型")).toHaveValue("gpt-5.4-mini");
    await expect(page.getByText("Tavily Key 池", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加 Key" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-codex");
    await page.getByText("启用 Codex", { exact: true }).click();
    await expect(page.getByLabel("模型")).toBeDisabled();
    await capture(page, viewport.name, theme, "settings-tools-codex-disabled");

    await page.goto("/settings/bash");
    await expect(page.getByRole("heading", { name: "命令执行" })).toBeVisible();
    await page.getByLabel("允许群聊").check({ force: true });
    state.nextPatchError = "群聊命令需要管理员限制。";
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText(/群聊命令需要管理员限制/)).toBeVisible();
    await capture(page, viewport.name, theme, "settings-validation-error");
    await page.getByRole("button", { name: "放弃", exact: true }).click();

    await page.goto("/memory");
    await expect(page.getByRole("heading", { name: "记忆", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "memory-list");
    await page.getByRole("button", { name: "新增" }).click();
    await expect(page.getByRole("heading", { name: "新增记忆" })).toBeVisible();
    await capture(page, viewport.name, theme, "memory-editor");
    await page.getByRole("button", { name: "关闭" }).click();
    const profileRow = page.locator("article").filter({ hasText: "称呼 猫老师" });
    await profileRow.getByRole("button", { name: "编辑记忆" }).click();
    await expect(page.getByLabel("称呼")).toHaveValue("猫老师");
    await capture(page, viewport.name, theme, "memory-profile-editor");
    await page.getByRole("button", { name: "关闭" }).click();

    await page.goto("/images");
    await expect(page.getByRole("heading", { name: "图像", exact: true })).toBeVisible();
    await expect(page.getByLabel("Prompt")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "生成图像" })).toHaveCount(0);
    await capture(page, viewport.name, theme, "image-history");
    await page.getByRole("button", { name: "预览 月球基地的清晨" }).click();
    await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
    await capture(page, viewport.name, theme, "image-preview");
    await page.getByRole("button", { name: "关闭预览" }).click();

    state.requiredToken = "visual-token";
    state.authenticated = false;
    await page.reload();
    await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
    await capture(page, viewport.name, theme, "admin-login");
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("管理员密码").fill("visual-token");
    const reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await reloaded;
    await expect(page.getByRole("heading", { name: "管理员登录" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "图像", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "admin-restored");
  }
});

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
    fullPage: true,
    animations: "disabled"
  });
}
