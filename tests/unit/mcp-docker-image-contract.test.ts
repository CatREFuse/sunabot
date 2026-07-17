// @vitest-environment node
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mcpStdioEntrypointSource
} from "../../adapters/mcp/stdioEntrypointSource.js";
import { MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256 } from "../../adapters/mcp/approvedExecutableManifest.js";

const dockerfileUrl = new URL("../../deploy/docker/Dockerfile.mcp", import.meta.url);
const entrypointUrl = new URL("../../deploy/docker/mcp-stdio-entrypoint.mjs", import.meta.url);
const manifestUrl = new URL("../../deploy/docker/mcp-executables.json", import.meta.url);
const composeUrl = new URL("../../deploy/docker/compose.mcp.yml", import.meta.url);
const testServerUrl = new URL("../../deploy/docker/mcp-test-server.mjs", import.meta.url);
const coreDockerfileUrl = new URL("../../deploy/docker/Dockerfile", import.meta.url);

describe("Docker MCP stdio image contract", () => {
  it("pins Node and installs the exact reviewed entrypoint source", async () => {
    const [dockerfile, entrypoint] = await Promise.all([
      fs.readFile(dockerfileUrl, "utf8"),
      fs.readFile(entrypointUrl, "utf8")
    ]);

    expect(dockerfile).toContain("node:24.18.0-bookworm-slim@sha256:");
    expect(dockerfile).toContain("COPY --chmod=0555 mcp-stdio-entrypoint.mjs /usr/local/libexec/sunabot-mcp-stdio-entrypoint");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/libexec/sunabot-mcp-stdio-entrypoint"]');
    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toContain("install -d -m 0555 /run/sunabot/extensions");
    expect(dockerfile).not.toContain("-m 0700 /skills /run/sunabot/extensions");
    expect(dockerfile).not.toMatch(/^\s*ENV\s/imu);
    expect(entrypoint).toBe(mcpStdioEntrypointSource("/usr/local/bin/node"));
    expect(entrypoint).not.toContain("console.log");
    expect(entrypoint).not.toContain("process.env");
    expect(entrypoint).toContain("(launchRootStat.mode & 0o777) !== 0o700");
    expect(entrypoint).toContain("readBoundFile(launchFile, 0o600)");
    expect(entrypoint).toContain("readBoundFile(configPath, 0o400)");
    expect(entrypoint).toContain("readBoundFile(executableManifestPath, 0o444)");
    expect(entrypoint).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(entrypoint).not.toContain('.toString("utf8")');
    expect(entrypoint).toContain("if (!completed || closeFailed) content?.fill(0)");
    expect(entrypoint).toContain("if (closeFailed) fail()");
    expect(entrypoint).toContain("encoded.fill(0)");
    expect(entrypoint).toContain("config?.fill(0)");
    expect(entrypoint).toContain("manifestEncoded?.fill(0)");
    expect(entrypoint).toContain("main().catch(exitInvalid)");
    expect(entrypoint).not.toContain("manifestExists");
  });

  it("requires every image-approved server executable to exist and be executable at build time", async () => {
    const [dockerfile, manifestText] = await Promise.all([
      fs.readFile(dockerfileUrl, "utf8"),
      fs.readFile(manifestUrl, "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as {
      schemaVersion: number;
      executables: Array<{ path: string; sha256: string }>;
    };

    expect(manifest).toEqual({
      schemaVersion: 1,
      executables: [{
        path: "/usr/local/bin/sunabot-mcp-test-server",
        sha256: "d75a431304ee5d39538afeeb2e29876cad1394977cb25900b1597fed2c935d5e"
      }]
    });
    expect(dockerfile).toContain("/opt/sunabot/mcp/executables.json");
    expect(dockerfile).toContain("mcp-test-server.mjs /usr/local/bin/sunabot-mcp-test-server");
    expect(dockerfile).toContain("fs.statSync(item.path).mode&0o111");
    expect(dockerfile).toContain("value.executables.length>128");
    expect(dockerfile).toContain("new Set(value.executables.map((item)=>item.path)).size!==value.executables.length");
    const testServer = await fs.readFile(testServerUrl);
    expect(createHash("sha256").update(testServer).digest("hex")).toBe(manifest.executables[0]?.sha256);
    expect(createHash("sha256").update(manifestText).digest("hex"))
      .toBe(MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256);

    const coreDockerfile = await fs.readFile(coreDockerfileUrl, "utf8");
    expect(coreDockerfile).toContain("deploy/docker/mcp-test-server.mjs /usr/local/bin/sunabot-mcp-test-server");
    expect(coreDockerfile).toContain("deploy/docker/mcp-executables.json /opt/sunabot/mcp/executables.json");
    expect(coreDockerfile).toContain('fs.readFileSync("/opt/sunabot/mcp/executables.json","utf8")');
  });

  it("keeps image construction isolated from Core, NapCat, host networking, and Docker sockets", async () => {
    const compose = await fs.readFile(composeUrl, "utf8");

    expect(compose).toContain("image: ${SUNABOT_MCP_IMAGE:-sunabot-mcp:local}");
    expect(compose).toContain('profiles: ["build"]');
    expect(compose).toMatch(/^\s+context:\s+\.\s*$/mu);
    expect(compose).toMatch(/^\s+dockerfile:\s+Dockerfile\.mcp\s*$/mu);
    expect(compose).toContain("network_mode: none");
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("docker.sock");
    expect(compose).not.toMatch(/^\s+(?:core|napcat):/mu);
  });
});
