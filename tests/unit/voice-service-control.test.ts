// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceServiceControlClient,
  VoiceServiceControlError,
} from "../../apps/api/voiceServiceControlClient.js";
import {
  VoiceServiceHostError,
  attachVoiceServiceRuntimeNetwork,
  controlVoiceService,
  detachVoiceServiceRuntimeNetwork,
} from "../../tooling/runtime/voice-service-control.mjs";
import { workspaceIdentity } from "../../tooling/runtime/launcher-core.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("voice service control", () => {
  it("uses the host runtime bridge without exposing Docker to Core", async () => {
    const workspace = await temporaryWorkspace("sunabot-voice-control-client-");
    await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "runtime/launcher-state.json"),
      JSON.stringify({ reconciler: { pid: 42 } }),
    );
    const client = new VoiceServiceControlClient({
      workspace,
      pollIntervalMs: 5,
      timeoutMs: 1_000,
    });
    const pending = client.check();
    const requests = path.join(
      workspace,
      "runtime/account-reconciler/requests",
    );
    const requestFile = await waitForRequest(requests);
    const request = JSON.parse(
      await fs.readFile(path.join(requests, requestFile), "utf8"),
    );
    expect(request).toMatchObject({
      schemaVersion: 1,
      kind: "voice-service-control",
      action: "check",
    });
    expect(Object.keys(request).sort()).toEqual([
      "action",
      "kind",
      "requestId",
      "requestedAt",
      "schemaVersion",
    ]);
    const results = path.join(
      workspace,
      "runtime/account-reconciler/results",
    );
    await fs.mkdir(results, { recursive: true });
    await fs.writeFile(
      path.join(results, requestFile),
      JSON.stringify({
        schemaVersion: 1,
        kind: "voice-service-control",
        requestId: request.requestId,
        service: {
          state: "stopped",
          updatedAt: "2026-07-19T03:00:00.000Z",
        },
      }),
    );

    await expect(pending).resolves.toEqual({
      state: "stopped",
      updatedAt: "2026-07-19T03:00:00.000Z",
    });
    await expect(fs.readdir(requests)).resolves.toEqual([]);
    await expect(fs.readdir(results)).resolves.toEqual([]);
  });

  it("starts and stops only the labeled container for this workspace", async () => {
    const workspace = await temporaryWorkspace("sunabot-voice-control-host-");
    const identity = workspaceIdentity(workspace);
    let container: Record<string, unknown> | null = null;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return { stdout: "27.0.0\n", stderr: "" };
      }
      if (
        command === "docker" &&
        args[0] === "container" &&
        args[1] === "inspect"
      ) {
        if (!container) throw Object.assign(new Error("missing"), { code: 1 });
        const snapshot = container;
        if ((snapshot as { State?: { Running?: boolean } }).State?.Running === false) {
          container = null;
        }
        return { stdout: JSON.stringify(snapshot), stderr: "" };
      }
      if (
        command === "docker" &&
        ((args[0] === "image" && args[1] === "inspect") ||
          (args[0] === "network" && args[1] === "inspect"))
      ) {
        return { stdout: "{}", stderr: "" };
      }
      if (command === "bash") {
        container = ownedContainer(identity, true);
        return { stdout: "container-id\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "stop") {
        container = ownedContainer(identity, false);
        return { stdout: "sunabot-moss-tts-nano\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "rm") {
        if (!container) {
          throw Object.assign(new Error("missing"), {
            code: 1,
            stderr: "Error response from daemon: No such container: sunabot-moss-tts-nano",
          });
        }
        container = null;
        return { stdout: "sunabot-moss-tts-nano\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const environment = {
      SUNABOT_DOCKER_NETWORK: `sunabot-${identity.slice(0, 12)}-runtime`,
    };

    await expect(
      controlVoiceService("start", {
        workspace,
        environment,
        execFile: run,
      }),
    ).resolves.toMatchObject({ state: "running" });
    expect(run).toHaveBeenCalledWith(
      "bash",
      [expect.stringMatching(/tools\/start_moss_tts_nano_docker\.sh$/u), "--detach"],
      expect.objectContaining({
        env: expect.objectContaining({
          SUNABOT_WORKSPACE: workspace,
          SUNABOT_WORKSPACE_ID: identity,
        }),
      }),
    );

    await expect(
      controlVoiceService("stop", {
        workspace,
        environment,
        execFile: run,
      }),
    ).resolves.toMatchObject({ state: "stopped" });
    expect(container).toBeNull();
  });

  it("refuses to control a same-name container owned by another workspace", async () => {
    const workspace = await temporaryWorkspace("sunabot-voice-control-conflict-");
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return { stdout: "27.0.0\n", stderr: "" };
      }
      return {
        stdout: JSON.stringify(ownedContainer("ffffffffffffffff", true)),
        stderr: "",
      };
    });

    await expect(
      controlVoiceService("stop", { workspace, execFile: run }),
    ).rejects.toMatchObject({
      code: "VOICE_SERVICE_CONTAINER_CONFLICT",
      status: 409,
    });
    expect(
      run.mock.calls.some(
        ([command, args]) => command === "docker" && args[0] === "stop",
      ),
    ).toBe(false);
  });

  it("detaches and restores the owned container around runtime network replacement", async () => {
    const workspace = await temporaryWorkspace("sunabot-voice-network-lifecycle-");
    const identity = workspaceIdentity(workspace);
    const network = `sunabot-${identity.slice(0, 12)}-runtime`;
    let container = ownedContainer(identity, true, network);
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return { stdout: "27.0.0\n", stderr: "" };
      }
      if (
        command === "docker" &&
        args[0] === "container" &&
        args[1] === "inspect"
      ) {
        return { stdout: JSON.stringify(container), stderr: "" };
      }
      if (
        command === "docker" &&
        args[0] === "network" &&
        args[1] === "disconnect"
      ) {
        delete container.NetworkSettings.Networks[network];
        return { stdout: "", stderr: "" };
      }
      if (
        command === "docker" &&
        args[0] === "network" &&
        args[1] === "inspect"
      ) {
        return { stdout: "{}", stderr: "" };
      }
      if (
        command === "docker" &&
        args[0] === "network" &&
        args[1] === "connect"
      ) {
        container.NetworkSettings.Networks[network] = {
          Aliases: ["sunabot-moss-tts-nano"],
        };
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const options = {
      workspace,
      environment: { SUNABOT_DOCKER_NETWORK: network },
      execFile: run,
    };

    await expect(detachVoiceServiceRuntimeNetwork(options)).resolves.toBe(true);
    expect(container.State.Running).toBe(true);
    expect(container.NetworkSettings.Networks).not.toHaveProperty(network);
    await expect(attachVoiceServiceRuntimeNetwork(options)).resolves.toBe(true);
    expect(container.NetworkSettings.Networks[network]).toEqual({
      Aliases: ["sunabot-moss-tts-nano"],
    });
    await expect(attachVoiceServiceRuntimeNetwork(options)).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith(
      "docker",
      ["network", "disconnect", network, "sunabot-moss-tts-nano"],
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith(
      "docker",
      [
        "network",
        "connect",
        "--alias",
        "sunabot-moss-tts-nano",
        network,
        "sunabot-moss-tts-nano",
      ],
      expect.any(Object),
    );
  });

  it("fails closed when the host runtime bridge is unavailable", async () => {
    const workspace = await temporaryWorkspace("sunabot-voice-control-missing-");

    await expect(
      new VoiceServiceControlClient({ workspace }).start(),
    ).rejects.toBeInstanceOf(VoiceServiceControlError);
    await expect(
      controlVoiceService("restart", { workspace, execFile: vi.fn() }),
    ).rejects.toBeInstanceOf(VoiceServiceHostError);
  });
});

function ownedContainer(identity: string, running: boolean, network?: string) {
  return {
    Config: {
      Labels: {
        "io.sunabot.component": "voice",
        "io.sunabot.voice-workspace-id": identity,
      },
    },
    State: { Running: running },
    NetworkSettings: {
      Networks: network
        ? { [network]: { Aliases: ["sunabot-moss-tts-nano"] } }
        : {},
    },
  };
}

async function temporaryWorkspace(prefix: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function waitForRequest(directory: string) {
  for (let index = 0; index < 100; index += 1) {
    const entry = (await fs.readdir(directory).catch(() => [])).find((name) =>
      /^[a-f0-9-]{36}\.json$/u.test(name),
    );
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("voice service request was not published");
}
