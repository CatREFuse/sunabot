// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  recoverStaleDockerOneoffs,
  recoverWorkspaceBashContainers,
  resolveDockerUnavailableMessage
} from "../../tooling/runtime/docker-recovery.mjs";

const identity = "bfa0ec2e0882d0fb";
const staleId = "497fd988ddfd";
const runtimeId = "sunabot-qq-runtime";
const ownerId = "1".repeat(32);
const expiredInvocationId = "2".repeat(32);
const futureInvocationId = "3".repeat(32);

describe("Docker runtime recovery", () => {
  it("tells Colima users exactly how to start an unavailable Docker Engine", async () => {
    const runCommand = vi.fn(async (executable: string, args: string[]) => {
      expect(executable).toBe("docker");
      expect(args).toEqual(["context", "show"]);
      return "colima\n";
    });

    await expect(resolveDockerUnavailableMessage({ runCommand })).resolves.toBe(
      "Colima Docker Engine 未运行；请执行 colima start，等待终端显示 READY 后，再重新执行刚才的 Sunabot 命令。"
    );
  });

  it("keeps generic Docker guidance when the current context cannot be identified", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("docker command unavailable");
    });

    await expect(resolveDockerUnavailableMessage({ runCommand })).resolves.toBe(
      "Docker Engine 不可用；请启动 Docker Desktop 或 Docker Engine。"
    );
  });

  it("does nothing when the current workspace has no stale Compose one-off", async () => {
    const runCommand = vi.fn(async (executable: string, args: string[]) => {
      expect(executable).toBe("docker");
      expect(args.slice(0, 2)).toEqual(["ps", "-a"]);
      return "";
    });

    await expect(recoverStaleDockerOneoffs({
      identity,
      runCommand,
      platform: "darwin",
      interactive: true
    })).resolves.toEqual({ repaired: false, staleContainerIds: [] });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("fails closed without restarting Colima in a non-interactive command", async () => {
    const runCommand = vi.fn(async (executable: string, args: string[]) => {
      if (executable === "docker" && args[0] === "ps") {
        return `${staleId}\tnapcat\trunning\ttrue\n`;
      }
      if (executable === "docker" && args[0] === "inspect") {
        throw new Error(`Error response from daemon: No such container: ${staleId}`);
      }
      if (executable === "docker" && args[0] === "context") return "colima\n";
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    });

    await expect(recoverStaleDockerOneoffs({
      identity,
      runCommand,
      platform: "darwin",
      interactive: false
    })).rejects.toThrow("没有交互终端");
    expect(runCommand.mock.calls.some(([executable, args]) => (
      executable === "colima" && args[0] === "restart"
    ))).toBe(false);
  });

  it("restarts Colima after confirmation and verifies the stale record is gone", async () => {
    let restarted = false;
    const confirm = vi.fn(async () => true);
    const log = vi.fn();
    const runCommand = vi.fn(async (executable: string, args: string[]) => {
      if (executable === "docker" && args[0] === "ps") {
        return restarted ? "" : `${staleId}\tnapcat\trunning\ttrue\n`;
      }
      if (executable === "docker" && args[0] === "inspect") {
        throw new Error(`Error response from daemon: No such object: ${staleId}`);
      }
      if (executable === "docker" && args[0] === "context") return "colima\n";
      if (executable === "docker" && args[0] === "info") return "29.2.1\n";
      if (executable === "colima" && args[0] === "status") return "running\n";
      if (executable === "colima" && args[0] === "restart") {
        restarted = true;
        return "";
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    });

    await expect(recoverStaleDockerOneoffs({
      identity,
      runCommand,
      platform: "darwin",
      interactive: true,
      confirm,
      log,
      delay: async () => {}
    })).resolves.toEqual({ repaired: true, staleContainerIds: [staleId] });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("短暂中断其他 Docker 容器"));
    expect(runCommand.mock.calls.some(([executable, args]) => (
      executable === "colima" && args[0] === "restart"
    ))).toBe(true);
    expect(log).toHaveBeenCalledWith("Colima 已重启，Docker 悬空状态已清理。");
  });

  it("does not treat an ordinary inspect failure as a stale Docker record", async () => {
    const runCommand = vi.fn(async (executable: string, args: string[]) => {
      if (executable === "docker" && args[0] === "ps") {
        return `${staleId}\tnapcat\trunning\ttrue\n`;
      }
      if (executable === "docker" && args[0] === "inspect") {
        throw new Error("permission denied");
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    });

    await expect(recoverStaleDockerOneoffs({
      identity,
      runCommand,
      platform: "darwin",
      interactive: true
    })).rejects.toThrow("permission denied");
  });

  it("removes only expired workspace Bash containers with complete canonical ownership", async () => {
    const now = 1_800_000_000_000;
    const expiredId = "a".repeat(12);
    const futureId = "b".repeat(12);
    const runCommand = vi.fn(async (executable: string, args: string[], options: Record<string, unknown>) => {
      expect(executable).toBe("docker");
      expect(options.timeoutMs).toEqual(expect.any(Number));
      if (args[0] === "ps") {
        expect(args).toEqual(expect.arrayContaining([
          "--filter", `label=io.sunabot.workspace-id=${identity}`,
          "--filter", "label=io.sunabot.component=workspace-bash"
        ]));
        return [
          bashContainerLine(expiredId, expiredInvocationId, now - 1),
          bashContainerLine(futureId, futureInvocationId, now + 60_000),
          ""
        ].join("\n");
      }
      if (args[0] === "rm") {
        expect(args).toEqual(["rm", "-f", expiredId]);
        return expiredId;
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    });

    await expect(recoverWorkspaceBashContainers({
      identity,
      runtimeId,
      now: () => now,
      runCommand
    })).resolves.toEqual({ repaired: true, removedContainerIds: [expiredId] });
    expect(runCommand.mock.calls.filter(([, args]) => args[0] === "rm")).toHaveLength(1);
  });

  it("fails closed without deleting a workspace Bash container with incomplete ownership", async () => {
    const containerId = "c".repeat(12);
    const runCommand = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === "ps") {
        return bashContainerLine(containerId, expiredInvocationId, 1, { ownerId: "" });
      }
      throw new Error(`unexpected mutation: ${args.join(" ")}`);
    });

    await expect(recoverWorkspaceBashContainers({
      identity,
      runtimeId,
      now: () => 2,
      runCommand
    })).rejects.toThrow("DOCKER_BASH_OWNERSHIP_INVALID");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("treats a concurrently removed expired Bash container as recovered", async () => {
    const containerId = "d".repeat(12);
    const runCommand = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === "ps") return bashContainerLine(containerId, expiredInvocationId, 1);
      if (args[0] === "rm") throw new Error(`No such container: ${containerId}`);
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    await expect(recoverWorkspaceBashContainers({
      identity,
      runtimeId,
      now: () => 2,
      runCommand
    })).resolves.toEqual({ repaired: true, removedContainerIds: [containerId] });
  });
});

function bashContainerLine(
  id: string,
  invocationId: string,
  expiresAtMs: number,
  overrides: { ownerId?: string; runtimeId?: string; workspaceId?: string; component?: string; name?: string } = {}
) {
  return [
    id,
    overrides.name ?? `sunabot-bash-${invocationId}`,
    overrides.runtimeId ?? runtimeId,
    overrides.workspaceId ?? identity,
    overrides.component ?? "workspace-bash",
    overrides.ownerId ?? ownerId,
    invocationId,
    String(expiresAtMs)
  ].join("\t");
}
