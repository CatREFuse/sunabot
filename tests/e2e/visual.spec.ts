import { expect, test, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import type { AgentMcpHttpServer } from "../../apps/admin-web/src/types/agentExtensions";
import { installEmojiManagementMock } from "./emoji-management.fixture";
import { installMockApi } from "./mock-api";
import { installScheduledTasksApi } from "./support/scheduled-tasks";
import {
  captureVisual as capture,
  compactVisualViewports,
  expectDialogActionsInViewport,
  expectLocatorInViewport,
  prepareVisualPage,
  visualViewports as viewports
} from "./support/visual";

const avatarCropFixture = sharp({
  create: { width: 900, height: 600, channels: 4, background: "#d71921" }
}).png().toBuffer();

const migratedVisualScenarios = [
  { title: "会话标题栏与侧栏矩阵", timeoutMs: 120_000, run: runConversationVisualScenario },
  { title: "知识库页面与上传弹层矩阵", timeoutMs: 90_000, run: runKnowledgeVisualScenario },
  { title: "记忆、梦境与召回矩阵", timeoutMs: 120_000, run: runMemoryVisualScenario },
  { title: "表情目录与编辑弹层矩阵", timeoutMs: 120_000, run: runEmojiVisualScenario },
  { title: "定时任务与编辑弹层矩阵", timeoutMs: 90_000, run: runScheduledTasksVisualScenario }
] satisfies readonly {
  title: string;
  timeoutMs: number;
  run(page: Page, testInfo: TestInfo): Promise<void>;
}[];

for (const scenario of migratedVisualScenarios) {
  test(scenario.title, async ({ page }, testInfo) => {
    test.setTimeout(scenario.timeoutMs);
    await scenario.run(page, testInfo);
  });
}

async function runConversationVisualScenario(page: Page, testInfo: TestInfo) {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  const conversationViewports = [
    viewports[0],
    viewports[1],
    { name: "900x844", width: 900, height: 844 },
    viewports[2]
  ];

  for (const viewport of conversationViewports) {
    await page.setViewportSize(viewport);
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
      const children = [...element.querySelectorAll<HTMLElement>(
        ".conversation-identity, .conversation-instruments, .conversation-tools"
      )];
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
    await capture(page, viewport.name, theme, "conversation-header");

    if (viewport.width === 390 || viewport.width === 1_440) {
      await capture(page, viewport.name, theme, "conversation-quick-controls", { fullPage: false });
      await header.getByRole("button", { name: "查看 Token 消耗详情" }).click();
      const usage = page.getByRole("dialog", { name: "Token 消耗详情" });
      await expect(usage.getByLabel("模型调用统计")).toContainText("128.4K Token");
      await capture(page, viewport.name, theme, "conversation-token-panel", { fullPage: false });
      await usage.getByRole("button", { name: "关闭 Token 消耗详情" }).click();

      await page.getByRole("button", { name: "会话设置" }).click();
      const settings = page.getByRole("dialog", { name: "会话设置" });
      await expect(settings.getByRole("heading", { name: "回复控制" })).toBeVisible();
      await capture(page, viewport.name, theme, "conversation-settings-panel", { fullPage: false });
      await settings.getByLabel("编排器时间覆盖").check();
      await expect(settings.getByLabel("编排器响应时间")).toBeEnabled();
      await capture(page, viewport.name, theme, "conversation-settings-response-time", { fullPage: false });
      await settings.getByRole("button", { name: "关闭会话设置" }).click();
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/conversations/group%3A10001");
  await page.getByLabel("回复", { exact: true }).uncheck();
  await expect(page.getByRole("status", { name: "编排器状态" })).toContainText("已关闭");
  await expect(page.getByLabel("编排", { exact: true })).toBeDisabled();
}

async function runKnowledgeVisualScenario(page: Page, testInfo: TestInfo) {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/knowledge");
    await expect(page.getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
    await page.getByLabel("检索知识库").fill("火星基地供电");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await expect(page.getByText("火星基地采用核能供电，水循环系统保持独立冗余。", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "knowledge-search");

    await page.getByRole("button", { name: "添加 Markdown", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "添加 Markdown" });
    await dialog.getByLabel("Markdown 文件").setInputFiles({
      name: "应急手册.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 应急手册\n\n检查恢复点。")
    });
    await dialog.getByLabel("保存位置").fill("运维/应急手册.md");
    await expectLocatorInViewport(dialog, viewport.width, viewport.height);
    await capture(page, viewport.name, theme, "knowledge-upload");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
}

async function runMemoryVisualScenario(page: Page, testInfo: TestInfo) {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/memory");
    const sourceTabs = page.getByRole("tablist", { name: "记忆类别" });
    await expect(sourceTabs.getByRole("tab")).toHaveCount(5);
    await expect(sourceTabs.getByRole("tab", { name: "工作记忆", exact: true })).toHaveAttribute("aria-selected", "true");
    const workingDocument = page.getByRole("tabpanel", { name: "工作记忆" });
    await expect(workingDocument).toContainText("WebUI 使用 Vue 3、TypeScript 与 Tailwind。");
    await expect(page.getByLabel("排序字段")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "记忆分页" })).toHaveCount(0);
    await workingDocument.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-document", { fullPage: false });
    await page.getByRole("button", { name: "操作日志", exact: true }).click();
    const operationLogDialog = page.getByRole("dialog", { name: "操作日志" });
    await expect(operationLogDialog.getByLabel("记忆操作日志列表").locator("li")).toHaveCount(3);
    await capture(page, viewport.name, theme, "memory-operation-log", { fullPage: false });
    await operationLogDialog.getByRole("button", { name: "关闭", exact: true }).click();

    await sourceTabs.getByRole("tab", { name: "长期记忆", exact: true }).click();
    await expect(page.getByLabel("排序字段")).toHaveValue("updatedAt");
    await expect(page.getByRole("button", { name: "当前新到旧，切换为旧到新" })).toBeVisible();
    const memoryRows = page.getByRole("button", { name: "查看长期记忆详情" });
    await expect(memoryRows).toHaveCount(20);
    await capture(page, viewport.name, theme, "memory-list", { fullPage: false });
    const pagination = page.getByRole("navigation", { name: "记忆分页" });
    await expect(pagination).toContainText("21 条 · 1 / 2");
    await pagination.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-pagination", { fullPage: false });

    await sourceTabs.getByRole("tab", { name: "场域知识", exact: true }).click();
    const air = page.getByRole("tabpanel", { name: "场域知识" });
    await expect(air.getByLabel("场域知识正文")).toHaveValue(/按会话范围理解/);
    await air.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-air", { fullPage: false });

    await sourceTabs.getByRole("tab", { name: "梦境", exact: true }).click();
    const dream = page.getByRole("tabpanel", { name: "梦境" });
    await expect(dream.getByRole("button", { name: "立即做梦", exact: true })).toBeVisible();
    await expect(dream.getByText(/我沿着潮湿的石阶走进旧车站/)).toBeVisible();
    await expect(dream.getByText("合并 2 · 归档 1 · 转存 1", { exact: true })).toBeVisible();
    await expect(dream.getByText("已微调", { exact: true })).toBeVisible();
    await dream.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-dream", { fullPage: false });

    await sourceTabs.getByRole("tab", { name: "长期记忆", exact: true }).click();
    await page.getByLabel("排序字段").selectOption("lastRecalledAt");
    const recall = page.getByRole("button", { name: "查看长期记忆详情" }).filter({ hasText: "管理台完成了第一轮视觉检查" });
    await recall.click();
    const inspector = page.getByRole("complementary", { name: "记忆详情", exact: true }).filter({ visible: true });
    await expect(inspector).toContainText("召回");
    await expect(inspector).toContainText("4 次 · 跨 3 天");
    const inspectorWidth = await inspector.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(inspectorWidth.scrollWidth).toBeLessThanOrEqual(inspectorWidth.clientWidth);
    await recall.scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "memory-recall-stats", { fullPage: false });
  }
}

async function runEmojiVisualScenario(page: Page, testInfo: TestInfo) {
  const theme = await prepareVisualPage(page, testInfo, { agentId: "plana" });
  await installEmojiManagementMock(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await navigateToEmojiManagement(page, viewport.width);
    await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "预设表情", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "摸鱼", exact: true })).toBeAttached();
    await expect(page.getByAltText("开心表情")).toBeVisible();
    await expect(page.getByRole("group", { name: "表情发送尺寸" })).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-catalog", { checkPageShell: true });

    if (viewport.width === 390 || viewport.width === 1_440) {
      await page.getByRole("heading", { name: "自定义表情", exact: true }).scrollIntoViewIfNeeded();
      await capture(page, viewport.name, theme, "emoji-custom", { checkPageShell: true });
      await page.locator(".page-shell").evaluate((element) => { element.scrollTop = 0; });
      await page.getByRole("button", { name: "新增", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "新增表情" });
      await expectLocatorInViewport(editor, viewport.width, viewport.height);
      await capture(page, viewport.name, theme, "emoji-upload-dialog", { checkPageShell: true });
      await editor.getByRole("button", { name: "关闭", exact: true }).click();
    }

    await page.getByRole("button", { name: "查看 开心 版本" }).click();
    const versions = page.getByRole("dialog", { name: "开心 · 版本" });
    await expect(versions).toBeVisible();
    await capture(page, viewport.name, theme, "emoji-version-history", { checkPageShell: true });
    await versions.getByRole("button", { name: "关闭" }).click();
  }
}

async function runScheduledTasksVisualScenario(page: Page, testInfo: TestInfo) {
  const theme = await prepareVisualPage(page, testInfo, { agentId: "plana" });
  await installScheduledTasksApi(page);
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/scheduled-tasks");
    await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
    await expect(page.getByText("工作日晨间简报", { exact: true })).toBeVisible();
    await expect(page.getByText("发行前检查", { exact: true })).toBeVisible();
    await expect(page.getByText("日常导演 · 午后整理资料", { exact: true })).toBeHidden();
    await capture(page, viewport.name, theme, "scheduled-tasks-list");

    const taskRow = page.locator("tr").filter({ hasText: "工作日晨间简报" });
    await taskRow.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑定时任务" });
    await expect(dialog.getByLabel("名称")).toHaveValue("工作日晨间简报");
    await expect(dialog.locator("small").filter({ hasText: "产品讨论群" }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "移除 @171419991" })).toBeVisible();
    await expectDialogActionsInViewport(dialog, viewport.height);
    await capture(page, viewport.name, theme, "scheduled-tasks-editor");
    await dialog.getByRole("heading", { name: "回调目标", exact: true }).scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "scheduled-tasks-editor-targets");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();

    await page.goto("/director");
    await expect(page.getByRole("heading", { name: "导演系统", exact: true })).toBeVisible();
    await expect(page.getByText("安静整理日", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "director-decisions");
    await page.getByRole("tab", { name: "计划任务", exact: true }).click();
    await expect(page.getByText("日常导演 · 午后整理资料", { exact: true })).toBeVisible();
    await expect(page.getByText("工作日晨间简报", { exact: true })).toBeHidden();
    await capture(page, viewport.name, theme, "director-tasks");
  }
}

async function navigateToEmojiManagement(page: Page, viewportWidth: number) {
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

test("四视口界面矩阵", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const theme = await prepareVisualPage(page, testInfo);
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
    await page.getByLabel("编排器时间覆盖", { exact: true }).check();
    await expect(page.getByLabel("编排器响应时间")).toHaveValue("60");
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
    await editor.locator("xpath=..").evaluate((element) => { element.scrollTop = 0; });
    await capture(page, viewport.name, theme, "prompts-dirty-conflict");
    await editor.press("ControlOrMeta+a");
    await capture(page, viewport.name, theme, "prompts-text-selection");
    await editor.press("ArrowLeft");
    await page.getByRole("button", { name: "加载服务器版本" }).click();

    await page.goto("/system-prompts/conversation.private-reply");
    await expect(page.getByRole("textbox", { name: "system 提示词" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Function Call" })).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-final-request");
    const variableTable = page.getByRole("table", { name: "提示词变量表" }).last();
    if (!await variableTable.isVisible()) await page.getByRole("button", { name: "变量表", exact: true }).click();
    await expect(variableTable).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-variable-table");
    await variableTable.getByRole("button").first().locator(".variable-context__token").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await capture(page, viewport.name, theme, "prompts-variable-tooltip");

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
    await expect(page.getByRole("heading", { name: "回复重试" })).toBeVisible();
    await expect(page.getByLabel("失败重试次数")).toHaveValue("3");
    await capture(page, viewport.name, theme, "settings-normal-reply");

    if (viewport.width === 390 || viewport.width === 1440) {
      await page.goto("/config-doctor");
      await expect(page.getByRole("heading", { name: "配置医生", exact: true })).toBeVisible();
      await expect(page.getByText("发现 1 项可修复问题", { exact: true })).toBeVisible();
      await capture(page, viewport.name, theme, "settings-config-doctor-report");
      await page.getByRole("button", { name: "一键修复", exact: true }).click();
      const doctorDialog = page.getByRole("dialog", { name: "修复全部配置？" });
      await expect(doctorDialog).toBeVisible();
      await capture(page, viewport.name, theme, "settings-config-doctor-confirm");
      await doctorDialog.getByRole("button", { name: "取消", exact: true }).click();

      await page.goto("/releases");
      await expect(page.getByRole("heading", { name: "版本更新", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "v0.1.3", exact: true })).toBeVisible();
      await capture(page, viewport.name, theme, "releases");
    }

    await page.goto("/settings/broadcastStorm");
    await expect(page.getByRole("heading", { name: "广播风暴" })).toBeVisible();
    await expect(page.getByLabel("广播风暴嗅探")).toBeChecked();
    await capture(page, viewport.name, theme, "settings-broadcast-storm");

    await page.goto("/agent-settings/orchestrator");
    await expect(page.getByRole("heading", { name: "群聊编排器" })).toBeVisible();
    await page.getByLabel("启用编排器", { exact: true }).uncheck();
    await expect(page.getByLabel("Thread 拆分模型")).toBeEnabled();
    await expect(page.getByLabel("启动时间 / 秒")).toHaveValue("60");
    await page.getByLabel("启动时间 / 秒").scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "settings-orchestrator-disabled");

    await page.goto("/agent-settings/tone");
    await expect(page.getByRole("heading", { name: "语气处理" })).toBeVisible();
    const toneEnabled = page.getByLabel("启用语气处理");
    if (!await toneEnabled.isChecked()) {
      await expect(page.getByLabel("分段回复")).toBeDisabled();
      await toneEnabled.check();
    }
    await expect(page.getByLabel("分段回复")).toBeEnabled();
    await capture(page, viewport.name, theme, "settings-tone");
    await page.getByLabel("主模型跟随").check();
    await expect(page.getByLabel("Provider")).toBeDisabled();
    await expect(page.getByLabel("随机性（Temperature）")).toBeDisabled();
    await capture(page, viewport.name, theme, "settings-tone-follow-main-model");

    await page.goto("/agent-settings/persona");
    await expect(page.getByRole("heading", { name: "Agent 身份" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-agent-identity");

    await page.goto("/agent-settings/bot");
    await expect(page.getByRole("heading", { name: "回复模型" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "读图" })).toBeVisible();
    await expect(page.getByLabel("生成图片描述")).toBeChecked();
    await expect(page.getByLabel("读图模型")).toHaveValue("gpt-5.4-mini");
    await capture(page, viewport.name, theme, "settings-reply-model-image-reader");

    await page.goto("/agent-settings/memory");
    await expect(page.getByRole("heading", { name: "记忆处理" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-memory");
    const dreamSampling = page.getByRole("heading", { name: "Dream 抽样" });
    await dreamSampling.scrollIntoViewIfNeeded();
    await expect(page.getByLabel("近期窗口（小时）")).toHaveValue("48");
    await expect(page.getByLabel("近期记忆数")).toHaveValue("12");
    await expect(page.getByLabel("更早记忆数")).toHaveValue("12");
    await capture(page, viewport.name, theme, "settings-memory-dream");

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
    state.nextPatchError = "审批模型不可用。";
    await page.getByLabel("对抗审批 Agent").fill("gpt-unavailable");
    await page.locator('[data-confirm-label="确认审批模型"]').click();
    await expect(page.getByText(/审批模型不可用/)).toBeVisible();
    await capture(page, viewport.name, theme, "settings-validation-error");

    await page.goto("/settings/onebot");
    await expect(page.getByRole("heading", { name: "连接与通知" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Bark 通知" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OneBot 连接" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-connections");

    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "管理员密码", exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-security");

    state.config.bot.adminName = "管理员";
    await page.goto("/agent-settings/bot");
    await expect(page.getByLabel("过滤名单")).toBeVisible();
    await capture(page, viewport.name, theme, "settings-reply-behavior");
    await page.goto("/agent-settings/persona");
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
    await expect(page.getByRole("tabpanel", { name: "工作记忆" })).toContainText("WebUI 使用 Vue 3、TypeScript 与 Tailwind。");
    await capture(page, viewport.name, theme, "memory-document");
    await page.getByRole("tab", { name: "用户画像", exact: true }).click();
    await page.getByRole("button", { name: "新增记忆", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新增用户画像" })).toBeVisible();
    await capture(page, viewport.name, theme, "memory-editor");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    const profileRow = page.getByRole("button", { name: "查看用户画像详情" }).filter({ hasText: "猫老师、老师" });
    await profileRow.click();
    await page.getByRole("complementary", { name: "记忆详情", exact: true }).filter({ visible: true }).getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("称呼")).toHaveValue("猫老师、老师");
    await capture(page, viewport.name, theme, "memory-profile-editor");
    await page.getByRole("button", { name: "关闭", exact: true }).click();

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
  const theme = await prepareVisualPage(page, testInfo);
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

test("语音设置四视口矩阵", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/voice");
    await expect(page.getByRole("heading", { name: "语音", exact: true })).toBeVisible();
    await expect(page.getByLabel("接口协议")).toHaveValue("openai-audio");
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
  const theme = await prepareVisualPage(page, testInfo);
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
  const theme = await prepareVisualPage(page, testInfo);
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
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-settings/tools");
    await expect(page.getByRole("tab", { name: "工具目录", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("搜索工具")).toBeVisible();
    await expect(page.getByLabel(/^启用 /)).toHaveCount(24);
    await expect(page.getByText("read_air", { exact: true })).toBeVisible();
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
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-settings/bash");
    await expect(page.getByRole("heading", { name: "命令执行" })).toBeVisible();
    await expect(page.getByText("对抗审批 Agent", { exact: true })).toBeVisible();
    await expect(page.getByLabel("严格审批")).toBeVisible();
    await expect(page.getByText("Native Bash · Docker Bash", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Docker Bash", { exact: true })).toBeVisible();
    await expect(page.getByText("Skill 与 MCP · 只读", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-bash-permissions");

    await page.goto("/agent-settings/tools");
    await page.getByLabel("搜索工具").fill("docker_bash");
    const bashRow = page.locator("article").filter({ has: page.getByText("docker_bash", { exact: true }) });
    await expect(bashRow.getByText("全部允许会话可用", { exact: true })).toBeVisible();
    await expect(bashRow.getByText("Docker Bash 已启动", { exact: true })).toBeVisible();
    await expect(bashRow.getByText("运行环境异常", { exact: true })).toHaveCount(0);
    await capture(page, viewport.name, theme, "settings-bash-session-scope");
    await bashRow.getByRole("button", { name: "查看 Docker Bash 详情" }).click();
    const dialog = page.getByRole("dialog", { name: "Docker Bash" });
    await expect(dialog.getByText("适用会话", { exact: true })).toBeVisible();
    await expect(dialog.locator("dt").filter({ hasText: /^Docker Bash$/ })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-bash-detail");
    await dialog.getByRole("button", { name: "关闭工具详情" }).click();
  }
});

test("连接设置四视口矩阵", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/settings/onebot");
    await expect(page.getByRole("heading", { name: "连接与通知" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Bark 通知" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OneBot 连接" })).toBeVisible();
    await capture(page, viewport.name, theme, "settings-connections");
  }
});

test("提示词编辑器光标对齐", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
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
  await editor.press("ControlOrMeta+ArrowUp");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await capture(page, "1440x900", theme, "prompt-cursor-alignment");
});

test("Final Prompt 输入框全选无文本重叠", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
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
  expect(structure).toMatchObject({ contentLayers: 1, legacyLayers: 0, scrolls: true, scrollbarGutter: "stable" });
  expect(structure.selectionBackground).toContain("215, 25, 33");
  await capture(page, "1532x842", theme, "prompt-selection-alignment");
});

test("提示词 s-if 条件语法高亮", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/system-prompts/conversation.tone-rewrite");

  await page.getByRole("textbox", { name: "system 提示词" }).fill([
    "分段 XML 检查",
    '<xml-check s-if="tone_mode == true">',
    "只允许规定的顶层标签，绝对不可嵌套。",
    "</xml-check>"
  ].join("\n"));

  const directive = page.locator(".cm-prompt-directive").filter({ hasText: "s-if=" }).first();
  const condition = page.locator(".cm-prompt-condition").filter({ hasText: "tone_mode == true" });
  await expect(directive).toBeVisible();
  await expect(condition).toHaveText("tone_mode == true");
  const [directiveColor, conditionColor] = await Promise.all([
    directive.evaluate((element) => getComputedStyle(element).color),
    condition.evaluate((element) => getComputedStyle(element).color)
  ]);
  expect(conditionColor).not.toBe(directiveColor);
  await capture(page, "1440x900", theme, "prompt-s-if-highlight");
});
