// @vitest-environment node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const cli = path.resolve("tooling/agents/soul-cli.mjs");

describe("soul CLI", () => {
  it("documents explicit Agent and path arguments", async () => {
    const result = await run(process.execPath, [cli, "help"]);
    expect(result.stdout).toContain("tooling/agents/soul-cli.mjs export --agent <id> --output");
    expect(result.stdout).toContain("tooling/agents/soul-cli.mjs inspect --agent <id> --input");
    expect(result.stdout).toContain("tooling/agents/soul-cli.mjs import --agent <id> --input");
    expect(result.stdout).toContain("密码仅通过交互式终端读取");
  });

  it("rejects missing Agent IDs and password arguments before connecting", async () => {
    await expect(run(process.execPath, [cli, "inspect", "--input", "x.sunabot-soul.json"]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("--agent 需要合法的 Agent ID") });
    await expect(run(process.execPath, [cli, "export", "--agent", "arona", "--output", "x.sunabot-soul.json", "--password", "secret"]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("不支持的参数：--password") });
  });

  it("rejects non-loopback API addresses before reading credentials", async () => {
    await expect(run(process.execPath, [cli, "inspect", "--agent", "arona", "--input", "x.sunabot-soul.json"], {
      env: { ...process.env, SUNABOT_ADMIN_URL: "https://admin.example.com" }
    })).rejects.toMatchObject({ stderr: expect.stringContaining("必须是本机回环管理地址") });
  });
});
