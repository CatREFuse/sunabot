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
        : tasks.filter((task) => !task.director);
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
    } else if (url.pathname === "/api/config") {
      body = { config: { bot: { director: { enabled: false } } }, revision: "director-revision-1", fieldStates: {} };
    } else if (url.pathname === "/api/director/schedules") {
      body = {
        schedules: [{
          schemaVersion: 1,
          date: "2026-07-23",
          timeZone: "Asia/Shanghai",
          theme: "安静整理日",
          summary: "上午处理资料，午后整理书架，晚上阅读。",
          revision: 2,
          source: "character_revision",
          generatedAt: "2026-07-23T07:00:00+08:00",
          updatedAt: "2026-07-23T10:20:00+08:00",
          items: [{
            id: "morning",
            startAt: "2026-07-23T09:00:00+08:00",
            endAt: "2026-07-23T11:30:00+08:00",
            activity: "整理项目资料",
            location: "什亭之箱工作区",
            participants: ["老师"],
            intent: "完成资料归档",
            variant: "工作日",
            share: { enabled: false, at: null, textIntent: null, selfiePrompt: null }
          }, {
            id: "afternoon",
            startAt: "2026-07-23T14:00:00+08:00",
            endAt: "2026-07-23T16:00:00+08:00",
            activity: "整理书架",
            location: "窗边书架",
            participants: [],
            intent: "把常用资料放回顺手的位置",
            variant: "安静日",
            share: {
              enabled: true,
              at: "2026-07-23T15:20:00+08:00",
              textIntent: "分享整理后的书架",
              selfiePrompt: "窗边书架前的自然自拍"
            }
          }]
        }],
        pagination: { page: 1, pageSize: 14, total: 1, pageCount: 1 }
      };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}
