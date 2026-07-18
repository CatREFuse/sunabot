import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { AgentMcpHttpServer } from "../../apps/admin-web/src/types/agentExtensions";
import { installEmojiManagementMock } from "./emoji-management.fixture";
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
    await page.getByRole("button", { name: "新增", exact: true }).click();
    const createAgentDialog = page.getByRole("dialog", { name: "新增 Agent" });
    await expect(createAgentDialog.getByText("导入现有配置", { exact: true })).toBeVisible();
    await expect(createAgentDialog.getByText("选择文件夹", { exact: true })).toBeVisible();
    await expect(createAgentDialog.getByText("选择 ZIP", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "agent-create-import");
    await createAgentDialog.getByRole("button", { name: "关闭", exact: true }).click();
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

    await page.goto("/extensions");
    await expect(page.getByRole("heading", { name: "扩展", exact: true })).toBeVisible();
    await expect(page.getByText("status-report", { exact: true })).toBeVisible();
    await expect(page.getByText("Workspace Search", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "agent-extensions");
    await page.getByRole("button", { name: "审核", exact: true }).click();
    const skillReviewDialog = page.getByRole("dialog", { name: "status-report" });
    await expect(skillReviewDialog).toBeVisible();
    await capture(page, viewport.name, theme, "agent-extensions-review");
    await skillReviewDialog.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "查看 Workspace Search 目录" }).click();
    const mcpCatalogDialog = page.getByRole("dialog", { name: "Workspace Search" });
    await expect(mcpCatalogDialog).toBeVisible();
    await capture(page, viewport.name, theme, "agent-extensions-mcp");
    await mcpCatalogDialog.getByLabel("关闭", { exact: true }).click();

    await page.goto("/conversations/group%3A10001");
    await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
    const conversationQuickControls = page.getByLabel("会话快捷操作");
    await expect(conversationQuickControls.getByRole("button", { name: "查看 Token 消耗详情" })).toContainText("128.4K");
    await expect(page.getByLabel("模型调用统计")).toHaveCount(0);
    await conversationQuickControls.getByRole("button", { name: "查看 Token 消耗详情" }).click();
    const conversationUsagePanel = page.getByRole("dialog", { name: "Token 消耗详情" });
    await expect(conversationUsagePanel.getByLabel("模型调用统计")).toContainText("24 条消息");
    await conversationUsagePanel.getByLabel("筛选模型").selectOption("gpt-5.4-mini");
    await expect(conversationUsagePanel.getByLabel("模型调用统计")).toContainText("96K Token");
    await conversationUsagePanel.getByRole("button", { name: "关闭 Token 消耗详情" }).click();
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
    await messageTrace.getByRole("button", { name: "查看请求日志" }).click();
    await expect(page.getByLabel("搜索请求日志")).toBeVisible();
    await page.getByLabel("搜索请求日志").fill("Beta");
    const matchedRequestLog = page.getByLabel("请求日志列表").locator("article");
    await expect(matchedRequestLog).toHaveCount(1);
    await matchedRequestLog.getByText("响应体", { exact: true }).click();
    await matchedRequestLog.locator("summary").filter({ hasText: /^payload/ }).click();
    await expect(page.getByText("模型返回正文 Beta", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "conversations-request-log-search");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "会话设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "会话设置", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "conversation-settings-general");
    await page.getByRole("button", { name: "工具权限", exact: true }).click();
    await expect(page.getByRole("heading", { name: "工具权限", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "conversation-settings-tools");

    await page.goto("/conversations/group%3A10001/settings/general");
    await expect(page.getByRole("heading", { name: "会话设置", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已同步");
    await capture(page, viewport.name, theme, "conversation-settings-route-general");
    await page.getByRole("button", { name: "工具权限", exact: true }).click();
    await expect(page.getByRole("heading", { name: "工具权限", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "conversation-settings-route-tools");

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
    const selfieManager = page.getByRole("region", { name: "自拍参考图" });
    await expect(selfieHeading).toBeVisible();
    await expect(page.getByText("3 / 9 张", { exact: true })).toBeVisible();
    await selfieHeading.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "auto" }));
    await capture(page, viewport.name, theme, "images-selfie");
    await selfieManager.getByRole("button", { name: "编辑备注 常服正面" }).click();
    const selfieNoteDialog = page.getByRole("dialog", { name: "编辑图片备注" });
    await expect(selfieNoteDialog.getByLabel("01-neutral-face.png 的备注")).toHaveValue("常服正面");
    await capture(page, viewport.name, theme, "images-selfie-note");
    await selfieNoteDialog.getByRole("button", { name: "取消", exact: true }).click();

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
    await expect(page.getByLabel("启动时间 / 秒")).toHaveValue("60");
    await page.getByLabel("启动时间 / 秒").scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "settings-orchestrator-disabled");

    await page.goto("/agent-settings/tone");
    await expect(page.getByRole("heading", { name: "语气处理" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tone");

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
    state.nextPatchError = "群聊命令需要管理员限制。";
    const allowGroupBash = page.getByLabel("允许管理员在群聊中使用");
    await allowGroupBash.focus();
    await allowGroupBash.press("Space");
    await expect(allowGroupBash).toBeChecked();
    await expect(page.getByText(/群聊命令需要管理员限制/)).toBeVisible();
    await capture(page, viewport.name, theme, "settings-validation-error");

    await page.goto("/settings/onebot");
    await expect(page.getByRole("heading", { name: "通知与连接监控" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OneBot" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-connections");

    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "管理员密码", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-security");

    state.config.bot.adminName = "管理员";
    await page.goto("/agent-settings/bot");
    await expect(page.getByLabel("过滤名单")).toBeVisible();
    await capture(page, viewport.name, theme, "settings-reply-behavior");
    await page.getByLabel("管理员称呼").fill("新的管理员称呼");
    await expect(page.locator('[data-confirm-label="确认管理员称呼"]')).toBeEnabled();
    await capture(page, viewport.name, theme, "settings-field-confirm-pending");
    await page.locator('[data-confirm-label="确认管理员称呼"]').click();
    await expect.poll(() => state.config.bot.adminName).toBe("新的管理员称呼");
    await expect(page.locator('[data-slot="settings-auto-save-status"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await capture(page, viewport.name, theme, "settings-field-confirmed");

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

test("自拍素材与备注四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/images");
    await expect(page.getByText("3 / 9 张", { exact: true })).toBeVisible();
    const manager = page.getByRole("region", { name: "自拍参考图" });
    await expect(manager.getByText("常服正面", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "selfie-manager-inline");

    await manager.getByRole("button", { name: "编辑备注 常服正面" }).click();
    const noteDialog = page.getByRole("dialog", { name: "编辑图片备注" });
    await expect(noteDialog.getByLabel("01-neutral-face.png 的备注")).toHaveValue("常服正面");
    await capture(page, viewport.name, theme, "selfie-note");
    await noteDialog.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("表情管理四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installEmojiManagementMock(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/emojis");
    await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "表情发送尺寸" })).toBeVisible();
    await expect(page.getByRole("button", { name: "修改 摸鱼 key" })).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-manager-compact");

    await page.getByRole("button", { name: "查看 开心 版本" }).click();
    await expect(page.getByRole("dialog", { name: "开心 · 版本" })).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-version-history");
    await page.getByRole("dialog", { name: "开心 · 版本" }).getByRole("button", { name: "关闭" }).click();
  }
});

test("语音设置四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/voice");
    await expect(page.getByRole("heading", { name: "语音", exact: true })).toBeVisible();
    await expect(page.getByText("MOSS-TTS-Nano", { exact: true })).toBeVisible();
    await expect(page.getByText("kivo-plana-ja.wav", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "voice-settings");

    await page.getByRole("button", { name: "替换音频", exact: true }).click();
    const uploadDialog = page.getByRole("dialog", { name: "替换日本語参考音频" });
    await expect(uploadDialog.getByLabel("选择参考音频")).toBeVisible();
    await expect(uploadDialog.getByRole("textbox")).toHaveValue("待機中、解決しなければならない作業が多数存在しています。");
    await capture(page, viewport.name, theme, "voice-reference-upload");
    await uploadDialog.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("扩展弹层短高视口", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  const state = await installMockApi(page);
  const oauthServer: AgentMcpHttpServer = {
    id: "remote-search",
    name: "Remote Search",
    description: "远程搜索服务。",
    enabled: true,
    transport: "streamable_http",
    url: "https://mcp.example.test/v1",
    auth: { kind: "oauth", credentialRef: "pending" }
  };
  state.extensions.plana?.servers.push(oauthServer);
  await page.setViewportSize({ width: 390, height: 568 });
  await page.goto("/extensions");

  await page.getByRole("button", { name: "安装 ZIP", exact: true }).click();
  const installDialog = page.getByRole("dialog", { name: "安装 Skill" });
  await expectDialogActionsInViewport(installDialog, 568);
  await capture(page, "390x568", theme, "agent-extensions-install-short");
  await installDialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "连接 OAuth", exact: true }).click();
  const oauthDialog = page.getByRole("dialog", { name: "Remote Search" });
  await expect(oauthDialog.getByLabel("OAuth 授权目标")).toContainText("普拉娜");
  await expectDialogActionsInViewport(oauthDialog, 568);
  await capture(page, "390x568", theme, "agent-extensions-oauth-short");
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
    await expect(page.getByLabel(/^启用 /)).toHaveCount(17);
    await expect(page.getByText("cron", { exact: true })).toBeVisible();
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

    await page.getByLabel("搜索工具").fill("run_skill_script");
    const unavailableSkillRow = page.locator("article").filter({ has: page.getByText("run_skill_script", { exact: true }) });
    await expect(unavailableSkillRow.getByText("运行环境异常", { exact: true })).toBeVisible();
    await expect(unavailableSkillRow.getByText("当前环境没有可用的 Skill 脚本审计执行器。", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-capability-error");
    await unavailableSkillRow.getByRole("button", { name: "查看 运行 Skill 脚本 详情" }).click();
    const unavailableSkillDialog = page.getByRole("dialog", { name: "运行 Skill 脚本" });
    await expect(unavailableSkillDialog.getByText("运行环境异常", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-tools-capability-error-detail");
    await unavailableSkillDialog.getByRole("button", { name: "关闭工具详情" }).click();
    await page.getByLabel("搜索工具").fill("");
  }
});

test("Bash 权限与会话状态四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-settings/bash");
    await expect(page.getByRole("heading", { name: "命令执行" })).toBeVisible();
    await expect(page.getByLabel("管理员私聊后端")).toHaveValue("native");
    await expect(page.getByLabel("严格审计")).toBeVisible();
    await expect(page.getByLabel("管理员身份门禁")).toBeVisible();
    await expect(page.getByLabel("允许管理员在群聊中使用")).toBeVisible();
    await expect(page.getByText("只读逐次确认", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-bash-permissions");

    await page.goto("/agent-settings/tools");
    await page.getByLabel("搜索工具").fill("workspace_bash");
    const bashRow = page.locator("article").filter({ has: page.getByText("workspace_bash", { exact: true }) });
    await expect(bashRow.getByText("仅管理员 QQ 私聊", { exact: true })).toBeVisible();
    await expect(bashRow.getByText("运行环境异常", { exact: true })).toHaveCount(0);
    await capture(page, viewport.name, theme, "settings-bash-session-scope");
    await bashRow.getByRole("button", { name: "查看 Bash 详情" }).click();
    const dialog = page.getByRole("dialog", { name: "Bash" });
    await expect(dialog.getByText("适用会话", { exact: true })).toBeVisible();
    await expect(dialog.getByText("管理员私聊后端", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-bash-detail");
    await dialog.getByRole("button", { name: "关闭工具详情" }).click();
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

test("提示词编辑器光标对齐", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => localStorage.setItem("sunabot.theme", selectedTheme), theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installMockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agent-prompts/persona.soul");

  const editor = page.getByLabel("提示词正文");
  await editor.fill([
    "# 角色关系",
    "",
    "你自尊心强、容易害羞、嘴硬，单纯却爱胡思乱想。",
    "你很容易把普通发言理解成别瞪了，是变态。",
    "",
    "你并不真正讨厌老师。你信任老师，也会把关心理解为职责、监视、维护纪律。",
    "",
    "**你的本质善良**，有正义感而且勇敢。"
  ].join("\n"));
  await editor.evaluate((element) => {
    const marker = "你很容易把普通发言理解成别瞪了，是变态。";
    const position = element.value.indexOf(marker) + marker.length - 3;
    element.focus();
    element.setSelectionRange(position, position);
  });
  await capture(page, "1440x900", theme, "prompt-cursor-alignment");
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

async function expectDialogActionsInViewport(dialog: import("@playwright/test").Locator, viewportHeight: number) {
  const actions = dialog.locator('[data-slot="dialog-actions"]');
  await expect(actions).toBeVisible();
  const box = await actions.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight);
}
