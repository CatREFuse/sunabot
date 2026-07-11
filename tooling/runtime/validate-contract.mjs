#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const contractPath = path.join(root, "deploy/runtime-contract.json");
const lockPath = path.join(root, "components/component.lock.json");
const [contract, lock, packageJson, dockerfile, compose] = await Promise.all([
  readJson(contractPath),
  readJson(lockPath),
  readJson(path.join(root, "package.json")),
  fs.readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8"),
  fs.readFile(path.join(root, "deploy/docker/compose.yml"), "utf8")
]);
const errors = [];

expect(contract.schemaVersion === 1, "runtime contract schemaVersion must be 1");
expect(lock.schemaVersion === 1, "component lock schemaVersion must be 1");
expect(contract.runtimeId === "sunabot-qq-runtime", "runtimeId must be sunabot-qq-runtime");
expect(contract.nodeVersion === lock.components?.node?.version, "Node versions must match");
expect(
  packageJson.engines?.node?.includes(contract.nodeVersion),
  "package engines must include the exact contract Node version"
);
expect(
  arraysEqual(contract.supportedPlatforms, lock.supportedPlatforms),
  "runtime and component platforms must match"
);
expect(path.isAbsolute(contract.paths.workspace), "workspace path must be absolute");
expect(path.isAbsolute(contract.paths.installPrefix), "installPrefix must be absolute");

for (const [name, value] of Object.entries(contract.paths)) {
  if (name === "workspace" || name === "installPrefix") continue;
  expect(!path.isAbsolute(value), `${name} must be relative to workspace`);
  expect(!value.split(/[\\/]/).includes(".."), `${name} must not escape workspace`);
}

const onebot = new URL(contract.network.onebotReverseWebSocket);
expect(onebot.protocol === "ws:", "OneBot URL must use ws on the local runtime");
expect(onebot.hostname === contract.network.host, "OneBot URL must use the contract loopback host");
expect(Number(onebot.port) === contract.network.apiPort, "OneBot URL and API port must match");
expect(onebot.pathname === "/onebot/v11/ws", "OneBot URL path must be fixed");
expect(contract.docker.composeService === "qq-runtime", "Compose service name must be qq-runtime");
expect(contract.docker.workspaceMount === contract.paths.workspace, "Docker workspace mount must match");

for (const [name, component] of Object.entries(lock.components ?? {})) {
  expect(Array.isArray(component.architectures) && component.architectures.length > 0,
    `${name} must declare architectures`);
  expect(Array.isArray(component.smoke) && component.smoke.length > 0,
    `${name} must declare a smoke command`);
  expect(Boolean(component.source), `${name} must declare a source`);
  expect(Boolean(component.license), `${name} must declare a license status`);
  if (component.image) {
    expect(/^sha256:[a-f0-9]{64}$/.test(component.digest ?? ""),
      `${name} image must have a sha256 digest`);
    expect(dockerfile.includes(`${component.image}@${component.digest}`),
      `${name} image digest must be used by Dockerfile`);
  }
}

const serviceLines = compose
  .split(/\r?\n/)
  .filter((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line));
expect(serviceLines.length === 1 && serviceLines[0].trim() === "qq-runtime:",
  "Compose must declare exactly one qq-runtime service");
expect((compose.match(/\/srv\/sunabot\/workspace/g) ?? []).length >= 1,
  "Compose must mount the contract workspace");
expect(!compose.includes("network_mode: service:"), "Compose must not emulate a shared namespace with a second service");

if (errors.length > 0) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    runtimeId: contract.runtimeId,
    releaseVersion: contract.releaseVersion,
    platforms: contract.supportedPlatforms,
    components: Object.keys(lock.components),
    composeServices: [contract.docker.composeService]
  }, null, 2) + "\n");
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
