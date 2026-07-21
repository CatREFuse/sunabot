// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("WebFetch renderer runtime", () => {
  it("keeps the renderer independent, loopback-only and free of secrets or workspace mounts", async () => {
    const [compose, seccomp] = await Promise.all([
      fs.readFile(path.join(root, "deploy/docker/compose.yml"), "utf8"),
      readJson(path.join(root, "deploy/docker/seccomp-webfetch-renderer.json"))
    ]);
    const renderer = compose.slice(compose.indexOf("  webfetch-renderer:"), compose.indexOf("  core:"));

    expect(renderer).toContain('127.0.0.1:8790:8790');
    expect(renderer).toContain("read_only: true");
    expect(renderer).toContain("no-new-privileges:true");
    expect(renderer).toContain("seccomp=deploy/docker/seccomp-webfetch-renderer.json");
    expect(renderer).toContain("SUNABOT_WEBFETCH_CHROMIUM_SANDBOX");
    expect(renderer).toContain("SUNABOT_WEBFETCH_PLATFORM");
    expect(renderer).toContain("cap_drop:\n      - ALL");
    expect(renderer).toContain("healthcheck:");
    expect(renderer).not.toContain("env_file:");
    expect(renderer).not.toContain("volumes:");
    expect(renderer).not.toMatch(/^\s+SUNABOT_WORKSPACE:/m);
    expect(seccomp.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(seccomp.syscalls).toContainEqual(expect.objectContaining({
      names: expect.arrayContaining(["clone", "setns", "unshare"]),
      action: "SCMP_ACT_ALLOW"
    }));
    const unconditionalChroot = seccomp.syscalls.find((entry: { names?: string[]; includes?: unknown }) => (
      entry.names?.includes("chroot") && entry.includes == null
    ));
    expect(unconditionalChroot).toMatchObject({ action: "SCMP_ACT_ALLOW" });
    expect(seccomp.syscalls).not.toContainEqual(expect.objectContaining({
      names: expect.arrayContaining(["chroot"]),
      includes: { caps: expect.arrayContaining(["CAP_SYS_CHROOT"]) }
    }));
  });

  it("packages the renderer and reports dynamic health as a degradable capability", async () => {
    const [contract, launcher, probe, release, rendererMain] = await Promise.all([
      readJson(path.join(root, "deploy/runtime-contract.json")),
      fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8"),
      fs.readFile(path.join(root, "tooling/runtime/probe.mjs"), "utf8"),
      fs.readFile(path.join(root, "tooling/runtime/build-release.mjs"), "utf8"),
      fs.readFile(path.join(root, "apps/webfetch-renderer/main.ts"), "utf8")
    ]);

    expect(contract.docker.services.webfetchRenderer).toEqual({
      name: "webfetch-renderer",
      image: "sunabot-webfetch-renderer",
      port: 8790
    });
    expect(contract.capabilities.optional).toContain("webfetch-dynamic-renderer");
    expect(launcher).toContain("WebFetch 动态渲染服务准备失败，静态抓取保持可用");
    expect(launcher).toContain('process.platform === "darwin" && process.arch === "arm64" ? "linux/arm64" : "linux/amd64"');
    expect(launcher).toContain('SUNABOT_WEBFETCH_CHROMIUM_SANDBOX: "1"');
    expect(probe).toContain('"webfetch-dynamic-renderer"');
    expect(release).toContain('"apps/webfetch-renderer"');
    expect(rendererMain).toContain('browser.once("disconnected"');
    expect(rendererMain).toContain("process.exit(1)");
  });
});

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
