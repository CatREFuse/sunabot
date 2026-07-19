// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  recoverStaleDockerOneoffs,
  resolveDockerUnavailableMessage
} from "../../tooling/runtime/docker-recovery.mjs";

const identity = "bfa0ec2e0882d0fb";
const staleId = "497fd988ddfd";

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
});
