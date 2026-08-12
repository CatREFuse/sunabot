// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_CATALOG } from "../../packages/platform/releaseCatalog.js";
import {
  applyReleaseUpgrade,
  planReleaseUpgrade
} from "../../tooling/migrations/upgrade-0.1.2-to-0.1.3.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("0.1.2 to 0.1.3 release upgrade", () => {
  it("keeps the historical release catalog and changelog entry", async () => {
    expect(RELEASE_CATALOG.releases.filter((release) => release.version === "0.1.3"))
      .toHaveLength(1);
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"))
      .toContain("## [0.1.3] - 2026-07-25");
  });

  it("plans without writing workspace data and reports only the prompt migration", async () => {
    const workspace = await workspaceFixture();
    const projectRoot = await releaseProjectFixture();
    const before = await directorySnapshot(workspace);

    await expect(planReleaseUpgrade({ projectRoot, workspace })).resolves.toMatchObject({
      ok: true,
      command: "plan",
      fromVersion: "0.1.2",
      targetVersion: "0.1.3",
      changesRequired: true,
      promptMigration: {
        id: "conversation-chat-media-v2",
        mode: "startup-preserving",
        backupPolicy: "once"
      },
      databaseMigration: false,
      resourceMigration: false
    });
    expect(await directorySnapshot(workspace)).toEqual(before);
  });

  it("stops, creates a recovery point, starts, then runs status and doctor", async () => {
    const workspace = await workspaceFixture();
    const projectRoot = await releaseProjectFixture();
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
      fromVersion: "0.1.2",
      targetVersion: "0.1.3",
      promptMigration: {
        id: "conversation-chat-media-v2",
        appliedBy: "runtime-startup"
      },
      runtime: {
        started: true,
        status: "passed",
        doctor: "passed"
      }
    });
  });

  it("keeps the service stopped when recovery point creation fails", async () => {
    const workspace = await workspaceFixture();
    const projectRoot = await releaseProjectFixture();
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
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-0.1.3-"));
  temporaryDirectories.push(workspace);
  const configPath = path.join(workspace, "business", "config", "sunabot.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}\n");
  return fs.realpath(workspace);
}

async function releaseProjectFixture() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-code-0.1.3-"));
  temporaryDirectories.push(projectRoot);
  await Promise.all([
    writeFixture(projectRoot, "package.json", JSON.stringify({ version: "0.1.3" })),
    writeFixture(projectRoot, "package-lock.json", JSON.stringify({
      version: "0.1.3",
      packages: { "": { version: "0.1.3" } }
    })),
    writeFixture(projectRoot, "deploy/runtime-contract.json", JSON.stringify({
      releaseVersion: "0.1.3"
    })),
    writeFixture(
      projectRoot,
      "packages/platform/releaseCatalog.ts",
      'export const CURRENT_RELEASE_VERSION = "0.1.3";\n'
    ),
    writeFixture(
      projectRoot,
      "deploy/docker/Dockerfile",
      "ARG SUNABOT_RELEASE_VERSION=0.1.3\n"
    ),
    writeFixture(
      projectRoot,
      "deploy/docker/compose.yml",
      "SUNABOT_RELEASE_VERSION: ${SUNABOT_RELEASE_VERSION:-0.1.3}\n"
    )
  ]);
  return fs.realpath(projectRoot);
}

async function writeFixture(projectRoot: string, relativePath: string, content: string) {
  const target = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
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
