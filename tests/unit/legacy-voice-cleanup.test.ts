// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { removeLegacyVoiceContainers } from "../../tooling/runtime/legacy-voice-cleanup.mjs";

describe("legacy voice cleanup", () => {
  it("stops and removes only containers with the current legacy Voice label", async () => {
    const workspaceId = "a".repeat(16);
    const id = "b".repeat(64);
    let state: "running" | "exited" | "missing" = "running";
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ps") {
        return {
          stdout: state === "missing" ? "" : `${id}\tvoice\t${state}\n`,
          stderr: "",
        };
      }
      if (args[0] === "stop") {
        state = "exited";
        return { stdout: id, stderr: "" };
      }
      if (args[0] === "rm") {
        state = "missing";
        return { stdout: id, stderr: "" };
      }
      throw new Error(`unexpected docker arguments: ${args.join(" ")}`);
    });

    await expect(
      removeLegacyVoiceContainers({ workspaceId, execFile: run }),
    ).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "--filter",
        `label=io.sunabot.voice-workspace-id=${workspaceId}`,
      ]),
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith(
      "docker",
      ["stop", "--timeout", "20", id],
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith("docker", ["rm", id], expect.any(Object));
  });

  it("refuses a conflicting component with the same legacy workspace label", async () => {
    const run = vi.fn(async () => ({
      stdout: `${"c".repeat(64)}\tnapcat\trunning\n`,
      stderr: "",
    }));

    await expect(
      removeLegacyVoiceContainers({
        workspaceId: "a".repeat(16),
        execFile: run,
      }),
    ).rejects.toThrow("归属标记冲突");
    expect(run).toHaveBeenCalledOnce();
  });
});
