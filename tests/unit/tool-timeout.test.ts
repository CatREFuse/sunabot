// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const processState = vi.hoisted(() => ({ timeout: 0 }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((
    _file: string,
    _args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
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
});

describe("tool call timeout", () => {
  it("fixes the reply chain and workspace Bash at 300 seconds", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-tool-timeout-"));

    await runWorkspaceBash({ command: "echo ok", timeoutMs: 1_000 }, temporaryRoot, {
      workspaceOnly: false
    });

    expect(TOOL_CALL_TIMEOUT_MS).toBe(300_000);
    expect(DIRECT_REPLY_TIMEOUT_MS).toBe(TOOL_CALL_TIMEOUT_MS);
    expect(processState.timeout).toBe(TOOL_CALL_TIMEOUT_MS);
    expect(workspaceBashTool.parameters.properties.timeoutMs.enum).toEqual([TOOL_CALL_TIMEOUT_MS, null]);
  });
});
