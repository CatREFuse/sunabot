// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCleanSourceStatus,
  assertReleaseBuildPlatform,
  createReleaseManifest,
  materializeReleaseEvidenceFromGit,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM_ID,
  RELEASE_PROTECTED_FILES,
  releasePlatformId,
  validateReleaseManifest
} from "../../tooling/runtime/release-integrity.mjs";

const fixtures: string[] = [];
const sourceCommit = "a".repeat(40);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe("Native release integrity", () => {
  it("accepts clean linux/x64 and linux/arm64 source builds", () => {
    expect(() => assertCleanSourceStatus("")).not.toThrow();
    expect(() => assertCleanSourceStatus(" M src/runtime.ts\n"))
      .toThrow("Git 工作树");
    expect(() => assertReleaseBuildPlatform("linux", "x64")).not.toThrow();
    expect(() => assertReleaseBuildPlatform("linux", "arm64")).not.toThrow();
    expect(releasePlatformId("linux", "x64")).toBe("linux/amd64");
    expect(releasePlatformId("linux", "arm64")).toBe("linux/arm64");
    expect(() => assertReleaseBuildPlatform("darwin", "x64"))
      .toThrow("darwin/x64");
  });

  it("binds every packaged runtime entrypoint and runtime resource tree", async () => {
    const fixture = await createFixture();
    expect(RELEASE_PROTECTED_FILES).toEqual(expect.arrayContaining([
      "tooling/shared/paths.mjs",
      "tooling/runtime/launcher-core.mjs",
      "tooling/workspace/sqlite-recovery.mjs",
      ".node-version",
      "sunabot.sh",
      "packages/platform/proxy.mjs",
      "package-lock.json",
      "node_modules/.package-lock.json",
      "runtime/node/bin/node",
      "runtime/bubblewrap/bwrap",
      "runtime/bubblewrap/SOURCE.txt",
      "runtime/lightpanda/lightpanda",
      "licenses/lightpanda/LICENSE",
      "licenses/lightpanda/SOURCE.txt"
    ]));
    expect(fixture.manifest.schemaVersion).toBe(RELEASE_MANIFEST_SCHEMA_VERSION);
    expect(fixture.manifest.platform).toBe(RELEASE_PLATFORM_ID);
    expect(fixture.manifest.runtimeContractSha256)
      .toBe(fixture.manifest.integrity.files["deploy/runtime-contract.json"]);
    expect(Object.keys(fixture.manifest.integrity.files)).toEqual(expect.arrayContaining([
      "packages/platform/multiAgentMigrationGate.mjs",
      "packages/platform/proxy.mjs",
      "apps/admin-web/dist/index.html",
      "codex-skills/workbench-config/SKILL.md",
      "config/env.example",
      "deploy/napcat/compose.yml",
      "deploy/napcat/napcat-entrypoint.sh",
      "tooling/shared/paths.mjs",
      "tooling/migrations/migrate-single-agent-to-multi-agent.mjs",
      "tooling/migrations/migrate-to-sqlite.mjs",
      "tooling/runtime/launcher-core.mjs",
      "tooling/runtime/transitive-helper.mjs",
      "tooling/workspace/sqlite-recovery.mjs",
      "dist/src/config.js",
      "dist/adapters/sqlite/applicationDataStore.js",
      "dist/services/media/attachments/chunks.js",
      "node_modules/dotenv/lib/main.js",
      "runtime/bubblewrap/bwrap",
      "sources/bubblewrap/bubblewrap_0.8.0.orig.tar.xz",
      "runtime/lightpanda/lightpanda",
      "sources/lightpanda/source.tar.gz"
    ]));
    expect(Object.keys(fixture.manifest.integrity.files).some((relative) => relative.includes("/.bin/")))
      .toBe(false);

    await expect(validate(fixture)).resolves.toMatchObject({
      contract: { runtimeId: "sunabot-qq-runtime" },
      packageManifest: { version: "0.3.0" },
      componentLock: {
        components: {
          node: { version: process.versions.node },
          lightpanda: { version: "0.3.3" },
          bubblewrap: { version: "0.8.0-2+deb12u1" }
        }
      }
    });
  });

  it("validates every packaged command before dispatch without trusting dependency shims", async () => {
    const launcher = await fs.readFile(path.join(projectRoot, "sunabot.sh"), "utf8");
    const validation = launcher.indexOf("validateReleaseManifest");

    expect(validation).toBeGreaterThan(-1);
    expect(launcher).not.toContain("$ROOT/node_modules/.bin");
    for (const entrypoint of [
      'exec "$BUNDLED_NODE" "$ROOT/tooling/agents/soul-cli.mjs"',
      'exec "$BUNDLED_NODE" "$ROOT/tooling/migrations/upgrade-0.2.0-to-0.3.0.mjs"',
      'exec "$BUNDLED_NODE" "$ROOT/tooling/runtime/launcher.mjs"'
    ]) {
      expect(launcher.indexOf(entrypoint)).toBeGreaterThan(validation);
    }
  });

  it.each([
    ["root launcher", "sunabot.sh"],
    ["Node version contract", ".node-version"],
    ["admin WebUI", "apps/admin-web/dist/index.html"],
    ["NapCat Compose contract", "deploy/napcat/compose.yml"],
    ["NapCat entrypoint", "deploy/napcat/napcat-entrypoint.sh"],
    ["outbound proxy", "packages/platform/proxy.mjs"],
    ["workspace initialization config", "config/env.example"],
    ["bundled Workbench Skill", "codex-skills/workbench-config/SKILL.md"],
    ["migration entry", "tooling/migrations/migrate-single-agent-to-multi-agent.mjs"],
    ["platform gate", "packages/platform/multiAgentMigrationGate.mjs"],
    ["project root resolver", "tooling/shared/paths.mjs"],
    ["launcher contract helper", "tooling/runtime/launcher-core.mjs"],
    ["recovery implementation", "tooling/workspace/sqlite-recovery.mjs"],
    ["tooling tree member", "tooling/runtime/transitive-helper.mjs"],
    ["prebuilt dependency", "dist/src/config.js"],
    ["installed production dependency", "node_modules/dotenv/lib/main.js"],
    ["root dependency lock", "package-lock.json"],
    ["installed dependency lock", "node_modules/.package-lock.json"],
    ["bundled Node", "runtime/node/bin/node"],
    ["bundled Bubblewrap", "runtime/bubblewrap/bwrap"],
    ["Bubblewrap corresponding source", "sources/bubblewrap/bubblewrap_0.8.0.orig.tar.xz"],
    ["bundled Lightpanda", "runtime/lightpanda/lightpanda"],
    ["Lightpanda corresponding source", "sources/lightpanda/source.tar.gz"]
  ])("rejects tampering in the %s", async (_name, relative) => {
    const fixture = await createFixture();
    await fs.appendFile(path.join(fixture.root, relative), "tampered\n");
    await expect(validate(fixture)).rejects.toThrow(`发行文件校验失败：${relative}`);
  });

  it.each([
    "apps/admin-web/dist/stale-build.js",
    "deploy/napcat/stale-entrypoint.sh",
    "packages/platform/stale-runtime.mjs",
    "dist/stale-build.js",
    "node_modules/dotenv/stale-build.js"
  ])("rejects an unmanifested executable file at %s", async (relative) => {
    const fixture = await createFixture();
    await write(fixture.root, relative, "export const stale = true;\n");
    await expect(validate(fixture)).rejects.toThrow("发行文件清单与当前预构建产物不一致");
  });

  it("allows generated .bin links and rejects symlinks in executable dependency paths", async () => {
    const fixture = await createFixture();
    await expect(validate(fixture)).resolves.toBeDefined();

    const dependency = path.join(fixture.root, "node_modules/dotenv/lib/main.js");
    await fs.rm(dependency);
    await fs.symlink("../cli.js", dependency);
    await expect(validate(fixture)).rejects.toThrow("发行文件不能是符号链接");
  });

  it("rejects runtime contract content that no longer matches its hash", async () => {
    const fixture = await createFixture();
    await fs.appendFile(path.join(fixture.root, "deploy/runtime-contract.json"), " \n");
    await expect(validate(fixture))
      .rejects.toThrow("发行文件校验失败：deploy/runtime-contract.json");
  });

  it("rejects a wrong runtime, architecture and source commit", async () => {
    const wrongRuntime = await createFixture();
    wrongRuntime.manifest.runtimeId = "other-runtime";
    await expect(validate(wrongRuntime)).rejects.toThrow("发行清单与当前迁移运行时不一致");

    const wrongArch = await createFixture();
    await expect(validate(wrongArch, { arch: "arm64" }))
      .rejects.toThrow("发行清单与当前迁移运行时不一致");

    const wrongCommit = await createFixture();
    wrongCommit.manifest.sourceCommit = "not-a-commit";
    await expect(validate(wrongCommit)).rejects.toThrow("sourceCommit");
  });

  it("rejects schema, version, Node and manifest platform drift", async () => {
    const mutations: Array<(manifest: Awaited<ReturnType<typeof createFixture>>["manifest"]) => void> = [
      (manifest) => { manifest.schemaVersion = 2; },
      (manifest) => { manifest.releaseVersion = "0.2.0"; },
      (manifest) => { manifest.nodeVersion = "24.17.0"; },
      (manifest) => { manifest.platform = "linux/arm64"; }
    ];
    for (const mutate of mutations) {
      const fixture = await createFixture();
      mutate(fixture.manifest);
      await expect(validate(fixture)).rejects.toThrow("发行清单与当前迁移运行时不一致");
    }
  });

  it("rejects locked component version drift", async () => {
    const fixture = await createFixture();
    fixture.manifest.components.lightpanda = "0.3.2";
    await expect(validate(fixture)).rejects.toThrow("发行清单与锁定组件版本不一致");
  });

  it("requires deterministic verification and both self-contained release architectures", async () => {
    const workflow = await fs.readFile(path.join(projectRoot, ".github/workflows/release.yml"), "utf8");
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("npm run test:visual");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("tag_name:");
    expect(workflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g)).toHaveLength(2);
    expect(workflow).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(workflow).toContain("kernel.unprivileged_userns_clone=1");
    expect(workflow).toContain("runner: ubuntu-24.04");
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain("platform: linux-amd64");
    expect(workflow).toContain("platform: linux-arm64");
    expect(workflow).toContain("npm run runtime:release -- --output=release");
    expect(workflow).toContain("Verify release artifact manifest");
    expect(workflow).toContain("maxBuffer:16*1024*1024");
    expect(workflow).toContain("softprops/action-gh-release@v2");
    expect(workflow).toContain("tag_name: ${{ env.RELEASE_TAG }}");
    expect(workflow).toContain("files: release/*");
    expect(workflow).not.toContain("run: node tooling/runtime/build-release.mjs --output=release");
    expect(workflow).not.toContain("user-test-evidence-");
    expect(workflow).not.toContain("release-gate --manifest");
    expect(workflow).not.toContain("materializeReleaseEvidenceFromGit");
    expect(pkg.scripts["runtime:release"]).toBe("node tooling/runtime/build-release.mjs");
  });

  it("materializes an exact root-only evidence tree without rewriting its bytes", async () => {
    const revision = "b".repeat(40);
    const report = `${JSON.stringify({ sourceRevision: revision, verdict: "pass" })}\n`;
    const manifest = `${JSON.stringify({
      schemaVersion: 1,
      suiteId: "release-0.3.0",
      sourceRevision: revision,
      cases: [{
        caseDocument: "../docs/user-tests/offline-release-first-run.md",
        reports: ["offline-release.sealed.json"],
        minimumIndependentRuns: 1
      }]
    })}\n`;
    const evidence = await createEvidenceCommit({
      "release-manifest.json": manifest,
      "offline-release.sealed.json": report
    });

    const result = await materializeReleaseEvidenceFromGit({
      root: evidence.root,
      evidenceCommit: evidence.commit,
      sourceCommit: revision
    });

    expect(result.files).toEqual(["offline-release.sealed.json", "release-manifest.json"]);
    await expect(fs.readFile(path.join(evidence.root, ".user-test-runs/release-manifest.json"), "utf8"))
      .resolves.toBe(manifest);
    await expect(fs.readFile(path.join(evidence.root, ".user-test-runs/offline-release.sealed.json"), "utf8"))
      .resolves.toBe(report);
    const mode = (await fs.stat(path.join(evidence.root, ".user-test-runs/offline-release.sealed.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    await expect(materializeReleaseEvidenceFromGit({
      root: evidence.root,
      evidenceCommit: evidence.commit,
      sourceCommit: revision
    })).rejects.toThrow("RELEASE_EVIDENCE_DESTINATION_EXISTS");
  });

  it.each([
    ["extra file", "extra"],
    ["symbolic link", "symlink"],
    ["nested tree", "nested"],
    ["parented evidence commit", "parent"],
    ["missing referenced report", "missing"],
    ["manifest revision drift", "manifest-revision"],
    ["report revision drift", "report-revision"]
  ])("rejects release evidence with %s", async (_label, failure) => {
    const revision = "c".repeat(40);
    const reportRevision = failure === "report-revision" ? "d".repeat(40) : revision;
    const reportName = failure === "missing" ? "missing.sealed.json" : "case.sealed.json";
    const manifestRevision = failure === "manifest-revision" ? "e".repeat(40) : revision;
    const files = {
      "release-manifest.json": `${JSON.stringify({
        schemaVersion: 1,
        suiteId: "release-0.3.0",
        sourceRevision: manifestRevision,
        cases: [{ caseDocument: "../docs/user-tests/template.md", reports: [reportName], minimumIndependentRuns: 1 }]
      })}\n`,
      [failure === "nested" ? "nested/case.sealed.json" : "case.sealed.json"]:
        `${JSON.stringify({ sourceRevision: reportRevision })}\n`,
      ...(failure === "extra" ? { "extra.txt": "extra\n" } : {})
    };
    const evidence = await createEvidenceCommit(
      files,
      failure === "symlink" ? { "case.sealed.json": "release-manifest.json" } : {},
      failure === "parent"
    );

    await expect(materializeReleaseEvidenceFromGit({
      root: evidence.root,
      evidenceCommit: evidence.commit,
      sourceCommit: revision
    })).rejects.toThrow(/RELEASE_EVIDENCE_/u);
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-integrity-"));
  fixtures.push(root);
  const contract = {
    schemaVersion: 3,
    runtimeId: "sunabot-qq-runtime",
    releaseVersion: "0.3.0",
    supportedPlatforms: ["linux/amd64", "linux/arm64"],
    nodeVersion: process.versions.node
  };
  for (const relative of RELEASE_PROTECTED_FILES) {
    if ([
      "deploy/runtime-contract.json",
      "components/component.lock.json",
      "package.json",
      "package-lock.json",
      "node_modules/.package-lock.json"
    ].includes(relative)) continue;
    await write(root, relative, `export const file = ${JSON.stringify(relative)};\n`);
  }
  await write(root, "deploy/runtime-contract.json", `${JSON.stringify(contract)}\n`);
  const components = {
    node: process.versions.node,
    lightpanda: "0.3.3",
    bubblewrap: "0.8.0-2+deb12u1",
    napcat: "4.15.0",
    codexCli: "0.139.0"
  };
  await write(root, "components/component.lock.json", `${JSON.stringify({
    schemaVersion: 1,
    components: {
      node: { version: components.node },
      lightpanda: { version: components.lightpanda },
      bubblewrap: { version: components.bubblewrap },
      napcat: { version: components.napcat },
      "codex-cli": { version: components.codexCli }
    }
  })}\n`);
  await write(root, "package.json", `${JSON.stringify({ version: "0.3.0" })}\n`);
  await write(root, "package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  await write(root, "node_modules/.package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  await write(root, "node_modules/dotenv/lib/main.js", "export const dotenv = true;\n");
  await write(root, "node_modules/dotenv/cli.js", "export const cli = true;\n");
  await fs.mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
  await fs.symlink("../dotenv/cli.js", path.join(root, "node_modules/.bin/dotenv"));
  await write(root, "dist/src/config.js", "export const config = true;\n");
  await write(root, "dist/adapters/sqlite/applicationDataStore.js", "export const store = true;\n");
  await write(root, "dist/services/media/attachments/chunks.js", "export const chunks = true;\n");
  await write(root, "tooling/runtime/transitive-helper.mjs", "export const helper = true;\n");
  await write(root, "apps/admin-web/dist/index.html", "<!doctype html><title>Sunabot</title>\n");
  await write(root, "codex-skills/workbench-config/SKILL.md", "# Workbench config\n");
  await write(root, "config/env.example", "SUNABOT_EXAMPLE=1\n");
  await write(root, "deploy/napcat/compose.yml", "services: {}\n");
  await write(root, "deploy/napcat/napcat-entrypoint.sh", "#!/bin/sh\nexit 0\n");
  await write(root, "deploy/native/bin/start-sunabot.sh", "#!/bin/sh\nexit 0\n");
  await write(root, "packages/platform/codexTokenRefresh.mjs", "export const refresh = true;\n");
  await write(root, "sources/lightpanda/source.tar.gz", "corresponding source\n");
  const manifest = await createReleaseManifest({
    root,
    runtimeId: contract.runtimeId,
    releaseVersion: contract.releaseVersion,
    platform: RELEASE_PLATFORM_ID,
    nodeVersion: contract.nodeVersion,
    sourceCommit,
    createdAt: "2026-07-14T00:00:00.000Z",
    components
  });
  return { root, manifest };
}

function validate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: { platform?: string; arch?: string; nodeVersion?: string } = {}
) {
  return validateReleaseManifest({
    root: fixture.root,
    manifest: fixture.manifest,
    platform: "linux",
    arch: "x64",
    nodeVersion: process.versions.node,
    ...overrides
  });
}

async function write(root: string, relative: string, content: string) {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

async function createEvidenceCommit(
  files: Record<string, string>,
  symlinks: Record<string, string> = {},
  withParent = false
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-evidence-"));
  fixtures.push(root);
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.name", "release-test"]);
  runGit(root, ["config", "user.email", "release-test@example.invalid"]);
  if (withParent) {
    await write(root, "parent.txt", "parent\n");
    runGit(root, ["add", "parent.txt"]);
    runGit(root, ["commit", "--quiet", "-m", "parent"]);
    await fs.rm(path.join(root, "parent.txt"));
  }
  for (const [relative, content] of Object.entries(files)) {
    if (relative in symlinks) continue;
    await write(root, relative, content);
  }
  for (const [relative, target] of Object.entries(symlinks)) {
    const destination = path.join(root, relative);
    await fs.rm(destination, { force: true });
    await fs.symlink(target, destination);
  }
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "-m", "evidence"]);
  return { root, commit: runGit(root, ["rev-parse", "HEAD"]).trim() };
}

function runGit(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
