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
  it("fails macOS Native Bash closed even when the host shell is executable", async () => {
    const access = vi.fn(async () => undefined);
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      backend: "native",
      sandbox: { effectiveUid: 501, access, probe }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({
      available: false,
      reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
    expect(access).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports macOS Docker Bash only after its image probe succeeds", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      backend: "docker",
      runtimeMode: "native",
      sandbox: {
        effectiveUid: 1_000,
        dockerExecutable: "/fixture/docker",
        dockerImage: "sunabot-bash:test",
        access: async () => undefined,
        probe
      }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({ available: true });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("/fixture/docker");
    const probeArgs = probe.mock.calls[0]?.[1] ?? [];
    expect(probeArgs).toEqual(expect.arrayContaining([
      "run", "--rm", "--pull", "never", "--network", "none",
      "--entrypoint", "/usr/bin/env", "sunabot-bash:test", "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin", "/bin/bash", "--noprofile", "--norc", "-ec"
    ]));
    expect(probeArgs.at(-1)).toContain("/usr/bin/env");
    expect(probeArgs.at(-1)).toContain("/bin/bash");
    expect(probeArgs.at(-1)).toContain("/usr/bin/base64");
    expect(probe.mock.calls[0]?.[2]).toEqual({ env: expect.any(Object) });
  });

  it("reports Docker Bash unavailable for a root Core process", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      backend: "docker",
      runtimeMode: "native",
      sandbox: { effectiveUid: 0, probe }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({
      available: false,
      reason: "BASH_DOCKER_ISOLATION_UNAVAILABLE"
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("caches a successful namespace probe and refreshes failures after the TTL", async () => {
    let currentTime = 1_000;
    const probe = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("namespace unavailable"));
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      backend: "native",
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
    await expect(capability(agentWorkspace)).resolves.toEqual({
      available: false,
      reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports Linux Native Bash unavailable when the hard process limiter is missing", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      backend: "native",
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

  it("reports Docker Core Bash unavailable when a restricted fixed executable is missing", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      backend: "docker",
      runtimeMode: "docker",
      sandbox: {
        effectiveUid: 1_000,
        executable: "/fixture/bwrap",
        resourceLimiter: "/fixture/prlimit",
        access: async (file) => {
          if (file === "/usr/bin/base64") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        probe
      }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toEqual({
      available: false,
      reason: "BASH_DOCKER_ISOLATION_UNAVAILABLE"
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports Linux Native Bash unavailable for a root Core process", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      backend: "native",
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
      workspaceBashBackend: "docker" as const,
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
      workspaceBashBackend: "native",
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
      workspaceBashBackend: "docker",
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
      backend: "native",
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
