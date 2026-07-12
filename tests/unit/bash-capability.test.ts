// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeToolCapabilityResolver,
  createWorkspaceBashCapabilityProbe
} from "../../services/tools/bashCapability.js";

describe("workspace Bash capability probe", () => {
  it("rejects non-Linux runtimes without invoking bubblewrap", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "darwin",
      sandbox: { probe }
    });

    await expect(capability("/tmp/agent")).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("caches a successful namespace probe and refreshes failures after the TTL", async () => {
    let currentTime = 1_000;
    const probe = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("namespace unavailable"));
    const capability = createWorkspaceBashCapabilityProbe({
      platform: "linux",
      ttlMs: 30_000,
      now: () => currentTime,
      sandbox: {
        executable: "/fixture/bwrap",
        access: vi.fn(async () => undefined),
        probe
      }
    });

    await expect(capability("/srv/agent")).resolves.toBe(true);
    await expect(capability("/srv/agent")).resolves.toBe(true);
    expect(probe).toHaveBeenCalledOnce();

    currentTime += 30_001;
    await expect(capability("/srv/agent")).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
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
