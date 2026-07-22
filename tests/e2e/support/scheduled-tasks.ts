import type { Page } from "@playwright/test";
import type { ScheduledTask } from "../../../apps/admin-web/src/types/scheduledTasks";

const taskDefaults: Omit<ScheduledTask, "id" | "name" | "context" | "schedule" | "targets"> = {
  revision: 1,
  enabled: true,
  permanentRetention: false,
  archived: false,
  director: false,
  createdAt: "2026-07-18T01:00:00.000Z",
  updatedAt: "2026-07-19T01:00:00.000Z"
};

const tasks: ScheduledTask[] = [
  {
    ...taskDefaults,
    id: "weekday-briefing",
    revision: 4,
    name: "工作日晨间简报",
    context: "整理当天需要关注的项目进展、待办和风险，生成一条可以直接发送的晨间简报。",
    schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    targets: [
      { conversationId: "group:10001", mentionUserIds: ["171419991", "20002"] },
      { conversationId: "private:20002", mentionUserIds: [] }
    ],
    nextTriggerAt: "2026-07-20T01:00:00.000Z",
    lastTriggerAt: "2026-07-18T01:00:00.000Z",
    lastRunStatus: "completed"
  },
  {
    ...taskDefaults,
    id: "release-check",
    revision: 2,
    name: "发行前检查",
    enabled: false,
    context: "提醒确认构建产物、更新日志和回滚方案。",
    schedule: { kind: "once", runAt: "2026-07-22T10:30:00.000Z" },
    targets: [{ conversationId: "group:10001", mentionUserIds: ["171419991"] }],
    archived: true,
    lastTriggerAt: "2026-07-18T10:30:00.000Z",
    lastRunStatus: "failed",
    lastError: "上次回调未送达"
  },
  {
    ...taskDefaults,
    id: "director-plana-20260721-lunch-r1-c1",
    name: "日常导演 · 午后整理资料",
    context: "在窗边整理刚读完的资料，分享午后安静的一刻。",
    schedule: { kind: "once", runAt: "2026-07-21T06:45:00.000Z" },
    targets: [{ conversationId: "group:10001", mentionUserIds: [] }],
    director: true,
    nextTriggerAt: "2026-07-21T06:45:00.000Z"
  }
];

export async function installScheduledTasksApi(page: Page) {
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
      const visibleTasks = url.searchParams.get("category") === "director"
        ? tasks.filter((task) => task.director)
        : tasks;
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}
