// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeProjectName,
  composeServiceRunning,
  ensureRuntimeSecrets,
  parseComposePs,
  parseLauncherArguments,
  processSignatureMatches,
  resolveCoreMode,
  resolveLauncherContract,
  reverseWebSocketWithHost,
  workspaceIdentity
} from "../../tooling/runtime/launcher-core.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("unified runtime launcher", () => {
  it("installs dependencies before loading the launcher in a clean checkout", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-"));
    try {
      const bin = path.join(fixture, "bin");
      const launcher = path.join(fixture, "tooling/runtime/launcher.mjs");
      const trace = path.join(fixture, "trace.log");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      await fs.writeFile(launcher, "");
      await fs.writeFile(path.join(bin, "node"), [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        `  printf '%s\\n' '${process.versions.node}'`,
        "  exit 0",
        "fi",
        "printf 'node:%s\\n' \"$*\" >> \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });
      await fs.writeFile(path.join(bin, "npm"), [
        "#!/bin/sh",
        "printf 'npm:%s:%s\\n' \"$PWD\" \"$*\" >> \"$TRACE_FILE\"",
        "mkdir -p node_modules",
        "touch node_modules/.package-lock.json"
      ].join("\n"), { mode: 0o755 });

      const result = spawnSync(path.join(fixture, "sunabot.sh"), ["status"], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          TRACE_FILE: trace
        }
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(fs.readFile(trace, "utf8")).resolves.toBe([
        `npm:${fixture}:ci`,
        `node:${launcher} status`,
        ""
      ].join("\n"));
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("defaults to up and selects the platform Core mode", () => {
    expect(parseLauncherArguments([], {}).command).toBe("up");
    expect(resolveCoreMode("auto", { platform: "darwin" })).toBe("native");
    expect(resolveCoreMode("auto", { platform: "linux" })).toBe("docker");
    expect(() => resolveCoreMode("auto", { platform: "win32" })).toThrow("WSL2");
  });

  it("accepts explicit Core and development options", () => {
    expect(parseLauncherArguments(["restart", "--core=docker"], {})).toEqual({
      command: "restart",
      requestedMode: "docker",
      dev: false
    });
    expect(parseLauncherArguments(["up", "--core", "native", "--dev"], {})).toEqual({
      command: "up",
      requestedMode: "native",
      dev: true
    });
    expect(parseLauncherArguments(["doctor"], { SUNABOT_DEV: "1" }).dev).toBe(true);
  });

  it("uses schema v2 network and Docker service fields", async () => {
    const contract = JSON.parse(await fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8"));
    const resolved = resolveLauncherContract(contract, {
      root,
      platform: "darwin",
      wsl: false
    });

    expect(contract.schemaVersion).toBe(2);
    expect(resolved.adminPort).toBe(8787);
    expect(resolved.onebotHost).toBe("127.0.0.1");
    expect(resolved.onebotPort).toBe(8788);
    expect(resolved.nativeReverseWebSocket).toBe("ws://host.docker.internal:8788/onebot/v11/ws");
    expect(resolved.dockerReverseWebSocket).toBe("ws://core:8788/onebot/v11/ws");
    expect(resolved.coreService).toBe("core");
    expect(resolved.coreProfile).toBe("core-docker");
    expect(resolved.napcatService).toBe("napcat");
    expect(resolved.codexCli).toEqual({
      version: "0.139.0",
      executable: "/usr/local/bin/codex",
      authFile: "secrets/codex/auth.json"
    });
    expect(resolved.coreReadyTimeoutSeconds).toBe(60);
    expect(resolved.napcatReadyTimeoutSeconds).toBe(120);

    const linux = resolveLauncherContract(contract, {
      root,
      platform: "linux",
      wsl: false
    });
    expect(linux.onebotHost).toBe("docker-network-gateway");
  });

  it("generates missing tokens once and never replaces configured values", () => {
    let sequence = 0;
    const first = ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=existing\nWEBUI_TOKEN=\nTAVILY_API_KEY=next-setting\n",
      () => `generated-${++sequence}`
    );
    expect(first.values).toEqual({
      ONEBOT_ACCESS_TOKEN: "existing",
      WEBUI_TOKEN: "generated-1"
    });
    const second = ensureRuntimeSecrets(first.content, () => `generated-${++sequence}`);
    expect(second.content).toBe(first.content);
    expect(second.values).toEqual(first.values);
  });

  it("rejects duplicate launcher-owned runtime settings", () => {
    expect(() => ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=first\nONEBOT_ACCESS_TOKEN=second\nWEBUI_TOKEN=webui\n",
      () => "generated"
    )).toThrow("duplicate ONEBOT_ACCESS_TOKEN");
    expect(() => ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=onebot\nWEBUI_TOKEN=webui\nNAPCAT_ACCOUNT=1\nNAPCAT_ACCOUNT=2\n",
      () => "generated"
    )).toThrow("duplicate NAPCAT_ACCOUNT");
  });

  it("derives stable isolated Compose ownership from workspace", () => {
    const identity = workspaceIdentity("/srv/sunabot-a");
    expect(identity).toHaveLength(16);
    expect(composeProjectName("Sunabot QQ Runtime", identity)).toBe(`sunabot-qq-runtime-${identity.slice(0, 12)}`);
    expect(workspaceIdentity("/srv/sunabot-a")).toBe(identity);
    expect(workspaceIdentity("/srv/sunabot-b")).not.toBe(identity);
  });

  it("parses Compose status and validates native process ownership", () => {
    const items = parseComposePs([
      JSON.stringify({ Service: "core", State: "running" }),
      JSON.stringify({ Service: "napcat", State: "exited" })
    ].join("\n"));
    expect(composeServiceRunning(items, "core")).toBe(true);
    expect(composeServiceRunning(items, "napcat")).toBe(false);
    expect(processSignatureMatches(
      { pid: 10, signature: "start", entry: "/project/main.js" },
      { signature: "start", command: "node /project/main.js" }
    )).toBe(true);
    expect(processSignatureMatches(
      { pid: 10, signature: "start", entry: "/project/main.js" },
      { signature: "other", command: "node /project/main.js" }
    )).toBe(false);
  });

  it("rewrites only the advertised host after a successful container probe", () => {
    expect(reverseWebSocketWithHost(
      "ws://host.docker.internal:8788/onebot/v11/ws",
      "172.18.0.1"
    )).toBe("ws://172.18.0.1:8788/onebot/v11/ws");
  });
});
