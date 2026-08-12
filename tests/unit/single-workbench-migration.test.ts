// @vitest-environment node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySingleWorkbenchMigration,
  planSingleWorkbenchMigration,
  rollbackSingleWorkbenchMigration,
  verifySingleWorkbenchMigration
} from "../../tooling/migrations/upgrade-0.2.0-to-0.3.0.mjs";

const temporaryDirectories: string[] = [];
const root = fileURLToPath(new URL("../..", import.meta.url));
const versionCheck = async () => ({ package: "0.3.0", packageLock: "0.3.0", packageLockRoot: "0.3.0" });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("0.2.0 to 0.3.0 single Workbench migration", () => {
  it("runs the migration CLI through sunabot.sh without npm", () => {
    const result = spawnSync("sh", [path.join(root, "sunabot.sh"), "upgrade-0.3.0", "help"], {
      cwd: root,
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("./sunabot.sh upgrade-0.3.0 plan");
    expect(result.stdout).toContain("./sunabot.sh upgrade-0.3.0 rollback");
  });

  it("plans every source file without writing the workspace", async () => {
    const fixture = await workspaceFixture();
    await fs.writeFile(path.join(fixture.canonical, "shared.txt"), "canonical\n");
    await fs.writeFile(path.join(fixture.legacy, "shared.txt"), "legacy\n");
    const before = await treeSnapshot(fixture.workspace);

    const plan = await planSingleWorkbenchMigration({
      workspace: fixture.workspace,
      verifyTargetRelease: versionCheck
    });

    expect(plan).toMatchObject({
      ok: false,
      command: "plan",
      fromVersion: "0.2.0",
      targetVersion: "0.3.0",
      changesRequired: true,
      conflicts: [{ agentId: "plana", relativePath: "shared.txt", reason: "content_mismatch" }]
    });
    expect(await treeSnapshot(fixture.workspace)).toEqual(before);
  });

  it("reports conflicts before recovery creation and leaves both roots byte-identical", async () => {
    const fixture = await workspaceFixture();
    await fs.writeFile(path.join(fixture.canonical, "conflict.txt"), "canonical\n");
    await fs.writeFile(path.join(fixture.legacy, "conflict.txt"), "legacy\n");
    const resourcesBefore = await Promise.all([
      treeSnapshot(fixture.canonical),
      treeSnapshot(fixture.legacy)
    ]);
    const createRecoveryPoint = vi.fn();

    await expect(applySingleWorkbenchMigration({
      workspace: fixture.workspace,
      quiesced: true,
      assertNonRoot: () => undefined,
      verifyTargetRelease: versionCheck,
      createRecoveryPoint,
      now: new Date("2026-08-12T01:02:03.000Z")
    })).rejects.toMatchObject({
      code: "SINGLE_WORKBENCH_CONFLICT",
      report: expect.stringMatching(/conflicts-20260812010203-/u)
    });

    expect(createRecoveryPoint).not.toHaveBeenCalled();
    expect(await Promise.all([
      treeSnapshot(fixture.canonical),
      treeSnapshot(fixture.legacy)
    ])).toEqual(resourcesBefore);
  });

  it("merges missing and identical files, archives the old root, verifies, and rolls back", async () => {
    const fixture = await workspaceFixture();
    await fs.writeFile(path.join(fixture.canonical, "shared.txt"), "same\n");
    await fs.writeFile(path.join(fixture.legacy, "shared.txt"), "same\n");
    await fs.mkdir(path.join(fixture.legacy, "nested"));
    await fs.writeFile(path.join(fixture.legacy, "nested", "new.txt"), "new\n");
    await fs.mkdir(path.join(fixture.legacy, "native-workbench"));
    const canonicalBefore = await treeSnapshot(fixture.canonical);
    const legacyBefore = await treeSnapshot(fixture.legacy);
    const createRecoveryPoint = vi.fn(async (options: { backupsRoot: string }) => ({
      directory: path.join(options.backupsRoot, "before"),
      manifest: { schemaVersion: 5, databases: [], crossDatabaseInvariants: {} }
    }));
    const verifyWorkspaceDatabases = vi.fn(async () => ({ ok: true }));

    const applied = await applySingleWorkbenchMigration({
      workspace: fixture.workspace,
      quiesced: true,
      assertNonRoot: () => undefined,
      verifyTargetRelease: versionCheck,
      createRecoveryPoint,
      verifyWorkspaceDatabases,
      snapshotSqliteFiles: async () => [],
      now: new Date("2026-08-12T02:03:04.000Z")
    });

    expect(applied).toMatchObject({
      ok: true,
      command: "apply",
      sqliteUnchanged: true,
      archivedAgents: ["plana"]
    });
    await expect(fs.readFile(path.join(fixture.canonical, "nested", "new.txt"), "utf8"))
      .resolves.toBe("new\n");
    await expect(fs.lstat(fixture.legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(createRecoveryPoint).toHaveBeenCalledWith(expect.objectContaining({ quiesced: true }));
    expect(verifyWorkspaceDatabases).toHaveBeenCalledTimes(1);

    await expect(verifySingleWorkbenchMigration({
      workspace: fixture.workspace,
      recovery: applied.recovery
    })).resolves.toMatchObject({ ok: true, command: "verify", sqliteUnchangedAtApply: true });

    await expect(rollbackSingleWorkbenchMigration({
      workspace: fixture.workspace,
      recovery: applied.recovery,
      quiesced: true,
      assertNonRoot: () => undefined
    })).resolves.toMatchObject({ ok: true, command: "rollback", agents: ["plana"] });
    expect(await treeSnapshot(fixture.canonical)).toEqual(canonicalBefore);
    expect(await treeSnapshot(fixture.legacy)).toEqual(legacyBefore);
  });

  it("requires an explicit stopped-service confirmation", async () => {
    const fixture = await workspaceFixture();
    await expect(applySingleWorkbenchMigration({
      workspace: fixture.workspace,
      assertNonRoot: () => undefined,
      verifyTargetRelease: versionCheck
    })).rejects.toMatchObject({ code: "SINGLE_WORKBENCH_QUIESCENCE_REQUIRED" });
  });
});

async function workspaceFixture() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-single-workbench-")));
  temporaryDirectories.push(workspace);
  const agent = path.join(workspace, "business", "agents", "plana");
  const canonical = path.join(agent, "workbench");
  const legacy = path.join(agent, "docker-workbench");
  await Promise.all([
    fs.mkdir(path.join(canonical, "selfie"), { recursive: true }),
    fs.mkdir(path.join(canonical, "emoji"), { recursive: true }),
    fs.mkdir(path.join(canonical, "skills"), { recursive: true }),
    fs.mkdir(path.join(canonical, "knowledge"), { recursive: true }),
    fs.mkdir(legacy, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(canonical, "index.md"), "# 文件工作区\n"),
    fs.writeFile(path.join(canonical, "selfie", "references.jsonl"), ""),
    fs.writeFile(path.join(canonical, "emoji", "emojis.jsonl"), ""),
    fs.writeFile(path.join(canonical, "skills", "index.json"), "{\"schemaVersion\":1,\"skills\":[]}\n"),
    fs.writeFile(path.join(canonical, "knowledge", "index.json"), "{\"schemaVersion\":1,\"documents\":[]}\n")
  ]);
  return { workspace, canonical, legacy };
}

async function treeSnapshot(directory: string) {
  const entries: Array<{ path: string; kind: string; sha256?: string }> = [];
  const visit = async (current: string) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      const relativePath = path.relative(directory, target).split(path.sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        await visit(target);
      } else {
        const bytes = await fs.readFile(target);
        entries.push({
          path: relativePath,
          kind: "file",
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  };
  await visit(directory);
  return entries;
}
