import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";
import { captureVisual, compactVisualViewports, prepareVisualPage } from "./support/visual";

test("会话图片与头像", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo);
  await installMockApi(page);
  await page.route("**/api/conversations/*/messages*", async (route) => {
    await route.fulfill({ json: {
      conversationId: "group:10001",
      hasMore: false,
      messages: [{
        id: "image-message", sequence: 1, role: "user", userId: 20002,
        groupId: 10001, senderName: "猫老师", selfId: 123456,
        text: "今天的照片", at: "2026-10-10T05:00:00.000Z",
        imageUrls: ["https://media.example/photo.png"]
      }]
    } });
  });
  const invalidThumbnails: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/media/thumbnail" && url.searchParams.get("url")?.startsWith("/api/")) {
      invalidThumbnails.push(url.pathname);
    }
  });
  for (const viewport of compactVisualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/conversations/group%3A10001");
    const image = page.getByRole("img", { name: "会话图片", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(image.locator("..")).toHaveAttribute("data-state", "ready");
    expect(invalidThumbnails).toEqual([]);
    await captureVisual(page, viewport.name, theme, "conversation-images");
  }
});
