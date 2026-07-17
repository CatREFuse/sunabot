// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("admin web content security contract", () => {
  it("loads the theme initializer as a same-origin script", async () => {
    const [indexHtml, themeInitializer] = await Promise.all([
      fs.readFile(path.join(root, "apps/admin-web/index.html"), "utf8"),
      fs.readFile(path.join(root, "apps/admin-web/public/theme-init.js"), "utf8")
    ]);

    expect(indexHtml).toContain('<script src="/theme-init.js"></script>');
    expect(indexHtml).not.toContain("localStorage.getItem");
    expect(themeInitializer).toContain('localStorage.getItem("sunabot.theme")');
    expect(themeInitializer).toContain("document.documentElement.dataset.theme = theme");
  });

  it("keeps fonts as same-origin build assets", async () => {
    const viteConfig = await fs.readFile(path.join(root, "apps/admin-web/vite.config.ts"), "utf8");
    expect(viteConfig).toContain("assetsInlineLimit: 0");
  });

  it("does not relax the script or font policy", async () => {
    const serverSource = await fs.readFile(path.join(root, "apps/api/server.ts"), "utf8");
    const policy = serverSource.match(/reply\.header\("content-security-policy",\s*"([^"]+)"\)/u)?.[1];

    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("font-src 'self' data:");
  });
});
