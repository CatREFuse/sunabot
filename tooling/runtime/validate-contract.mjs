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
  nativeSunabotStart,
  bashSandbox,
  configureNapcat,
  runtimeSmokeLayout,
  workspaceLayout,
  onebotRoutes,
  workspaceMigration,
  buildRelease
] = await Promise.all([
  readJson(contractPath),
  readJson(path.join(root, "deploy/runtime-contract.schema.json")),
  readJson(lockPath),
  fs.readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8"),
  fs.readFile(path.join(root, "deploy/docker/compose.yml"), "utf8"),
  fs.readFile(path.join(root, "deploy/docker/supervisor.mjs"), "utf8"),
  fs.readFile(path.join(root, "tooling/runtime/native.mjs"), "utf8"),
  fs.readFile(path.join(root, "deploy/native/bin/start-napcat.sh"), "utf8"),
  fs.readFile(path.join(root, "deploy/native/bin/start-sunabot.sh"), "utf8"),
  fs.readFile(path.join(root, "services/tools/bashSandbox.ts"), "utf8"),
  fs.readFile(path.join(root, "tooling/runtime/configure-napcat-client.mjs"), "utf8"),
  fs.readFile(path.join(root, "tooling/quality/runtime-smoke/shared.ts"), "utf8"),
  fs.readFile(path.join(root, "packages/platform/workspaceLayout.ts"), "utf8"),
  fs.readFile(path.join(root, "apps/api/plugins/onebotRoutes.ts"), "utf8"),
  fs.readFile(path.join(root, "tooling/migrations/migrate-workspace-layout.mjs"), "utf8"),
  fs.readFile(path.join(root, "tooling/runtime/build-release.mjs"), "utf8")
]);
const dockerSeccompProfile = await readJson(
  path.join(root, contract.capabilities.workspaceBash.dockerSeccompProfile)
);
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
expect(
  contract.paths.napcatQrCode === "runtime/napcat/qrcode.png",
  "NapCat QR code must use runtime/napcat/qrcode.png"
);
expect(
  path.dirname(contract.paths.napcatQrCode) === contract.paths.napcatState,
  "NapCat QR code must be a direct child of the NapCat state root"
);
expect(
  schema.properties?.paths?.required?.includes("napcatQrCode"),
  "runtime contract schema must require paths.napcatQrCode"
);
expect(
  schema.properties?.paths?.properties?.napcatQrCode?.const === contract.paths.napcatQrCode,
  "runtime contract schema must fix the NapCat QR code path"
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
expect(
  contract.capabilities.required.includes("workspace-bash")
    && !contract.capabilities.optional.includes("workspace-bash"),
  "workspace-bash must be a required runtime capability"
);
expect(
  contract.capabilities.workspaceBash.isolation === "bubblewrap"
    && contract.capabilities.workspaceBash.executable === "/usr/bin/bwrap"
    && contract.capabilities.workspaceBash.dockerSeccompProfile === "deploy/docker/seccomp-bwrap.json"
    && contract.capabilities.workspaceBash.filesystemMode === "host-readonly-workspace-readwrite"
    && contract.capabilities.workspaceBash.subprocessIsolation === "inherited-mount-and-pid-namespaces"
    && contract.capabilities.workspaceBash.capabilitiesDropped === true
    && contract.capabilities.workspaceBash.failClosed === true,
  "workspace-bash must use the fail-closed bubblewrap contract"
);
expect(
  schema.properties?.capabilities?.properties?.workspaceBash?.properties?.executable?.const
    === contract.capabilities.workspaceBash.executable
    && schema.properties?.capabilities?.properties?.workspaceBash?.properties?.dockerSeccompProfile?.const
      === contract.capabilities.workspaceBash.dockerSeccompProfile,
  "runtime schema must fix the workspace Bash sandbox executable and Docker seccomp profile"
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
  dockerfile.includes("napcatQrCode)")
    && dockerfile.includes('ln -s "$SUNABOT_WORKSPACE/$napcat_state" /app/napcat/cache'),
  "Docker NapCat cache must link to the workspace state containing paths.napcatQrCode"
);
expect(
  dockerfile.includes("XDG_CACHE_HOME=/app/.cache")
    && dockerfile.includes("/app/.cache/fontconfig")
    && dockerfile.includes("/app/.cache/mesa_shader_cache")
    && dockerfile.includes("/app/.cache/mesa_shader_cache_db")
    && dockerfile.includes("chown -R 1000:1000"),
  "Docker must provision writable fontconfig and shader caches for the non-root runtime"
);
expect(
  dockerfile.includes(`bubblewrap=${lock.components.bubblewrap.version}`)
    && compose.includes(`seccomp=${contract.capabilities.workspaceBash.dockerSeccompProfile}`)
    && !compose.includes("seccomp=unconfined")
    && compose.includes("cap_drop:")
    && compose.includes("no-new-privileges:true"),
  "Docker must install bubblewrap, permit user namespaces, and retain capability/no-new-privilege restrictions"
);
const bubblewrapCloneRule = dockerSeccompProfile.syscalls.find((rule) =>
  rule.names?.length === 1
    && rule.names[0] === "clone"
    && rule.args?.[0]?.op === "SCMP_CMP_MASKED_EQ"
    && rule.args[0].value === 2114060288
    && rule.args[0].valueTwo === 1040318464
);
const bubblewrapMountRule = dockerSeccompProfile.syscalls.find((rule) =>
  ["mount", "pivot_root", "umount2"].every((name) => rule.names?.includes(name))
);
expect(
  dockerSeccompProfile.defaultAction === "SCMP_ACT_ERRNO"
    && bubblewrapCloneRule?.action === "SCMP_ACT_ALLOW"
    && bubblewrapMountRule?.action === "SCMP_ACT_ALLOW",
  "Docker seccomp must retain the default deny profile and allow only the traced bubblewrap namespace syscalls"
);
expect(
  supervisor.includes("contract.capabilities.workspaceBash.executable"),
  "Docker supervisor must require the workspace Bash isolation executable"
);
expect(
  supervisor.includes("contract.paths.napcatConfig")
    && !supervisor.includes('path.join(contract.paths.napcatState, "config")'),
  "Docker supervisor must use paths.napcatConfig"
);
expect(
  supervisor.includes("ensureNapcatCacheLink")
    && supervisor.includes('shellRoot: "/app/napcat"')
    && supervisor.includes('ensureNapcatWritableCaches("/app/.cache")'),
  "Docker supervisor must validate the NapCat cache link and writable process caches"
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
  nativeRuntime.includes("ensureNapcatCacheLink")
    && nativeNapcatStart.includes('readRelativePath("napcatQrCode")'),
  "Native runtime must link the NapCat component cache to paths.napcatQrCode"
);
expect(
  nativeRuntime.includes("contract.capabilities.workspaceBash")
    && nativeSunabotStart.includes("capabilities.workspaceBash.executable"),
  "Native install and startup must require the workspace Bash sandbox"
);
expect(
  [
    '"--ro-bind", "/", "/"',
    '"--dev", "/dev"',
    '"--bind", workspaceRoot, workspaceRoot',
    '"--cap-drop", "ALL"',
    '"--unshare-pid"'
  ].every((fragment) => bashSandbox.includes(fragment)),
  "workspace Bash must enforce read-only host mounts, one writable workspace, and nested-process isolation"
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
expect(
  runtimeSmokeLayout.includes('relativeContractPath(paths.napcatQrCode, "paths.napcatQrCode")'),
  "runtime smoke must load paths.napcatQrCode from the runtime contract"
);
expect(
  workspaceLayout.includes('napcatQrCode: "runtime/napcat/qrcode.png"')
    && onebotRoutes.includes("getWorkspacePath(WORKSPACE_LAYOUT.napcatQrCode)"),
  "Admin API and workspace layout must read the contract NapCat QR code path"
);
expect(
  workspaceMigration.includes("migrateLegacyNapcatQrCode"),
  "workspace migration must preserve legacy NapCat QR codes"
);
expect(
  buildRelease.includes('"packages/platform/napcatRuntimeLayout.mjs"'),
  "Native release must include the NapCat runtime layout helper"
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
