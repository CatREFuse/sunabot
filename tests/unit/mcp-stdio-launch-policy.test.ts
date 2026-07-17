// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildMcpDockerInvocation } from "../../adapters/mcp/dockerStdioLauncher.js";
import { buildMcpBubblewrapInvocation } from "../../adapters/mcp/stdioSandboxLauncher.js";
import { MCP_RUNTIME_DOWNLOADERS } from "../../adapters/mcp/stdioLaunchPolicy.js";

const projection = {
  workbench: "/host/workbench",
  skills: "/host/projection/skills",
  config: "/host/projection/extensions/mcp.json",
  executableManifest: "/host/projection/runtime/mcp-executables.json"
};
const launchProjection = {
  hostDirectory: "/host/projection/launch-secrets/launch-a",
  hostEntrypoint: "/host/projection/runtime/mcp-stdio-entrypoint"
};

function spec(command: string, args: string[] = ["--stdio"]) {
  return {
    command,
    args,
    cwd: "/workbench" as const,
    env: { SERVER_TOKEN: "secret-value" },
    inheritEnv: false as const,
    stderr: "pipe" as const,
    killScope: "process_group" as const
  };
}

function buildBoth(command: string, args?: string[]) {
  const launch = spec(command, args);
  return [
    () => buildMcpBubblewrapInvocation(launch, projection, { launchProjection }),
    () => buildMcpDockerInvocation({
      spec: launch,
      projection,
      launchProjection,
      dockerExecutable: "/fixture/docker",
      image: `sha256:${"c".repeat(64)}`,
      containerName: `sunabot-mcp-${"a".repeat(32)}`,
      probeContainerName: `sunabot-mcp-probe-${"b".repeat(32)}`,
      uid: 1_000,
      gid: 1_000
    })
  ];
}

describe("MCP stdio shared launch policy", () => {
  it.each(MCP_RUNTIME_DOWNLOADERS)("rejects %s through both bwrap and Docker", (downloader) => {
    for (const build of buildBoth(`/usr/bin/${downloader.toUpperCase()}`)) {
      expect(build).toThrow("MCP_STDIO_CONFIG_INVALID");
    }
  });

  it.each([
    ["/usr/local/bin/node", ["/workbench/server.mjs"]],
    ["/usr/bin/python3", ["/workbench/server.py"]],
    ["/bin/sh", ["/workbench/server"]],
    ["/usr/bin/env", ["example-mcp"]],
    ["/usr/bin/python", ["-m", "ensurepip"]],
    ["/usr/bin/PYTHON3", ["-M", "PIP"]],
    ["/usr/local/bin/python3.13", ["-m", "uv"]],
    ["/usr/bin/../bin/npx", ["server"]]
  ])("rejects downloader aliases through both backends: %s", (command, args) => {
    for (const build of buildBoth(command, args)) expect(build).toThrow("MCP_STDIO_CONFIG_INVALID");
  });

  it.each(["/bin/example-mcp", "/usr/bin/example-mcp", "/usr/local/bin/example-mcp"])(
    "accepts the descriptor-aligned executable prefix through both backends: %s",
    (command) => {
      for (const build of buildBoth(command)) expect(build).not.toThrow();
    }
  );

  it.each(["/opt/example/bin/mcp", "/app/bin/mcp", "/tmp/mcp"])(
    "rejects executable prefixes unavailable from the fixed image contract: %s",
    (command) => {
      for (const build of buildBoth(command)) expect(build).toThrow("MCP_STDIO_CONFIG_INVALID");
    }
  );
});
