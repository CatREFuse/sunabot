// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("empty workspace first-run flow", () => {
  it("covers admin access, explicit Provider choice, Agent/QQ setup, pre-scan state, and the first reply", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-first-run-e2e-")));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(root, "tests/fixtures/first-run-flow.ts")
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        VITEST: "",
        NODE_ENV: "test",
        SUNABOT_WORKSPACE: workspace,
        SUNABOT_CONFIG: path.join(workspace, "business/config/sunabot.json"),
        ONEBOT_ACCESS_TOKEN: "first-run-onebot-token",
        FIRST_RUN_PROVIDER_KEY: "first-run-provider-key",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("SUNABOT_FIRST_RUN_E2E="));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice("SUNABOT_FIRST_RUN_E2E=".length))).toEqual({
      adminAuthenticated: true,
      providerId: "first-run-provider",
      providerRequests: 1,
      providerRequestsBeforeEnable: 0,
      agentId: "arona",
      accountRuntime: "running",
      qqOnlineBeforeScan: false,
      qqOnlineAfterConnect: true,
      firstInboundReplyEnabled: false,
      repliesBeforeEnable: 0,
      firstReplyDelivered: 1,
      journalCompleted: true
    });
  }, 35_000);
});
