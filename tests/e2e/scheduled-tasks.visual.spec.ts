import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { ScheduledTask } from "../../apps/admin-web/src/types/scheduledTasks";

const viewports = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

const tasks: ScheduledTask[] = [
  {
    id: "weekday-briefing",
    revision: 4,
    name: "工作日晨间简报",
    enabled: true,
    context: "整理当天需要关注的项目进展、待办和风险，生成一条可以直接发送的晨间简报。",
    schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    targets: [
      { conversationId: "group:10001", mentionUserIds: ["171419991", "20002"] },
      { conversationId: "private:20002", mentionUserIds: [] }
    ],
    permanentRetention: false,
    archived: false,
    director: false,
    createdAt: "2026-07-18T01:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    nextTriggerAt: "2026-07-20T01:00:00.000Z",
    lastTriggerAt: "2026-07-18T01:00:00.000Z",
    lastRunStatus: "completed"
  },
  {
    id: "release-check",
    revision: 2,
    name: "发行前检查",
    enabled: false,
    context: "提醒确认构建产物、更新日志和回滚方案。",
    schedule: { kind: "once", runAt: "2026-07-22T10:30:00.000Z" },
    targets: [{ conversationId: "group:10001", mentionUserIds: ["171419991"] }],
    permanentRetention: false,
    archived: true,
    director: false,
    createdAt: "2026-07-18T02:00:00.000Z",
    updatedAt: "2026-07-19T02:00:00.000Z",
    lastTriggerAt: "2026-07-18T10:30:00.000Z",
    lastRunStatus: "failed",
    lastError: "上次回调未送达"
  },
  {
    id: "director-plana-20260721-lunch-r1-c1",
    revision: 1,
    name: "日常导演 · 午后整理资料",
    enabled: true,
    context: "在窗边整理刚读完的资料，分享午后安静的一刻。",
    schedule: { kind: "once", runAt: "2026-07-21T06:45:00.000Z" },
    targets: [{ conversationId: "group:10001", mentionUserIds: [] }],
    permanentRetention: false,
    archived: false,
    director: true,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    nextTriggerAt: "2026-07-21T06:45:00.000Z"
  }
];

test("定时任务桌面与移动端", async ({ page }, testInfo) => {
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem("sunabot.theme", selectedTheme);
    localStorage.setItem("sunabot.current-agent", "plana");
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await installScheduledTasksApi(page);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/scheduled-tasks");
    await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
    await expect(page.getByText("工作日晨间简报", { exact: true })).toBeVisible();
    await expect(page.getByText("发行前检查", { exact: true })).toBeVisible();
    await capture(page, viewport.name, theme, "scheduled-tasks-list");

    await page.getByRole("tab", { name: "导演任务", exact: true }).click();
    await expect(page.getByText("日常导演 · 午后整理资料", { exact: true })).toBeVisible();
    await expect(page.getByText("工作日晨间简报", { exact: true })).toBeHidden();
    await capture(page, viewport.name, theme, "scheduled-tasks-director");
    await page.getByRole("tab", { name: "全部", exact: true }).click();

    const task = page.locator("tr").filter({ hasText: "工作日晨间简报" });
    await task.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑定时任务" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("名称")).toHaveValue("工作日晨间简报");
    await expect(dialog.locator("small").filter({ hasText: "产品讨论群" }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "移除 @171419991" })).toBeVisible();
    await expectDialogActionsInViewport(dialog, viewport.height);
    await capture(page, viewport.name, theme, "scheduled-tasks-editor");
    await dialog.getByRole("heading", { name: "回调目标", exact: true }).scrollIntoViewIfNeeded();
    await capture(page, viewport.name, theme, "scheduled-tasks-editor-targets");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

async function installScheduledTasksApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname === "/api/auth/session") {
      body = {
        authenticated: true,
        username: "admin",
        csrfToken: "scheduled-tasks-visual",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
    } else if (url.pathname === "/api/status") {
      body = { onebot: { connected: true } };
    } else if (url.pathname === "/api/agents") {
      body = {
        agents: [{
          id: "plana",
          name: "普拉娜",
          enabled: true,
          workspace: "workspace/business/agents/plana",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
          accounts: [{
            id: "primary",
            agentId: "plana",
            label: "主账号",
            enabled: true,
            webuiPort: 6099,
            connected: true,
            runtimeReady: true,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z"
          }]
        }]
      };
    } else if (url.pathname === "/api/scheduled-tasks") {
      const category = url.searchParams.get("category") ?? "all";
      const visibleTasks = category === "director" ? tasks.filter((task) => task.director) : tasks;
      body = {
        tasks: visibleTasks,
        pagination: { page: 1, pageSize: 20, total: visibleTasks.length, pageCount: 1 }
      };
    } else if (url.pathname === "/api/conversations") {
      body = {
        conversations: [
          { id: "group:10001", scope: "user_group", title: "产品讨论群", messageCount: 24, messages: [] },
          { id: "private:20002", scope: "private", title: "猫老师", messageCount: 9, messages: [] }
        ]
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
  });
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
