// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyNativeWebfetchRendererGroup,
  isNativeWebfetchRendererCommand,
  listNativeWebfetchRendererProcessGroups,
  stopNativeWebfetchRendererProcessGroups
} from "../../tooling/runtime/native-webfetch-renderer-process.mjs";

describe("Native WebFetch Renderer process cleanup", () => {
  it("requires a Renderer command and the workspace marker on every group member", () => {
    const valid = classifyNativeWebfetchRendererGroup([{
      pid: 101,
      processGroup: 101,
      signature: "started",
      command: "node /cache/native-webfetch-renderer-supervisor.mjs",
      workspaceMatches: true
    }]);
    const foreign = classifyNativeWebfetchRendererGroup([{
      pid: 102,
      processGroup: 102,
      signature: "started",
      command: "node /cache/native-webfetch-renderer-supervisor.mjs",
      workspaceMatches: false
    }]);

    expect(valid).toMatchObject({ belongsToWorkspace: true, safeToSignal: true });
    expect(foreign).toMatchObject({ belongsToWorkspace: false, safeToSignal: false });
    expect(isNativeWebfetchRendererCommand("node /cache/dist/apps/webfetch-renderer/main.js")).toBe(true);
    expect(isNativeWebfetchRendererCommand("node /cache/unrelated.mjs")).toBe(false);
  });

  it("stops a residual Renderer group without touching a foreign process", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-native-renderer-process-"));
    const entry = path.join(fixture, "native-webfetch-renderer-supervisor.mjs");
    const workspaceId = "a".repeat(16);
    let owned: ChildProcess | undefined;
    let foreign: ChildProcess | undefined;
    try {
      await fs.writeFile(entry, "setInterval(() => {}, 1000);\n");
      owned = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID: workspaceId }
      });
      const foreignEnvironment = { ...process.env };
      delete foreignEnvironment.SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID;
      foreign = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: foreignEnvironment
      });
      await waitForProcess(owned);
      await waitForProcess(foreign);

      const groups = await waitForGroups(workspaceId, 1);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ processGroup: owned.pid, safeToSignal: true });
      await stopNativeWebfetchRendererProcessGroups({
        workspaceId,
        groups,
        timeoutMs: 2_000
      });

      await expectProcessStopped(owned.pid);
      expect(processExists(foreign.pid)).toBe(true);
      await expect(listNativeWebfetchRendererProcessGroups({ workspaceId })).resolves.toEqual([]);
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

async function waitForGroups(workspaceId: string, count: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const groups = await listNativeWebfetchRendererProcessGroups({ workspaceId });
    if (groups.length === count) return groups;
    await delay(50);
  }
  return listNativeWebfetchRendererProcessGroups({ workspaceId });
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
