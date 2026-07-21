import { expect, test } from "@playwright/test";
import { installMockApi } from "./mock-api";

test("知识库检索、上传和删除", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/knowledge");

  await expect(page.getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
  await expect(page.getByText("产品/发布", { exact: true })).toBeVisible();
  await page.getByLabel("检索知识库").fill("火星基地供电");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText("火星基地采用核能供电，水循环系统保持独立冗余。", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加 Markdown", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "添加 Markdown" });
  await dialog.getByLabel("Markdown 文件").setInputFiles({
    name: "应急手册.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 应急手册\n\n检查恢复点。")
  });
  await dialog.getByLabel("保存位置").fill("运维/应急手册.md");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("应急手册.md", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "删除 运维/应急手册.md" }).click();
  await page.getByRole("button", { name: "确认删除 运维/应急手册.md" }).click();
  await expect(page.getByText("应急手册.md", { exact: true })).toHaveCount(0);
  expect(state.knowledgeRequests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"]);
});
