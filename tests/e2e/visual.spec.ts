import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { installMockApi } from "./mock-api";

const avatarCropFixture = sharp({
  create: { width: 900, height: 600, channels: 4, background: "#d71921" }
}).png().toBuffer();

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
    await expect(page.getByLabel("运行与 QQ 状态").getByText("在线", { exact: true }).first()).toBeVisible();
    await capture(page, viewport.name, theme, "overview-online");
    await page.getByRole("button", { name: "QQ 账号", exact: true }).click();
    await expect(page.getByRole("heading", { name: "QQ 登录" })).toBeVisible();
    await capture(page, viewport.name, theme, "overview-qq-account");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("heading", { name: "Token 消耗" }).scrollIntoViewIfNeeded();
    const tokenSummary = page.getByLabel("今日 Token 统计");
    await expect(tokenSummary.getByText("缓存输入", { exact: true })).toBeVisible();
    await expect(tokenSummary.getByText("缓存率", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "overview-token-usage");
    await page.getByRole("button", { name: "日", exact: true }).click();
    await page.getByLabel("每日 Token 消耗日历").scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "overview-token-calendar");
    await page.getByRole("button", { name: "小时", exact: true }).click();
    await page.getByLabel("今日每小时 Token 总量与输入缓存率").scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "overview-token-hourly");
    await page.locator(".page-shell").evaluate((element) => { element.scrollTop = 0; });

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
    state.qqOnline = false;
    await page.reload();
    await expect(page.locator("main").getByText("离线", { exact: true }).first()).toBeVisible();
    await capture(page, viewport.name, theme, "overview-offline");
    await page.getByRole("button", { name: "QQ 登录", exact: true }).click();
    await expect(page.getByAltText("QQ 登录二维码")).toBeVisible();
    await capture(page, viewport.name, theme, "overview-qq-login");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    state.offline = false;
    state.qqOnline = true;

    await page.goto("/agents");
    await page.getByRole("button", { name: "选择 阿罗娜" }).click();
    await expect(page.getByRole("heading", { name: "阿罗娜", exact: true })).toBeVisible();
    await expect(page.getByText("阿罗娜主账号", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "agents-arona");
    const aronaAccount = state.agents.find((agent) => agent.id === "arona")?.accounts[0];
    if (!aronaAccount) throw new Error("Arona account fixture is missing");
    Object.assign(aronaAccount, {
      connected: false,
      runtimeReady: false,
      desiredState: "running",
      observedState: "missing",
      reconcileRequired: false,
      lastError: null
    });
    await page.reload();
    const runAccount = page.getByRole("button", { name: "运行", exact: true });
    await expect(runAccount).toBeVisible();
    await runAccount.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "agents-arona-container-stopped");
    Object.assign(aronaAccount, {
      runtimeReady: true,
      desiredState: "running",
      observedState: "running",
      reconcileRequired: false
    });
    await page.getByRole("button", { name: "选择 普拉娜" }).click();

    await page.goto("/conversations/group%3A10001");
    await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
    await expect(page.getByLabel("模型调用统计")).toContainText("24 条消息");
    await page.getByLabel("筛选模型").selectOption("gpt-5.4-mini");
    await expect(page.getByLabel("模型调用统计")).toContainText("96K Token");
    await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("编排器状态");
    await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("判断中");
    await expect(page.getByRole("status", { name: "编排器状态" })).not.toContainText("消息");
    await expect(page.getByRole("status", { name: "编排器状态" })).not.toContainText("时间");
    await expect(page.getByText("用户不可见", { exact: true })).toBeVisible();
    await expect(page.getByText("判断失败", { exact: true })).toBeVisible();
    await expect(page.getByText("编排器判断失败，请查看请求日志。", { exact: true })).toBeVisible();
    const messageTrace = page.getByLabel("消息来源与工具");
    await expect(messageTrace).toContainText("来源text");
    await expect(messageTrace.getByText("memory_recall", { exact: true })).toHaveCount(1);
    await expect(messageTrace.getByText("websearch", { exact: true })).toBeVisible();
    await expect(messageTrace.getByRole("button", { name: "查看请求日志" })).toBeVisible();
    await expect(page.getByRole("status", { name: "正在输入" })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看请求日志" })).toHaveCount(3);
    await capture(page, viewport.name, theme, "conversations-detail");

    await page.goto("/web-chat");
    await expect(page.getByRole("heading", { name: "与普拉娜对话", exact: true })).toBeVisible();
    await expect(page.getByLabel("Web Chat 消息")).toBeVisible();
    await capture(page, viewport.name, theme, "web-chat");

    await page.goto("/agent-prompts");
    await expect(page.getByLabel("搜索文件")).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-list");

    await page.goto("/agent-prompts/persona.soul");
    const editor = page.getByLabel("提示词正文");
    await expect(editor).toBeVisible();
    await editor.fill([
      "# Voice",
      "",
      "- **保持清醒**，可靠与坦诚。",
      "- 使用 *克制* 且准确的表达。",
      "- 在需要时引用 @{persona.preference}。",
      "",
      "> 已确认，继续执行。",
      "",
      "```text",
      "status: ready",
      "```",
      "",
      "<context>@{persona.user}</context>",
      ...Array.from({ length: 18 }, (_, index) => `${index + 1}. 保持清醒、可靠与坦诚。`)
    ].join("\n"));
    const serverFile = state.files.find((file) => file.id === "persona.soul");
    if (!serverFile) throw new Error("Missing persona.soul fixture");
    serverFile.revision = `${serverFile.revision}-external`;
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("服务器版本已更新", { exact: true }).first()).toBeVisible();
    await editor.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await capture(page, viewport.name, theme, "prompts-dirty-conflict");
    await editor.evaluate((element) => {
      element.focus();
      element.setSelectionRange(16, 62);
    });
    await capture(page, viewport.name, theme, "prompts-text-selection");
    await editor.evaluate((element) => element.setSelectionRange(0, 0));
    await page.getByRole("button", { name: "加载服务器版本" }).click();

    await page.goto("/system-prompts/conversation.private-reply");
    await expect(page.getByRole("textbox", { name: "system 提示词" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Function Call" })).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-final-request");
    const variableTable = page.getByRole("table", { name: "提示词变量表" }).last();
    if (!await variableTable.isVisible()) await page.getByRole("button", { name: "变量表", exact: true }).click();
    await expect(variableTable).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-variable-table");

    await page.goto("/logs");
    await expect(page.getByRole("heading", { name: "日志", exact: true })).toBeVisible();
    await expect(page.getByLabel("模型调用统计")).toContainText("128.4K Token");
    await expect(page.getByLabel("Bot 活动终端")).toBeVisible();
    await capture(page, viewport.name, theme, "logs-terminal");
    await page.getByRole("button", { name: "请求日志", exact: true }).click();
    const requestLogs = page.getByLabel("请求日志列表");
    await expect(requestLogs).toBeVisible();
    await capture(page, viewport.name, theme, "logs-requests");
    const responseLog = requestLogs.locator("article").filter({ hasText: "responses.complete" }).first();
    await responseLog.getByText("响应体", { exact: true }).click();
    await responseLog.locator("summary").filter({ hasText: /^summary/ }).click();
    await responseLog.locator("summary").filter({ hasText: /^usage/ }).click();
    await responseLog.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "logs-token-usage-structured");

    await page.goto("/images");
    const selfieHeading = page.getByRole("heading", { name: "自拍参考图" });
    await expect(selfieHeading).toBeVisible();
    await expect(page.getByText("3 / 3 张", { exact: true })).toBeVisible();
    await selfieHeading.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "auto" }));
    await capture(page, viewport.name, theme, "images-selfie");
    await page.getByRole("button", { name: "管理参考图", exact: true }).click();
    const selfieDialog = page.getByRole("dialog", { name: "自拍参考图" });
    await expect(selfieDialog).toBeVisible();
    await capture(page, viewport.name, theme, "images-selfie-manager");
    await selfieDialog.getByRole("button", { name: "关闭", exact: true }).click();

    await page.goto("/settings/providers");
    await expect(page.getByRole("heading", { name: "模型服务" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-providers");

    await page.goto("/settings/normalReply");
    await expect(page.getByRole("heading", { name: "正常回复" })).toBeVisible();
    await expect(page.getByLabel("失败重试次数")).toHaveValue("3");
    await capture(page, viewport.name, theme, "settings-normal-reply");

    if (viewport.width === 390 || viewport.width === 1440) {
      await page.goto("/config-doctor");
      await expect(page.getByRole("heading", { name: "配置医生", exact: true })).toBeVisible();
      await expect(page.getByText("发现 1 项可修复问题", { exact: true })).toBeVisible();
      await capture(page, viewport.name, theme, "settings-config-doctor-report");
      await page.getByRole("button", { name: "应用修复", exact: true }).click();
      const doctorDialog = page.getByRole("dialog", { name: "应用这些修复？" });
      await expect(doctorDialog).toBeVisible();
      await capture(page, viewport.name, theme, "settings-config-doctor-confirm");
      await doctorDialog.getByRole("button", { name: "取消", exact: true }).click();
    }

    await page.goto("/settings/broadcastStorm");
    await expect(page.getByRole("heading", { name: "广播风暴" })).toBeVisible();
    await expect(page.getByLabel("广播风暴嗅探")).toBeChecked();
    await capture(page, viewport.name, theme, "settings-broadcast-storm");

    await page.goto("/agent-settings/orchestrator");
    await expect(page.getByRole("heading", { name: "群聊编排器" })).toBeVisible();
    await page.getByLabel("编排器", { exact: true }).uncheck();
    await expect(page.getByLabel("Thread 拆分模型")).toBeEnabled();
    await capture(page, viewport.name, theme, "settings-orchestrator-disabled");
    await page.getByRole("button", { name: "放弃", exact: true }).click();

    await page.goto("/agent-settings/persona");
    await expect(page.getByRole("heading", { name: "Agent 身份" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-agent-identity");

    await page.goto("/agent-settings/tools");
    await page.getByRole("tab", { name: "运行参数", exact: true }).click();
    const codexModel = page.getByRole("combobox", { name: "模型", exact: true });
    await expect(codexModel).toHaveValue("gpt-5.4-mini");
    await expect(page.getByText("Tavily Key 池", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加 Key" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-codex");
    await page.getByRole("tab", { name: "工具目录", exact: true }).click();
    await page.getByLabel("启用 Codex").uncheck();
    await page.getByRole("tab", { name: "运行参数", exact: true }).click();
    await expect(codexModel).toBeDisabled();
    await capture(page, viewport.name, theme, "settings-tools-codex-disabled");

    await page.goto("/agent-settings/bash");
    await expect(page.getByRole("heading", { name: "命令执行" })).toBeVisible();
    await page.getByLabel("允许群聊").check({ force: true });
    state.nextPatchError = "群聊命令需要管理员限制。";
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText(/群聊命令需要管理员限制/)).toBeVisible();
    await capture(page, viewport.name, theme, "settings-validation-error");
    await page.getByRole("button", { name: "放弃", exact: true }).click();

    await page.goto("/settings/onebot");
    await expect(page.getByRole("heading", { name: "通知与连接监控" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OneBot" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-connections");

    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "管理员密码", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-security");

    await page.goto("/agent-settings/bot");
    await expect(page.getByLabel("过滤名单")).toBeVisible();
    await capture(page, viewport.name, theme, "settings-reply-behavior");
    await page.getByLabel("管理员称呼").fill("新的管理员称呼");
    await page.getByRole("link", { name: "状态", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存并离开" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-unsaved-leave");
    await page.getByRole("button", { name: "继续编辑" }).click();

    await page.goto("/memory");
    await expect(page.getByRole("heading", { name: "记忆", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "memory-list");
    await page.getByRole("button", { name: "新增" }).click();
    await expect(page.getByRole("heading", { name: "新增记忆" })).toBeVisible();
    await capture(page, viewport.name, theme, "memory-editor");
    await page.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "用户画像" }).click();
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
    await expect(page.getByRole("heading", { name: "Sunabot", exact: true })).toBeVisible();
    await expect(page.getByText("管理 Agent、QQ 账号、会话与记忆", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
    await expect(page.getByText(/SECURE SESSION|ADMIN ACCESS|HttpOnly|浏览器存储/i)).toHaveCount(0);
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

test("头像裁图四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-settings/persona");
    await expect(page.getByRole("heading", { name: "Agent 身份" })).toBeVisible();
    await page.getByLabel("选择 WebUI 头像").setInputFiles({
      name: "plana.png",
      mimeType: "image/png",
      buffer: await avatarCropFixture
    });
    const cropDialog = page.getByRole("dialog", { name: "裁剪头像" });
    await expect(cropDialog).toBeVisible();
    await capture(page, viewport.name, theme, "settings-agent-avatar-crop");
    await cropDialog.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("工具目录四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-settings/tools");
    await expect(page.getByRole("tab", { name: "工具目录", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("搜索工具")).toBeVisible();
    await expect(page.getByLabel(/^启用 /)).toHaveCount(8);
    await capture(page, viewport.name, theme, "settings-tools-catalog");

    await page.getByRole("button", { name: "查看 行动中消息 详情" }).click();
    await expect(page.getByRole("dialog", { name: "行动中消息" })).toBeVisible();
    await expect(page.getByRole("table", { name: "工具参数" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-detail");
    await page.getByRole("button", { name: "关闭工具详情" }).click();

    await page.getByRole("button", { name: "查看 静默结束 详情" }).click();
    const noReplyDialog = page.getByRole("dialog", { name: "静默结束" });
    await expect(noReplyDialog.getByLabel("no_reply 时戳一戳")).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-no-reply-detail");
    await noReplyDialog.getByRole("button", { name: "关闭工具详情" }).click();
  }
});

test("连接设置四视口矩阵", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/settings/onebot");
    await expect(page.getByRole("heading", { name: "通知与连接监控" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OneBot" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-connections");
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
