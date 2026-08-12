// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_CATALOG } from "../../packages/platform/releaseCatalog.js";
import {
  applyReleaseUpgrade,
  planReleaseUpgrade,
  verifyTargetRelease
} from "../../tooling/migrations/upgrade-0.1.3-to-0.1.4.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("0.1.3 to 0.1.4 release upgrade", () => {
  it("keeps the 0.1.4 release entry and changelog", async () => {
    const projectRoot = await releaseFixture();
    await expect(verifyTargetRelease(projectRoot)).resolves.toEqual({
      package: "0.1.4",
      packageLock: "0.1.4",
      packageLockRoot: "0.1.4",
      runtimeContract: "0.1.4",
      releaseCatalog: "0.1.4",
      dockerfile: "0.1.4",
      compose: "0.1.4"
    });
    expect(RELEASE_CATALOG.releases.filter((release) => release.version === "0.1.4"))
      .toHaveLength(1);
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"))
      .toContain("## [0.1.4] - 2026-07-28");
  });

  it("plans without writing workspace data and reports no data migration", async () => {
    const projectRoot = await releaseFixture();
    const workspace = await workspaceFixture();
    const before = await directorySnapshot(workspace);

    await expect(planReleaseUpgrade({ projectRoot, workspace })).resolves.toMatchObject({
      ok: true,
      command: "plan",
      fromVersion: "0.1.3",
      targetVersion: "0.1.4",
      changesRequired: true,
      promptMigration: false,
      databaseMigration: false,
      resourceMigration: false
    });
    expect(await directorySnapshot(workspace)).toEqual(before);
  });

  it("stops, creates a recovery point, starts, then runs status and doctor", async () => {
    const projectRoot = await releaseFixture();
    const workspace = await workspaceFixture();
    const events: string[] = [];
    const result = await applyReleaseUpgrade({
      projectRoot,
      workspace,
      assertNonRoot: () => undefined,
      runCommand: async (_command: string, args: string[]) => {
        events.push(args[0]);
      },
      createRecoveryPoint: async () => {
        events.push("backup");
        return { directory: path.join(workspace, "backups", "sqlite-recovery", "fixture") };
      }
    });

    expect(events).toEqual(["down", "backup", "up", "status", "doctor"]);
    expect(result).toMatchObject({
      ok: true,
      command: "apply",
      fromVersion: "0.1.3",
      targetVersion: "0.1.4",
      promptMigration: false,
      databaseMigration: false,
      resourceMigration: false,
      runtime: {
        started: true,
        status: "passed",
        doctor: "passed"
      }
    });
  });

  it("keeps the service stopped when recovery point creation fails", async () => {
    const projectRoot = await releaseFixture();
    const workspace = await workspaceFixture();
    const events: string[] = [];

    await expect(applyReleaseUpgrade({
      projectRoot,
      workspace,
      assertNonRoot: () => undefined,
      runCommand: async (_command: string, args: string[]) => {
        events.push(args[0]);
      },
      createRecoveryPoint: async () => {
        events.push("backup");
        throw new Error("fixture failure");
      }
    })).rejects.toMatchObject({
      code: "RELEASE_UPGRADE_FAILED",
      serviceMayBeStopped: true,
      message: expect.stringContaining("服务保持停止")
    });
    expect(events).toEqual(["down", "backup"]);
  });
});

async function workspaceFixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-0.1.4-"));
  temporaryDirectories.push(workspace);
  const configPath = path.join(workspace, "business", "config", "sunabot.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}\n");
  return fs.realpath(workspace);
}

async function releaseFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-source-0.1.4-"));
  temporaryDirectories.push(directory);
  await Promise.all([
    writeJson(path.join(directory, "package.json"), { version: "0.1.4" }),
    writeJson(path.join(directory, "package-lock.json"), {
      version: "0.1.4",
      packages: { "": { version: "0.1.4" } }
    }),
    writeJson(path.join(directory, "deploy/runtime-contract.json"), { releaseVersion: "0.1.4" }),
    writeText(
      path.join(directory, "packages/platform/releaseCatalog.ts"),
      'export const CURRENT_RELEASE_VERSION = "0.1.4";\n'
    ),
    writeText(
      path.join(directory, "deploy/docker/Dockerfile"),
      "ARG SUNABOT_RELEASE_VERSION=0.1.4\n"
    ),
    writeText(
      path.join(directory, "deploy/docker/compose.yml"),
      "SUNABOT_RELEASE_VERSION: ${SUNABOT_RELEASE_VERSION:-0.1.4}\n"
    )
  ]);
  return directory;
}

async function writeJson(filePath: string, value: unknown) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

async function directorySnapshot(directory: string) {
  const entries: Array<{ path: string; size: number; modified: number }> = [];
  const visit = async (current: string) => {
    for (const name of (await fs.readdir(current)).sort()) {
      const target = path.join(current, name);
      const stats = await fs.lstat(target);
      const relative = path.relative(directory, target);
      entries.push({
        path: relative,
        size: stats.size,
        modified: stats.mtimeMs
      });
      if (stats.isDirectory()) await visit(target);
    }
  };
  await visit(directory);
  return entries;
}
