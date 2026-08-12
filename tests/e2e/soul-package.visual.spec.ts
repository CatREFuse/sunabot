import { expect, test } from "@playwright/test";
import {
  captureVisual,
  expectDialogActionsInViewport,
  prepareVisualPage,
  visualViewports
} from "./support/visual";

test("灵魂包导入预览", async ({ page }, testInfo) => {
  const theme = await prepareVisualPage(page, testInfo, { agentId: "arona" });
  await installSoulPageApi(page);

  for (const viewport of visualViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/agent-prompts");
    await expect(page.getByRole("button", { name: "导出灵魂" })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入灵魂" })).toBeVisible();
    await captureVisual(page, viewport.name, theme, "soul-package-controls");

    await page.locator('input[type="file"][accept*="sunabot-soul"]').setInputFiles({
      name: "plana.sunabot-soul.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"schema":"sunabot.soul","version":1}', "utf8")
    });
    const dialog = page.getByRole("dialog", { name: "导入灵魂" });
    await expect(dialog).toContainText("普拉娜 · plana");
    await expect(dialog).toContainText("目标 · arona");
    await expect(dialog).toContainText("4 个文件将更新");
    await expectDialogActionsInViewport(dialog, viewport.height);
    const lastFile = dialog.getByText("selfie_prompt_rewrite.json", { exact: true });
    await lastFile.scrollIntoViewIfNeeded();
    await expect(lastFile).toBeVisible();
    await expectDialogActionsInViewport(dialog, viewport.height);
    await captureVisual(page, viewport.name, theme, "soul-package-preview", { fullPage: false });
    await dialog.getByRole("button", { name: "取消" }).click();
  }
});

async function installSoulPageApi(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/auth/session") {
      return json({ authenticated: true, username: "admin", csrfToken: "visual-csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    if (url.pathname === "/api/agents") {
      return json({ agents: [{ id: "arona", name: "阿罗娜", enabled: true, accounts: [] }] });
    }
    if (url.pathname === "/api/status") return json({ onebot: { connected: true } });
    if (url.pathname === "/api/agents/arona/prompt-settings") return json({ overrideSystem: false });
    if (url.pathname === "/api/agent-files") {
      return json({
        files: [
          { id: "persona.soul", title: "SOUL", category: "persona", kind: "fragment", variables: [], fileName: "SOUL.md", revision: "soul-r1", empty: false },
          { id: "persona.user", title: "USER", category: "persona", kind: "fragment", variables: [], fileName: "USER.md", revision: "user-r1", empty: false }
        ]
      });
    }
    if (url.pathname === "/api/agents/arona/soul/preview") {
      return json({
        schema: "sunabot.soul",
        version: 1,
        source: { agentId: "plana", name: "普拉娜" },
        targetAgentId: "arona",
        packageSha256: "a".repeat(64),
        targetRevision: "b".repeat(64),
        files: [
          { id: "persona.agents", fileName: "AGENTS.md", kind: "fragment", change: "unchanged" },
          { id: "persona.soul", fileName: "SOUL.md", kind: "fragment", change: "replace" },
          { id: "persona.preference", fileName: "PREFERENCE.md", kind: "fragment", change: "replace" },
          { id: "persona.dialogue_style_examples", fileName: "DIALOGUE_STYLE_EXAMPLES.md", kind: "fragment", change: "unchanged" },
          { id: "persona.user", fileName: "USER.md", kind: "fragment", change: "unchanged" },
          { id: "persona.relation", fileName: "RELATION.md", kind: "fragment", change: "replace" },
          { id: "persona.air", fileName: "AIR.md", kind: "fragment", change: "unchanged" },
          { id: "persona.director-seed", fileName: "DIRECTOR_SEED.md", kind: "fragment", change: "unchanged" },
          { id: "image.selfie-rewrite", fileName: "selfie_prompt_rewrite.json", kind: "final", change: "replace" }
        ]
      });
    }
    return json({});
  });
}
