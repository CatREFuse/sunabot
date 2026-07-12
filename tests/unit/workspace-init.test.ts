// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeWorkspace } from "../../tooling/workspace/init-workspace.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("workspace initialization", () => {
  it("creates the current layout with private directory and secret permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "ONEBOT_ACCESS_TOKEN=\n", "utf8");

    const result = await initializeWorkspace({ root, workspace });

    expect(result.workspace).toBe(workspace);
    await expect(fs.access(path.join(workspace, "business/agents/plana/selfie"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, "runtime/napcat/config-full"))).resolves.toBeUndefined();
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "business"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "runtime"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(workspace, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(result.runtimeEnv)).mode & 0o777).toBe(0o600);
  });

  it("preserves existing runtime secrets while repairing their permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workspace-init-existing-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const runtimeEnv = path.join(workspace, "secrets/runtime.env");
    await fs.mkdir(path.dirname(runtimeEnv), { recursive: true });
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config/env.example"), "EXAMPLE=1\n", "utf8");
    await fs.writeFile(runtimeEnv, "PRIVATE=value\n", { mode: 0o644 });

    await initializeWorkspace({ root, workspace });

    await expect(fs.readFile(runtimeEnv, "utf8")).resolves.toBe("PRIVATE=value\n");
    expect((await fs.stat(runtimeEnv)).mode & 0o777).toBe(0o600);
  });
});
