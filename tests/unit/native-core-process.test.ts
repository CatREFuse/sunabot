// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyNativeCoreGroup,
  isNativeCoreCommand,
  listNativeCoreProcessGroups,
  stopNativeCoreProcessGroups
} from "../../tooling/runtime/native-core-process.mjs";

describe("native Core workspace process cleanup", () => {
  it("requires a matching Core command and workspace environment on every process-group member", () => {
    const root = "/srv/sunabot";
    const valid = classifyNativeCoreGroup([{
      pid: 101,
      processGroup: 101,
      signature: "started",
      command: "node /srv/sunabot/dist/apps/api/main.js",
      environmentMatchesWorkspace: true
    }], { root, workspace: "/srv/sunabot/workspace" });
    const foreign = classifyNativeCoreGroup([{
      pid: 102,
      processGroup: 102,
      signature: "started",
      command: "node /srv/sunabot/dist/apps/api/main.js",
      environmentMatchesWorkspace: false
    }], { root, workspace: "/srv/sunabot/workspace" });

    expect(valid).toMatchObject({ belongsToWorkspace: true, safeToSignal: true });
    expect(foreign).toMatchObject({ belongsToWorkspace: false, safeToSignal: false });
    expect(isNativeCoreCommand("npm run dev", root)).toBe(true);
    expect(isNativeCoreCommand("node /srv/other/dist/apps/api/main.js", root)).toBe(false);
  });

  it("stops only the matching workspace process group", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-native-core-process-"));
    const workspace = path.join(fixture, "workspace");
    const entry = path.join(fixture, "dist/apps/api/main.js");
    let owned: ChildProcess | undefined;
    let foreign: ChildProcess | undefined;
    try {
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(entry, "setInterval(() => {}, 1000);\n");
      owned = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SUNABOT_WORKSPACE: workspace }
      });
      const foreignEnvironment = { ...process.env };
      delete foreignEnvironment.SUNABOT_WORKSPACE;
      foreign = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: foreignEnvironment
      });
      await waitForProcess(owned);
      await waitForProcess(foreign);

      const groups = await waitForGroups(fixture, workspace, 1);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ processGroup: owned.pid, safeToSignal: true });
      await stopNativeCoreProcessGroups({ root: fixture, workspace, groups, timeoutMs: 2_000 });

      await expectProcessStopped(owned.pid);
      expect(processExists(foreign.pid)).toBe(true);
      await expect(listNativeCoreProcessGroups({ root: fixture, workspace })).resolves.toEqual([]);
    } finally {
      stopTestProcess(owned?.pid);
      stopTestProcess(foreign?.pid);
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitForProcess(child: ChildProcess) {
  if (!child.pid) throw new Error("test process has no PID");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (processExists(child.pid)) return;
    await delay(25);
  }
  throw new Error(`test process ${child.pid} did not start`);
}

async function waitForGroups(root: string, workspace: string, count: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const groups = await listNativeCoreProcessGroups({ root, workspace });
    if (groups.length === count) return groups;
    await delay(50);
  }
  return listNativeCoreProcessGroups({ root, workspace });
}

async function expectProcessStopped(pid: number | undefined) {
  if (!pid) throw new Error("test process has no PID");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(25);
  }
  expect(processExists(pid)).toBe(false);
}

function processExists(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stopTestProcess(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
