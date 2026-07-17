// @vitest-environment node
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dockerfileUrl = new URL("../../deploy/docker/Dockerfile.skill-script", import.meta.url);
const entrypointUrl = new URL("../../deploy/docker/skill-script-entrypoint.mjs", import.meta.url);
const composeUrl = new URL("../../deploy/docker/compose.skill-script.yml", import.meta.url);

describe("Docker Skill script image contract", () => {
  it("pins the base image and installs only the fixed offline entrypoint and interpreters", async () => {
    const [dockerfile, entrypoint] = await Promise.all([
      fs.readFile(dockerfileUrl, "utf8"),
      fs.readFile(entrypointUrl, "utf8")
    ]);
    expect(dockerfile).toContain("node:24.18.0-bookworm-slim@sha256:");
    expect(dockerfile).toContain("skill-script-entrypoint.mjs /usr/local/libexec/sunabot-skill-script-entrypoint");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/libexec/sunabot-skill-script-entrypoint"]');
    expect(dockerfile).toContain("USER 65531:65531");
    expect(dockerfile).not.toMatch(/^\s*ENV\s/imu);
    for (const downloader of ["npm", "npx", "corepack", "pnpm", "yarn", "bunx", "uv", "uvx", "pip", "pip3"]) {
      expect(dockerfile).toContain(`/usr/local/bin/${downloader}`);
      expect(dockerfile).toContain(`! command -v ${downloader}`);
    }
    expect(entrypoint).toContain('new Set(["/bin/bash", "/usr/bin/node"])');
    expect(entrypoint).toContain("O_NOFOLLOW");
    expect(entrypoint).toContain("resourceSha256");
    expect(entrypoint).toContain(".sunabot-skill-script-manifest.json");
    expect(entrypoint).toContain('cwd: "/workbench"');
    expect(entrypoint).not.toContain("process.env");
    expect(entrypoint).not.toContain("shell: true");
  });

  it("keeps image construction separate from Core, NapCat, host networking, and Docker sockets", async () => {
    const compose = await fs.readFile(composeUrl, "utf8");
    expect(compose).toContain("image: ${SUNABOT_SKILL_SCRIPT_IMAGE:-sunabot-skill-script:local}");
    expect(compose).toContain('profiles: ["build"]');
    expect(compose).toMatch(/^\s+context:\s+\.\s*$/mu);
    expect(compose).toContain("dockerfile: Dockerfile.skill-script");
    expect(compose).toContain("network_mode: none");
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("docker.sock");
    expect(compose).not.toMatch(/^\s+(?:core|napcat):/mu);
  });
});
