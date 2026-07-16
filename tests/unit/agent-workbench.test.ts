// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAgentWorkbench,
  resolveAgentWorkbenchFile
} from "../../services/agents/agentWorkbench.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Agent workbench paths", () => {
  it("creates one workbench below the current Agent workspace", async () => {
    const agentWorkspace = await temporaryDirectory("sunabot-agent-");

    await expect(resolveAgentWorkbench(agentWorkspace)).resolves.toBe(path.join(await fs.realpath(agentWorkspace), "workbench"));
  });

  it("creates a missing Agent workspace below an existing trusted parent", async () => {
    const parent = await temporaryDirectory("sunabot-agent-parent-");
    const agentWorkspace = path.join(parent, "agents", "agent-a");

    await expect(resolveAgentWorkbench(agentWorkspace)).resolves.toBe(
      path.join(await fs.realpath(parent), "agents", "agent-a", "workbench")
    );
    await expect(fs.lstat(agentWorkspace)).resolves.toMatchObject({});
  });

  it("rejects an Agent workspace symlink to another Agent", async () => {
    const parent = await temporaryDirectory("sunabot-agent-parent-");
    const agentB = path.join(parent, "agent-b");
    const agentA = path.join(parent, "agent-a");
    await fs.mkdir(agentB);
    await fs.symlink(agentB, agentA);

    await expect(resolveAgentWorkbench(agentA)).rejects.toThrow("AGENT_WORKBENCH_INVALID");
    await expect(fs.stat(path.join(agentB, "workbench"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves an existing relative file inside workbench", async () => {
    const agentWorkspace = await temporaryDirectory("sunabot-agent-");
    const workbench = await resolveAgentWorkbench(agentWorkspace);
    await fs.mkdir(path.join(workbench, "reports"), { recursive: true });
    await fs.writeFile(path.join(workbench, "reports", "status.txt"), "ok");

    await expect(resolveAgentWorkbenchFile(agentWorkspace, "reports/status.txt"))
      .resolves.toBe(path.join(workbench, "reports", "status.txt"));
  });

  it.each(["/etc/passwd", "../secret", "reports/../../secret"])("rejects an escaping path: %s", async (requested) => {
    const agentWorkspace = await temporaryDirectory("sunabot-agent-");

    await expect(resolveAgentWorkbenchFile(agentWorkspace, requested)).rejects.toThrow("AGENT_WORKBENCH_PATH_INVALID");
  });

  it("rejects a workbench symlink", async () => {
    const agentWorkspace = await temporaryDirectory("sunabot-agent-");
    const outside = await temporaryDirectory("sunabot-outside-");
    await fs.symlink(outside, path.join(agentWorkspace, "workbench"));

    await expect(resolveAgentWorkbench(agentWorkspace)).rejects.toThrow("AGENT_WORKBENCH_INVALID");
  });

  it("rejects a file symlink that escapes workbench", async () => {
    const agentWorkspace = await temporaryDirectory("sunabot-agent-");
    const outside = await temporaryDirectory("sunabot-outside-");
    const workbench = await resolveAgentWorkbench(agentWorkspace);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workbench, "secret.txt"));

    await expect(resolveAgentWorkbenchFile(agentWorkspace, "secret.txt")).rejects.toThrow("AGENT_WORKBENCH_PATH_INVALID");
  });
});

async function temporaryDirectory(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
