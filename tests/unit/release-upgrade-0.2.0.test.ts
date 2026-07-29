// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_RELEASE_VERSION, RELEASE_CATALOG } from "../../packages/platform/releaseCatalog.js";
import {
  applyReleaseUpgrade,
  planReleaseUpgrade,
  verifyTargetRelease
} from "../../tooling/migrations/upgrade-0.1.4-to-0.2.0.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("0.1.4 to 0.2.0 release upgrade", () => {
  it("keeps every current release version entry and changelog on 0.2.0", async () => {
    await expect(verifyTargetRelease(root)).resolves.toEqual({
      package: "0.2.0",
      packageLock: "0.2.0",
      packageLockRoot: "0.2.0",
      runtimeContract: "0.2.0",
      releaseCatalog: "0.2.0",
      dockerfile: "0.2.0",
      compose: "0.2.0"
    });
    expect(CURRENT_RELEASE_VERSION).toBe("0.2.0");
    expect(RELEASE_CATALOG.currentVersion).toBe("0.2.0");
    expect(RELEASE_CATALOG.releases[0]?.version).toBe("0.2.0");
    expect(RELEASE_CATALOG.releases.filter((release) => release.version === "0.2.0"))
      .toHaveLength(1);
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"))
      .toContain("## [0.2.0] - 2026-07-29");
  });

  it("plans without writing workspace data and reports no data migration", async () => {
    const workspace = await workspaceFixture();
    const before = await directorySnapshot(workspace);

    await expect(planReleaseUpgrade({ projectRoot: root, workspace })).resolves.toMatchObject({
      ok: true,
      command: "plan",
      fromVersion: "0.1.4",
      targetVersion: "0.2.0",
      changesRequired: true,
      promptMigration: false,
      databaseMigration: false,
      resourceMigration: false
    });
    expect(await directorySnapshot(workspace)).toEqual(before);
  });

  it("stops, creates a recovery point, starts, then runs status and doctor", async () => {
    const workspace = await workspaceFixture();
    const events: string[] = [];
    const result = await applyReleaseUpgrade({
      projectRoot: root,
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
      fromVersion: "0.1.4",
      targetVersion: "0.2.0",
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
    const workspace = await workspaceFixture();
    const events: string[] = [];

    await expect(applyReleaseUpgrade({
      projectRoot: root,
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
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-0.2.0-"));
  temporaryDirectories.push(workspace);
  const configPath = path.join(workspace, "business", "config", "sunabot.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}\n");
  return fs.realpath(workspace);
}

async function directorySnapshot(directory: string) {
  const entries: Array<{ path: string; size: number; modified: number }> = [];
  const visit = async (current: string) => {
    for (const name of (await fs.readdir(current)).sort()) {
      const target = path.join(current, name);
      const stats = await fs.lstat(target);
      entries.push({
        path: path.relative(directory, target),
        size: stats.size,
        modified: stats.mtimeMs
      });
      if (stats.isDirectory()) await visit(target);
    }
  };
  await visit(directory);
  return entries;
}
