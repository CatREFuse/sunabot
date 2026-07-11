#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { PROXY_RUNTIME_CONTRACT } from "../../packages/platform/proxy.mjs";
import {
  readNodeVersionContractInputs,
  validateNodeVersionEntrypoints
} from "./node-version-contract.mjs";

const root = resolveProjectRoot(import.meta.url);
const contractPath = path.join(root, "deploy/runtime-contract.json");
const lockPath = path.join(root, "components/component.lock.json");
const [
  contract,
  schema,
  lock,
  dockerfile,
  compose,
  supervisor,
  nativeRuntime,
  nativeNapcatStart,
  configureNapcat,
  runtimeSmokeLayout
] = await Promise.all([
  readJson(contractPath),
  readJson(path.join(root, "deploy/runtime-contract.schema.json")),
  readJson(lockPath),
  fs.readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8"),
  fs.readFile(path.join(root, "deploy/docker/compose.yml"), "utf8"),
  fs.readFile(path.join(root, "deploy/docker/supervisor.mjs"), "utf8"),
  fs.readFile(path.join(root, "tooling/runtime/native.mjs"), "utf8"),
  fs.readFile(path.join(root, "deploy/native/bin/start-napcat.sh"), "utf8"),
  fs.readFile(path.join(root, "tooling/runtime/configure-napcat-client.mjs"), "utf8"),
  fs.readFile(path.join(root, "tooling/quality/runtime-smoke/shared.ts"), "utf8")
]);
const errors = [];
errors.push(...validateNodeVersionEntrypoints(await readNodeVersionContractInputs(root)));

expect(contract.schemaVersion === 1, "runtime contract schemaVersion must be 1");
expect(lock.schemaVersion === 1, "component lock schemaVersion must be 1");
expect(contract.runtimeId === "sunabot-qq-runtime", "runtimeId must be sunabot-qq-runtime");
expect(
  arraysEqual(contract.supportedPlatforms, lock.supportedPlatforms),
  "runtime and component platforms must match"
);
expect(path.isAbsolute(contract.paths.workspace), "workspace path must be absolute");
expect(path.isAbsolute(contract.paths.installPrefix), "installPrefix must be absolute");
expect(
  contract.paths.napcatConfig === "runtime/napcat/config-full",
  "NapCat config must use runtime/napcat/config-full"
);
expect(
  contract.paths.napcatConfig.startsWith(`${contract.paths.napcatState}/`),
  "NapCat config must be contained by the NapCat state root"
);
expect(
  schema.properties?.paths?.required?.includes("napcatConfig"),
  "runtime contract schema must require paths.napcatConfig"
);
expect(
  schema.properties?.paths?.properties?.napcatConfig?.const === contract.paths.napcatConfig,
  "runtime contract schema must fix the NapCat config path"
);

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
expect(
  JSON.stringify(contract.outboundProxy) === JSON.stringify(PROXY_RUNTIME_CONTRACT),
  "outbound proxy runtime contract must match packages/platform"
);
expect(compose.includes("SUNABOT_PROXY_MODE"), "Compose must pass the outbound proxy mode contract");
expect(
  compose.includes("SUNABOT_PROXY_DISCOVERED_URL"),
  "Compose must pass credential-free WSL proxy discovery"
);
expect(
  dockerfile.includes("napcatConfig)")
    && dockerfile.includes('ln -s "$SUNABOT_WORKSPACE/$napcat_config" /app/napcat/config'),
  "Docker NapCat config symlink must be resolved from paths.napcatConfig"
);
expect(
  supervisor.includes("contract.paths.napcatConfig")
    && !supervisor.includes('path.join(contract.paths.napcatState, "config")'),
  "Docker supervisor must use paths.napcatConfig"
);
expect(
  nativeRuntime.includes("contract.paths.napcatConfig")
    && !nativeRuntime.includes('path.join(contract.paths.napcatState, "config")'),
  "Native installer must use paths.napcatConfig"
);
expect(
  nativeNapcatStart.includes('readRelativePath("napcatConfig")')
    && !legacyNapcatConfigLiteral(nativeNapcatStart),
  "Native NapCat start must resolve paths.napcatConfig from the runtime contract"
);
expect(
  configureNapcat.includes("contract.paths.napcatConfig")
    && !configureNapcat.includes('path.join(workspace, contract.paths.napcatState, "config")'),
  "NapCat configure tooling must use paths.napcatConfig"
);
expect(
  runtimeSmokeLayout.includes('relativeContractPath(paths.napcatConfig, "paths.napcatConfig")'),
  "runtime smoke must load paths.napcatConfig from the runtime contract"
);

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
    nodeVersion: contract.nodeVersion,
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

function legacyNapcatConfigLiteral(source) {
  return /runtime[\\/]napcat[\\/]config(?!-full)(?=$|[\\/'"\s])/.test(source);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
