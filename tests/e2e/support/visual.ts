import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

export type VisualTheme = "light" | "dark";

export interface VisualViewport {
  name: string;
  width: number;
  height: number;
}

export const visualViewports: readonly VisualViewport[] = [
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1_440, height: 900 },
  { name: "1920x1080", width: 1_920, height: 1_080 }
];

export const compactVisualViewports = visualViewports.filter(({ width }) => width === 390 || width === 1_440);

export async function prepareVisualPage(
  page: Page,
  testInfo: TestInfo,
  options: { agentId?: string } = {}
): Promise<VisualTheme> {
  const theme: VisualTheme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.addInitScript(({ selectedTheme, agentId }) => {
    localStorage.setItem("sunabot.theme", selectedTheme);
    if (agentId) localStorage.setItem("sunabot.current-agent", agentId);
  }, { selectedTheme: theme, agentId: options.agentId });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  return theme;
}

export async function captureVisual(
  page: Page,
  viewport: string,
  theme: VisualTheme,
  name: string,
  options: { fullPage?: boolean; outputRoot?: string; checkPageShell?: boolean } = {}
) {
  await page.evaluate(async () => {
    if ("fonts" in document) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  });
  const overflow = await page.evaluate((checkPageShell) => {
    const shell = checkPageShell ? document.querySelector<HTMLElement>(".page-shell") : null;
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      shell: shell ? shell.scrollWidth - shell.clientWidth : 0
    };
  }, options.checkPageShell ?? false);
  expect(overflow.document, `${name}: document horizontal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.body, `${name}: body horizontal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.shell, `${name}: page shell horizontal overflow`).toBeLessThanOrEqual(1);

  const output = path.resolve("test-results", options.outputRoot ?? "webui-visual", viewport, theme);
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: options.fullPage ?? true,
    animations: "disabled"
  });
}

export async function expectLocatorInViewport(locator: Locator, viewportWidth: number, viewportHeight: number) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight + 1);
}

export async function expectDialogActionsInViewport(dialog: Locator, viewportHeight: number) {
  const actions = dialog.locator('[data-slot="dialog-actions"]');
  await expect(actions).toBeVisible();
  const bounds = await actions.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight);
}
