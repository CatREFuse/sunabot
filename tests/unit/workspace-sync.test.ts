// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const script = path.resolve("tooling/workspace/sync-workspace.mjs");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("workspace encrypted snapshots", () => {
  it("backs up and restores only the selected business tier", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const sync = path.join(root, "sync");
    const key = path.join(root, "keys/business.key");
    await write(path.join(source, "business/config/sunabot.json"), "{}\n");
    await write(path.join(source, "cache/must-not-be-backed-up.txt"), "cache\n");
    await run("init-key", "--tier", "business", "--key-file", key, "--workspace", source);
    await run("push", "--tier", "business", "--key-file", key, "--sync-dir", sync, "--workspace", source);

    await expect(fs.access(path.join(sync, "sunabot-business.latest.enc"))).resolves.toBeUndefined();
    await run("pull", "--tier", "business", "--key-file", key, "--sync-dir", sync, "--workspace", destination);
    await expect(fs.readFile(path.join(destination, "business/config/sunabot.json"), "utf8"))
      .resolves.toBe("{}\n");
    await expect(fs.access(path.join(destination, "cache/must-not-be-backed-up.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("requires a separate key for secret snapshots", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const sync = path.join(root, "sync");
    const key = path.join(root, "keys/business.key");
    await write(path.join(workspace, "secrets/runtime.env"), "TEST_ONLY=value\n");
    await run("init-key", "--tier", "business", "--key-file", key, "--workspace", workspace);

    await expect(run("push", "--tier", "secrets", "--key-file", key, "--sync-dir", sync, "--workspace", workspace, {
      SUNABOT_SYNC_KEY_FILE: key
    })).rejects.toThrow(/独立于 business/);
  }, 20_000);
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-sync-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function run(action: string, ...argumentsAndMaybeEnvironment: Array<string | NodeJS.ProcessEnv>) {
  const maybeEnvironment = argumentsAndMaybeEnvironment.at(-1);
  const environment = typeof maybeEnvironment === "object" ? argumentsAndMaybeEnvironment.pop() as NodeJS.ProcessEnv : {};
  const argumentsList = argumentsAndMaybeEnvironment as string[];
  return execFileAsync(process.execPath, [script, action, ...argumentsList], {
    cwd: path.dirname(path.dirname(path.dirname(script))),
    env: { ...process.env, ...environment },
    windowsHide: true,
    timeout: 15_000
  });
}
