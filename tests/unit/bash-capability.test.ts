// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeToolCapabilityResolver,
  createWorkspaceBashCapabilityProbe
} from "../../services/tools/bashCapability.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace Bash capability probe", () => {
  it("reports macOS Native Bash available after the audited host shell probe succeeds", async () => {
    const access = vi.fn(async () => undefined);
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      sandbox: { effectiveUid: 501, access, probe }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({ available: true });
    expect(access).toHaveBeenCalledWith("/bin/bash", expect.any(Number));
    expect(probe).toHaveBeenCalledWith("/bin/bash", ["--noprofile", "--norc", "-lc", ":"]);
  });

  it("keeps a successful namespace lease without periodic reprobes", async () => {
    let currentTime = 1_000;
    const probe = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("namespace unavailable"));
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      ttlMs: 30_000,
      now: () => currentTime,
      sandbox: {
        effectiveUid: 1_000,
        executable: "/fixture/bwrap",
        access: vi.fn(async () => undefined),
        probe
      }
    });
    const agentWorkspace = await createAgentWorkspace();

    await expect(capability(agentWorkspace)).resolves.toEqual({ available: true });
    await expect(capability(agentWorkspace)).resolves.toEqual({ available: true });
    expect(probe).toHaveBeenCalledOnce();

    currentTime += 30_001;
    await expect(capability(agentWorkspace)).resolves.toEqual({ available: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("retries a failed capability probe after the bounded recovery window", async () => {
    let currentTime = 1_000;
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error("namespace unavailable"))
      .mockResolvedValueOnce(undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      ttlMs: 3_000,
      now: () => currentTime,
      sandbox: {
        effectiveUid: 1_000,
        executable: "/fixture/bwrap",
        access: vi.fn(async () => undefined),
        probe
      }
    });
    const agentWorkspace = await createAgentWorkspace();

    await expect(capability(agentWorkspace)).resolves.toMatchObject({ available: false });
    await expect(capability(agentWorkspace)).resolves.toMatchObject({ available: false });
    expect(probe).toHaveBeenCalledOnce();
    currentTime += 3_001;
    await expect(capability(agentWorkspace)).resolves.toEqual({ available: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports Linux Native Bash unavailable when the hard process limiter is missing", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      sandbox: {
        effectiveUid: 1_000,
        executable: "/fixture/bwrap",
        resourceLimiter: "/fixture/prlimit",
        access: async (file) => {
          if (file === "/fixture/prlimit") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        probe
      }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({
      available: false,
      reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports Linux Native Bash unavailable for a root Core process", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      sandbox: {
        effectiveUid: 0,
        access: async () => undefined,
        probe
      }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({
      available: false,
      reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("combines Codex login and Bash isolation into one runtime capability snapshot", async () => {
    const getWorkspaceBashCapability = vi.fn(async () => true);
    const resolve = createRuntimeToolCapabilityResolver({
      getCodexStatus: vi.fn(async () => ({ installed: true, authenticated: true })),
      getWorkspaceBashCapability
    });

    const context = {
      workspacePath: "/fixture/agent-workspace",
      workspaceBashAuditAvailable: true
    };
    await expect(resolve(context)).resolves.toEqual({ codex: true, workspaceBash: true });
    expect(getWorkspaceBashCapability).toHaveBeenCalledWith(context);
  });

  it("fails each runtime capability closed when its probe rejects or is incomplete", async () => {
    const resolve = createRuntimeToolCapabilityResolver({
      getCodexStatus: vi.fn(async () => ({ installed: true, authenticated: false })),
      getWorkspaceBashCapability: vi.fn(async () => { throw new Error("probe failed"); })
    });

    await expect(resolve({
      workspacePath: "/fixture/agent-workspace",
      workspaceBashAuditAvailable: true
    })).resolves.toEqual({
      codex: false,
      workspaceBash: false,
      workspaceBashReason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
  });

  it("does not start the isolation probe when the independent audit dependency is unavailable", async () => {
    const getWorkspaceBashCapability = vi.fn(async () => true);
    const resolve = createRuntimeToolCapabilityResolver({
      getCodexStatus: vi.fn(async () => ({ installed: true, authenticated: true })),
      getWorkspaceBashCapability
    });

    await expect(resolve({
      workspacePath: "/fixture/agent-workspace",
      workspaceBashAuditAvailable: false
    })).resolves.toEqual({
      codex: true,
      workspaceBash: false,
      workspaceBashReason: "BASH_AUDIT_UNAVAILABLE"
    });
    expect(getWorkspaceBashCapability).not.toHaveBeenCalled();
  });

  it("distinguishes an invalid Agent workbench from an isolation failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-bash-capability-invalid-workbench-"));
    temporaryRoots.push(root);
    const invalidWorkspace = path.join(root, "workspace-file");
    await fs.writeFile(invalidWorkspace, "not a directory");
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      sandbox: { probe }
    });

    await expect(capability(invalidWorkspace)).resolves.toEqual({
      available: false,
      reason: "BASH_WORKBENCH_UNAVAILABLE"
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

async function createAgentWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-bash-capability-"));
  temporaryRoots.push(root);
  return root;
}
