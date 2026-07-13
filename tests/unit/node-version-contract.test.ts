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
  it("keeps development, package, CI, Native release and Docker on Node 24.18.0", async () => {
    const input = await readNodeVersionContractInputs(root);
    expect(input.contract.nodeVersion).toBe("24.18.0");
    expect(validateNodeVersionEntrypoints(input)).toEqual([]);
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
    ["Docker", (input: Awaited<ReturnType<typeof readNodeVersionContractInputs>>) => {
      input.dockerfile = input.dockerfile.replace("ARG NODE_VERSION=24.18.0", "ARG NODE_VERSION=24.14.0");
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
