// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCleanSourceStatus,
  assertReleaseBuildPlatform,
  createReleaseManifest,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM_ID,
  RELEASE_PROTECTED_FILES,
  validateReleaseManifest
} from "../../tooling/runtime/release-integrity.mjs";

const fixtures: string[] = [];
const sourceCommit = "a".repeat(40);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe("Native release integrity", () => {
  it("accepts only a clean linux/x64 source build", () => {
    expect(() => assertCleanSourceStatus("")).not.toThrow();
    expect(() => assertCleanSourceStatus(" M src/runtime.ts\n"))
      .toThrow("Git 工作树");
    expect(() => assertReleaseBuildPlatform("linux", "x64")).not.toThrow();
    expect(() => assertReleaseBuildPlatform("linux", "arm64"))
      .toThrow("linux/arm64");
    expect(() => assertReleaseBuildPlatform("darwin", "x64"))
      .toThrow("darwin/x64");
  });

  it("binds the runtime contract and complete executable migration tree", async () => {
    const fixture = await createFixture();
    expect(RELEASE_PROTECTED_FILES).toEqual(expect.arrayContaining([
      "tooling/shared/paths.mjs",
      "tooling/runtime/launcher-core.mjs",
      "tooling/workspace/sqlite-recovery.mjs",
      "package-lock.json",
      "node_modules/.package-lock.json"
    ]));
    expect(fixture.manifest.schemaVersion).toBe(RELEASE_MANIFEST_SCHEMA_VERSION);
    expect(fixture.manifest.platform).toBe(RELEASE_PLATFORM_ID);
    expect(fixture.manifest.runtimeContractSha256)
      .toBe(fixture.manifest.integrity.files["deploy/runtime-contract.json"]);
    expect(Object.keys(fixture.manifest.integrity.files)).toEqual(expect.arrayContaining([
      "packages/platform/multiAgentMigrationGate.mjs",
      "tooling/shared/paths.mjs",
      "tooling/migrations/migrate-single-agent-to-multi-agent.mjs",
      "tooling/migrations/migrate-to-sqlite.mjs",
      "tooling/runtime/launcher-core.mjs",
      "tooling/runtime/transitive-helper.mjs",
      "tooling/workspace/sqlite-recovery.mjs",
      "dist/src/config.js",
      "dist/adapters/sqlite/applicationDataStore.js",
      "dist/services/media/attachments/chunks.js",
      "node_modules/dotenv/lib/main.js"
    ]));
    expect(Object.keys(fixture.manifest.integrity.files).some((relative) => relative.includes("/.bin/")))
      .toBe(false);

    await expect(validate(fixture)).resolves.toMatchObject({
      contract: { runtimeId: "sunabot-qq-runtime" },
      packageManifest: { version: "0.1.0" }
    });
  });

  it.each([
    ["migration entry", "tooling/migrations/migrate-single-agent-to-multi-agent.mjs"],
    ["platform gate", "packages/platform/multiAgentMigrationGate.mjs"],
    ["project root resolver", "tooling/shared/paths.mjs"],
    ["launcher contract helper", "tooling/runtime/launcher-core.mjs"],
    ["recovery implementation", "tooling/workspace/sqlite-recovery.mjs"],
    ["tooling tree member", "tooling/runtime/transitive-helper.mjs"],
    ["prebuilt dependency", "dist/src/config.js"],
    ["installed production dependency", "node_modules/dotenv/lib/main.js"],
    ["root dependency lock", "package-lock.json"],
    ["installed dependency lock", "node_modules/.package-lock.json"]
  ])("rejects tampering in the %s", async (_name, relative) => {
    const fixture = await createFixture();
    await fs.appendFile(path.join(fixture.root, relative), "tampered\n");
    await expect(validate(fixture)).rejects.toThrow(`发行文件校验失败：${relative}`);
  });

  it.each([
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
    await expect(validate(wrongArch, { arch: "arm64" })).rejects.toThrow("linux/arm64");

    const wrongCommit = await createFixture();
    wrongCommit.manifest.sourceCommit = "not-a-commit";
    await expect(validate(wrongCommit)).rejects.toThrow("sourceCommit");
  });

  it("rejects schema, version, Node and manifest platform drift", async () => {
    const mutations: Array<(manifest: Awaited<ReturnType<typeof createFixture>>["manifest"]) => void> = [
      (manifest) => { manifest.schemaVersion = 1; },
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
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-integrity-"));
  fixtures.push(root);
  const contract = {
    schemaVersion: 2,
    runtimeId: "sunabot-qq-runtime",
    releaseVersion: "0.1.0",
    supportedPlatforms: [RELEASE_PLATFORM_ID],
    nodeVersion: process.versions.node
  };
  for (const relative of RELEASE_PROTECTED_FILES) {
    if ([
      "deploy/runtime-contract.json",
      "package.json",
      "package-lock.json",
      "node_modules/.package-lock.json"
    ].includes(relative)) continue;
    await write(root, relative, `export const file = ${JSON.stringify(relative)};\n`);
  }
  await write(root, "deploy/runtime-contract.json", `${JSON.stringify(contract)}\n`);
  await write(root, "package.json", `${JSON.stringify({ version: "0.1.0" })}\n`);
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
  const manifest = await createReleaseManifest({
    root,
    runtimeId: contract.runtimeId,
    releaseVersion: contract.releaseVersion,
    platform: RELEASE_PLATFORM_ID,
    nodeVersion: contract.nodeVersion,
    sourceCommit,
    createdAt: "2026-07-14T00:00:00.000Z"
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
