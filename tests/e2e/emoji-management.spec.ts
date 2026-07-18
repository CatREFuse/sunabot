import { expect, test } from "@playwright/test";
import { installEmojiManagementMock } from "./emoji-management.fixture";

test("表情可按 Agent 管理、生成、上传与删除", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("sunabot.current-agent")) localStorage.setItem("sunabot.current-agent", "plana");
    localStorage.setItem("sunabot.theme", "light");
  });
  const mock = await installEmojiManagementMock(page);

  await page.goto("/overview");
  await page.getByRole("link", { name: "表情", exact: true }).click();
  await expect(page).toHaveURL(/\/emojis$/u);
  await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "预设表情", exact: true })).toBeVisible();
  await expect(page.getByText("2 / 11").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "摸鱼", exact: true })).toBeVisible();
  await expect(page.getByText("[/摸鱼]", { exact: true })).toBeVisible();

  const cryingCard = emojiCard(page, "哭");
  await expect(cryingCard.getByRole("button", { name: "一键添加", exact: true })).toBeVisible();
  await expect(cryingCard.getByRole("button", { name: "上传", exact: true })).toBeVisible();
  await cryingCard.getByRole("button", { name: "一键添加", exact: true }).click();
  await expect(page.getByText("“哭”已生成", { exact: true })).toBeVisible();
  await expect(cryingCard.getByAltText("哭表情")).toBeVisible();
  expect(mock.recordsByAgent.plana?.find((record) => record.key === "哭")?.source).toBe("generated");

  await page.getByRole("button", { name: "新增", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增表情" });
  await expect(editor).toBeVisible();
  await editor.getByLabel("名称").fill("晚安");
  await editor.locator('input[type="file"]').setInputFiles({
    name: "good-night.png",
    mimeType: "image/png",
    buffer: mock.uploadFixture
  });
  await expect(editor.getByText("[/晚安]", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("“晚安”已保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "晚安", exact: true })).toBeVisible();

  await emojiCard(page, "摸鱼").getByRole("button", { name: "删除 摸鱼" }).click();
  const removeDialog = page.getByRole("dialog").filter({ hasText: "删除“摸鱼”？" });
  await expect(removeDialog).toBeVisible();
  await removeDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("“摸鱼”已删除", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "摸鱼", exact: true })).toHaveCount(0);

  const generatedRequest = mock.requests.find((request) => request.path === "/api/emojis/generate" && request.method === "POST");
  expect(generatedRequest).toMatchObject({ agentId: "plana", body: { key: "哭" } });
  const uploadRequest = mock.requests.find((request) => request.path === "/api/emojis" && request.method === "POST");
  expect(uploadRequest?.agentId).toBe("plana");
  expect(uploadRequest?.body?.key).toBe("晚安");
  expect(typeof uploadRequest?.body?.dataBase64).toBe("string");
  expect(String(uploadRequest?.body?.dataBase64).length).toBeGreaterThan(100);

  await page.getByRole("button", { name: "当前 Agent：普拉娜" }).click();
  const arona = page.getByRole("option").filter({ hasText: "阿罗娜" });
  await Promise.all([
    page.waitForEvent("framenavigated"),
    arona.click()
  ]);
  await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "打招呼", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "晚安", exact: true })).toHaveCount(0);
  await expect.poll(() => mock.requests.some((request) => (
    request.method === "GET" && request.path === "/api/emojis" && request.agentId === "arona"
  ))).toBe(true);
});

function emojiCard(page: import("@playwright/test").Page, key: string) {
  return page.locator("article").filter({
    has: page.getByRole("heading", { name: key, exact: true })
  });
}
