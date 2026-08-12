import { expect, test, type Page } from "@playwright/test";
import { installScheduledTasksApi } from "./support/scheduled-tasks";
import {
  captureVisual,
  compactVisualViewports,
  prepareVisualPage
} from "./support/visual";

test("导演发送会话矩阵", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo, { agentId: "plana" });
  await installScheduledTasksApi(page);
  const directorConversations = await installDirectorConversations(page);

  for (const viewport of compactVisualViewports) {
    directorConversations.reset();
    await page.setViewportSize(viewport);
    await page.goto("/director");
    await page.getByRole("tab", { name: "发送会话", exact: true }).click();

    const productGroup = page.getByRole("checkbox", { name: "产品讨论群导演事件" });
    const teacher = page.getByRole("checkbox", { name: "猫老师导演事件" });
    await expect(productGroup).not.toBeChecked();
    await expect(teacher).not.toBeChecked();
    await productGroup.check();
    await expect(productGroup).toBeChecked();
    await expect(teacher).not.toBeChecked();

    await captureVisual(page, viewport.name, theme, "director-conversations", {
      checkPageShell: true
    });

    await page.goto("/conversations/group%3A10001/settings/general");
    const conversationSetting = page.getByRole("checkbox", { name: "导演事件" });
    await expect(conversationSetting).toBeChecked();
    await captureVisual(page, viewport.name, theme, "conversation-settings-director", {
      checkPageShell: true
    });
  }
});

async function installDirectorConversations(page: Page) {
  const conversations = [{
    id: "group:10001",
    scope: "user_group",
    title: "产品讨论群",
    userId: 171419991,
    groupId: 10001,
    directorEventsEnabled: false,
    messageCount: 24,
    lastAt: "2026-07-23T09:00:00.000Z",
    lastText: "今天继续整理发布清单",
    messages: []
  }, {
    id: "private:20002",
    scope: "private",
    title: "猫老师",
    nickname: "猫老师",
    userId: 20002,
    directorEventsEnabled: false,
    messageCount: 9,
    lastAt: "2026-07-23T08:00:00.000Z",
    lastText: "收到",
    messages: []
  }];

  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/conversations/reply" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        id?: string;
        directorEventsEnabled?: boolean;
      };
      const record = conversations.find((item) => item.id === body.id);
      if (record && typeof body.directorEventsEnabled === "boolean") {
        record.directorEventsEnabled = body.directorEventsEnabled;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, conversation: record })
      });
      return;
    }
    if (url.pathname === "/api/conversations") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations })
      });
      return;
    }
    await route.fallback();
  });
  return {
    reset() {
      for (const conversation of conversations) conversation.directorEventsEnabled = false;
    }
  };
}
