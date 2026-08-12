// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readNodeVersionContractInputs,
  validateNodeVersionEntrypoints
} from "../../tooling/runtime/node-version-contract.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("pinned Node runtime contract", () => {
  it("keeps development, package, CI, Native start and bundled releases on Node 24.18.0", async () => {
    const input = await readNodeVersionContractInputs(root);
    expect(input.contract.nodeVersion).toBe("24.18.0");
    expect(validateNodeVersionEntrypoints(input)).toEqual([]);
  });

  it("keeps the packaged Core process entry on verified bundled executables", async () => {
    const { nativeStart } = await readNodeVersionContractInputs(root);
    expect(nativeStart).toContain('runtime/node/bin/node');
    expect(nativeStart).toContain('runtime/bubblewrap/bwrap');
    expect(nativeStart).toContain('${SUNABOT_NODE_EXECUTABLE+x}');
    expect(nativeStart).toContain('${SUNABOT_BWRAP_EXECUTABLE+x}');
    expect(nativeStart).toContain('export SUNABOT_BWRAP_EXECUTABLE="$bwrap_bin"');
    expect(nativeStart).toContain('export SUNABOT_PACKAGED_RELEASE=1');
    expect(nativeStart).not.toContain('command -v node');
    expect(nativeStart).not.toContain('/usr/bin/bwrap');

    const integrityCheck = nativeStart.indexOf("validateReleaseManifest");
    const coreExec = nativeStart.indexOf('exec "$node_bin" "$root/dist/apps/api/main.js"');
    expect(integrityCheck).toBeGreaterThan(-1);
    expect(coreExec).toBeGreaterThan(integrityCheck);
  });

  it.each([
    ["development", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.nodeVersionFile = "24.14.0\n";
    }],
    ["nvm", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.nvmrc = "24.14.0\n";
    }],
    ["package", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.packageJson.engines.node = ">=24.18.0 <25";
    }],
    ["package lock", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.packageLock.packages[""].engines.node = "24.14.0";
    }],
    ["CI", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.workflow = input.workflow.replace("node-version-file: .node-version", "node-version: 24.14.0");
    }],
    ["runtime contract", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.contract.nodeVersion = "24.14.0";
    }],
    ["runtime schema", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.schema.properties.nodeVersion.const = "24.14.0";
    }],
    ["component lock", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.componentLock.components.node.version = "24.14.0";
    }],
    ["linux/arm64 archive", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.componentLock.components.node.archives["linux/arm64"].sha256 = "";
    }],
    ["Native start", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.nativeStart = input.nativeStart.replace('[[ "$actual_node" != "$expected_node" ]]', "true");
    }],
    ["Native manifest", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.buildRelease = input.buildRelease.replace("nodeVersion: contract.nodeVersion", "nodeVersion: process.versions.node");
    }]
  ])("rejects %s Node version drift without inspecting the current process", async (_name, mutate) => {
    const input = await readNodeVersionContractInputs(root);
    mutate(input);
    expect(validateNodeVersionEntrypoints(input)).not.toEqual([]);
  });
});
