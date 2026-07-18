// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectMultiAgentMigrationGate,
  MEMORY_PERSPECTIVE_MAINTENANCE_INTENT
} from "../../packages/platform/multiAgentMigrationGate.mjs";
import { initializeWorkspace } from "../../tooling/workspace/init-workspace.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("memory perspective maintenance startup gate", () => {
  it.each([
    ["valid", JSON.stringify({ schemaVersion: 1, state: "rollback-required" })],
    ["invalid", "not-json"]
  ])("blocks Core while a %s durable intent exists", async (_kind, content) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-maintenance-gate-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "ONEBOT_ACCESS_TOKEN=\n", "utf8");
    await initializeWorkspace({ root, workspace });
    const intentPath = path.join(workspace, MEMORY_PERSPECTIVE_MAINTENANCE_INTENT);
    await fs.writeFile(intentPath, `${content}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toMatchObject({
      code: "MEMORY_PERSPECTIVE_MAINTENANCE_BLOCKED"
    });
    await expect(initializeWorkspace({ root, workspace })).rejects.toMatchObject({
      code: "MEMORY_PERSPECTIVE_MAINTENANCE_BLOCKED"
    });

    await fs.rm(intentPath);
    await expect(inspectMultiAgentMigrationGate(workspace)).resolves.toMatchObject({ state: "trusted" });
  });

  it.each([
    ["awaiting-backup", /abort 安全取消/],
    ["staged-ready", /abort 安全取消/],
    ["installing", /重复 install 继续安装/],
    ["verifying", /执行 verify 完成验证/],
    ["rollback-required", /执行 rollback/],
    ["rollback-staged", /rollback 返回的 install 命令/],
    ["unexpected", /受控恢复流程/]
  ])("reports the legal recovery action for %s", async (state, expectedMessage) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-maintenance-action-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "ONEBOT_ACCESS_TOKEN=\n", "utf8");
    await initializeWorkspace({ root, workspace });
    await fs.writeFile(
      path.join(workspace, MEMORY_PERSPECTIVE_MAINTENANCE_INTENT),
      `${JSON.stringify({ schemaVersion: 1, state })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    await expect(inspectMultiAgentMigrationGate(workspace)).rejects.toThrow(expectedMessage);
  });
});
