// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxProcessSignature, readProcessSignature } from "../../tooling/runtime/process-signature.mjs";
import { processSignatureMatches } from "../../tooling/runtime/launcher-core.mjs";
import {
  accountRuntimeOwnerMatchesObservation,
  observeAccountRuntimeProcess
} from "../../tooling/runtime/account-runtime-daemon.mjs";

const bootId = "b1234567-1234-1234-1234-123456789abc";
const pid = 4321;
const entry = "/srv/sunabot/tooling/runtime/account-runtime-daemon.mjs";
const workspaceId = "0123456789abcdef";
const ownerToken = "a".repeat(64);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function procStat(startTicks = "12345678", comm = "node") {
  return `${pid} (${comm}) S ${Array(18).fill("0").join(" ")} ${startTicks} 0 0\n`;
}

describe("clock-independent Linux process identity", () => {
  it("keeps the same process and owner identity across forward and backward wall-clock corrections", async () => {
    vi.useFakeTimers();
    const readFile = vi.fn(async (file: string) => file.endsWith("boot_id") ? `${bootId}\n` : procStat());
    vi.setSystemTime(new Date("2026-10-12T09:55:59Z"));
    const original = await readProcessSignature(pid, { platform: "linux", readFile });
    const record = { pid, processGroup: pid, signature: original, entry, workspaceId, ownerToken };
    for (const deltaMs of [315_000, -315_000]) {
      vi.setSystemTime(Date.now() + deltaMs);
      const observed = {
        pid, processGroup: pid, signature: await readProcessSignature(pid, { platform: "linux", readFile }),
        command: `node ${entry} --workspace-id=${workspaceId} --owner-token=${ownerToken}`
      };
      expect(processSignatureMatches(record, observed)).toBe(true);
      expect(accountRuntimeOwnerMatchesObservation(record, observed)).toBe(true);
    }
    expect(original).toBe(`linux:${bootId}:12345678`);
    expect(readFile).toHaveBeenCalledWith(`/proc/${pid}/stat`, "utf8");
  });

  it("rejects a reused PID, a different boot and changes to command, process group or owner token", () => {
    const signature = linuxProcessSignature(pid, bootId, procStat());
    const record = { pid, processGroup: pid, signature, entry, workspaceId, ownerToken };
    const observed = {
      pid, processGroup: pid, signature,
      command: `node ${entry} --workspace-id=${workspaceId} --owner-token=${ownerToken}`
    };
    for (const change of [
      { signature: linuxProcessSignature(pid, bootId, procStat("12345679")) },
      { signature: linuxProcessSignature(pid, bootId.replace(/^b/u, "c"), procStat()) },
      { pid: pid + 1 },
      { processGroup: pid + 1 },
      { command: observed.command.replace(entry, "/srv/other/daemon.mjs") },
      { command: observed.command.replace(ownerToken, "b".repeat(64)) },
      { command: observed.command.replace(workspaceId, "fedcba9876543210") }
    ]) expect(accountRuntimeOwnerMatchesObservation(record, { ...observed, ...change })).toBe(false);
    expect(processSignatureMatches({ ...record, signature: "Mon Oct 12 17:55:59 2026" }, observed)).toBe(false);
  });

  it("parses start ticks after a comm containing spaces and closing parentheses", () => {
    expect(linuxProcessSignature(pid, bootId, procStat("987654321", "worker (test) name)")))
      .toBe(`linux:${bootId}:987654321`);
  });

  it.each([
    [0, bootId, procStat()],
    [pid, "invalid", procStat()],
    [pid, bootId, procStat().replace(String(pid), "9999")],
    [pid, bootId, `${pid} (node) S 0`],
    [pid, bootId, procStat("not-a-tick")],
    [pid, bootId, procStat("-10")],
    [pid, bootId, `${pid} (node S 0`]
  ])("rejects invalid process identity input (%s)", (processId, boot, stat) => {
    expect(() => linuxProcessSignature(processId, boot, stat)).toThrow("Invalid Linux process identity");
  });

  it("does not fall back to wall-clock identity when procfs is unreadable", async () => {
    const failure = Object.assign(new Error("process exited"), { code: "ENOENT" });
    const execFile = vi.fn();
    await expect(readProcessSignature(pid, {
      platform: "linux", readFile: vi.fn().mockRejectedValue(failure), execFile
    })).rejects.toBe(failure);
    expect(execFile).not.toHaveBeenCalled();
    await expect(readProcessSignature(0)).rejects.toThrow("Invalid process PID");
  });

  it("preserves the non-Linux ps signature", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "Mon Oct 12 17:55:59 2026\n" });
    const readFile = vi.fn();
    await expect(readProcessSignature(pid, { platform: "darwin", execFile, readFile }))
      .resolves.toBe("Mon Oct 12 17:55:59 2026");
    expect(execFile).toHaveBeenCalledWith("ps", ["-p", String(pid), "-o", "lstart="], expect.any(Object));
    expect(readFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("observes the complete owner command in a narrow terminal", async () => {
    vi.stubEnv("COLUMNS", "20");
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [
        "-e", "setInterval(() => {}, 1000)", "--", entry,
        "x".repeat(4096), `--workspace-id=${workspaceId}`, `--owner-token=${ownerToken}`
      ], { detached: true, stdio: "ignore" });
      await once(child, "spawn");
      const observed = await observeAccountRuntimeProcess(child.pid);
      expect(observed?.command).toContain(`--owner-token=${ownerToken}`);
      expect(observed?.signature).toMatch(/^linux:/u);
      expect(accountRuntimeOwnerMatchesObservation({
        pid: child.pid, processGroup: child.pid, signature: observed?.signature, entry, workspaceId, ownerToken
      }, observed)).toBe(true);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGTERM");
        await exited;
      }
    }
  });
});
