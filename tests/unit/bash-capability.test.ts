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
  it("rejects macOS Native Bash without invoking any host sandbox fallback", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      backend: "native",
      sandbox: { probe }
    });

    await expect(capability(await createAgentWorkspace())).resolves.toBe(false);
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

    await expect(capability(await createAgentWorkspace())).resolves.toBe(true);
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

    await expect(capability(await createAgentWorkspace())).resolves.toBe(false);
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

    await expect(capability(agentWorkspace)).resolves.toBe(true);
    await expect(capability(agentWorkspace)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledOnce();

    currentTime += 30_001;
    await expect(capability(agentWorkspace)).resolves.toBe(false);
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

    await expect(capability(await createAgentWorkspace())).resolves.toBe(false);
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

    await expect(capability(await createAgentWorkspace())).resolves.toBe(false);
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

    await expect(capability(await createAgentWorkspace())).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("combines Codex login and Bash isolation into one runtime capability snapshot", async () => {
    const resolve = createRuntimeToolCapabilityResolver({
      getCodexStatus: vi.fn(async () => ({ installed: true, authenticated: true })),
      getWorkspaceBashCapability: vi.fn(async () => true)
    });

    await expect(resolve()).resolves.toEqual({ codex: true, workspaceBash: true });
  });

  it("fails each runtime capability closed when its probe rejects or is incomplete", async () => {
    const resolve = createRuntimeToolCapabilityResolver({
      getCodexStatus: vi.fn(async () => ({ installed: true, authenticated: false })),
      getWorkspaceBashCapability: vi.fn(async () => { throw new Error("probe failed"); })
    });

    await expect(resolve()).resolves.toEqual({ codex: false, workspaceBash: false });
  });
});

async function createAgentWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-bash-capability-"));
  temporaryRoots.push(root);
  return root;
}
