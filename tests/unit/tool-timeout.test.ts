// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const processState = vi.hoisted(() => ({ timeout: 0, calls: 0, file: "", args: [] as string[] }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((
    file: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    processState.calls += 1;
    processState.file = file;
    processState.args = args;
    processState.timeout = options.timeout ?? 0;
    queueMicrotask(() => callback(null, "ok", ""));
    return {};
  })
}));

import { runWorkspaceBash, workspaceBashTool } from "../../services/tools/bashTool.js";
import { DIRECT_REPLY_TIMEOUT_MS } from "../../src/runtime.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
  processState.timeout = 0;
  processState.calls = 0;
  processState.file = "";
  processState.args = [];
});

describe("tool call timeout", () => {
  it("fixes the reply chain and workspace Bash at 300 seconds", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-tool-timeout-"));

    await runWorkspaceBash({ command: "echo ok", timeoutMs: 1_000 }, temporaryRoot, {
      workspaceOnly: false,
      sandbox: {
        platform: "linux",
        executable: "/fixture/bwrap",
        access: async () => undefined,
        probe: async () => undefined
      }
    });

    expect(TOOL_CALL_TIMEOUT_MS).toBe(300_000);
    expect(DIRECT_REPLY_TIMEOUT_MS).toBe(TOOL_CALL_TIMEOUT_MS);
    expect(processState.timeout).toBe(TOOL_CALL_TIMEOUT_MS);
    expect(processState.file).toBe("/fixture/bwrap");
    expect(processState.args).toEqual(expect.arrayContaining(["--ro-bind", "/", "/", "--cap-drop", "ALL"]));
    expect(workspaceBashTool.parameters.properties.timeoutMs.enum).toEqual([TOOL_CALL_TIMEOUT_MS, null]);
  });

  it("does not execute plain Bash when isolation is unavailable", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-tool-isolation-"));

    const result = await runWorkspaceBash({ command: "echo must-not-run", timeoutMs: null }, temporaryRoot, {
      workspaceOnly: false,
      sandbox: {
        platform: "linux",
        access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
      }
    });

    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect(result.stderr).toContain("BASH_ISOLATION_UNAVAILABLE");
    expect(processState.calls).toBe(0);
  });
});
