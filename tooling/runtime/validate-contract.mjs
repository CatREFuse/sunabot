#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { PROXY_RUNTIME_CONTRACT } from "../../packages/platform/proxy.mjs";
import {
  readNodeVersionContractInputs,
  validateNodeVersionEntrypoints
} from "./node-version-contract.mjs";
import { validateOfficeParserContract } from "./office-parser-contract.mjs";

const root = resolveProjectRoot(import.meta.url);
const [
  contract,
  schema,
  lock,
  coreDockerfile,
  napcatDockerfile,
  napcatEntrypoint,
  compose,
  coreHealthcheck,
  outboundMedia,
  apiServer,
  workspaceLayout,
  launcher,
  launcherCore,
  dockerRecovery,
  launcherShell,
  agentsGuide,
  dockerSeccompProfile,
  buildRelease,
  packageManifest,
  packageLock
] = await Promise.all([
  readJson("deploy/runtime-contract.json"),
  readJson("deploy/runtime-contract.schema.json"),
  readJson("components/component.lock.json"),
  read("deploy/docker/Dockerfile"),
  read("deploy/docker/Dockerfile.napcat"),
  read("deploy/docker/napcat-entrypoint.sh"),
  read("deploy/docker/compose.yml"),
  read("deploy/docker/healthcheck.mjs"),
  read("services/delivery/outboundMedia.ts"),
  read("apps/api/server.ts"),
  read("packages/platform/workspaceLayout.ts"),
  read("tooling/runtime/launcher.mjs"),
  read("tooling/runtime/launcher-core.mjs"),
  read("tooling/runtime/docker-recovery.mjs"),
  read("sunabot.sh"),
  read("AGENTS.md"),
  readJson("deploy/docker/seccomp-bwrap.json"),
  read("tooling/runtime/build-release.mjs"),
  readJson("package.json"),
  readJson("package-lock.json")
]);

const errors = [
  ...validateNodeVersionEntrypoints(await readNodeVersionContractInputs(root)),
  ...validateOfficeParserContract({ componentLock: lock, packageManifest, packageLock })
];
const expect = (condition, message) => {
  if (!condition) errors.push(message);
};

expect(contract.schemaVersion === 2, "runtime contract schemaVersion must be 2");
expect(schema.properties?.schemaVersion?.const === 2, "runtime schema must fix schemaVersion 2");
expect(contract.runtimeId === "sunabot-qq-runtime", "runtimeId must stay sunabot-qq-runtime");
expect(contract.releaseVersion === "0.1.0", "runtime release version must match package version");
expect(contract.nodeVersion === "24.18.0", "runtime must use the pinned Node version");
expect(arraysEqual(contract.supportedPlatforms, lock.supportedPlatforms),
  "runtime and component platforms must match");
expect(contract.supportedPlatforms.includes("linux/amd64"),
  "the production Core image must declare linux/amd64 support");
expect(contract.supportedPlatforms.includes("linux/arm64"),
  "the production Core image must declare linux/arm64 support");

for (const required of [
  '"src"',
  '"services"',
  '"adapters"',
  '"packages"',
  '"apps/api"',
  '"apps/webfetch-renderer"',
  '"apps/admin-web/src"',
  '"tooling/migrations"',
  '"tooling/quality"',
  '"docs"'
]) {
  expect(buildRelease.includes(required), `release bundle must include ${required}`);
}
expect(packageManifest.scripts?.["migrate:sqlite"]?.includes("run-built-migration.mjs"),
  "SQLite migration must support the prebuilt release bundle");
expect(packageManifest.scripts?.["migrate:multi-agent"]?.includes("run-built-migration.mjs"),
  "multi-Agent migration must support the prebuilt release bundle");

expect(path.isAbsolute(contract.paths.workspace), "contract workspace must be absolute");
expect(path.isAbsolute(contract.paths.installPrefix), "contract install prefix must be absolute");
for (const [name, value] of Object.entries(contract.paths)) {
  if (name === "workspace" || name === "installPrefix") continue;
  expect(typeof value === "string" && !path.isAbsolute(value), `${name} must be workspace-relative`);
  expect(!String(value).split(/[\\/]/).includes(".."), `${name} must not escape workspace`);
}
expect(contract.paths.napcatAccounts === "runtime/napcat/accounts",
  "NapCat account root must remain canonical");
for (const key of ["napcatAccounts"]) {
  expect(schema.properties?.paths?.required?.includes(key), `runtime schema must require paths.${key}`);
  expect(schema.properties?.paths?.properties?.[key]?.const === contract.paths[key],
    `runtime schema must fix paths.${key}`);
}
for (const retired of ["napcatConfig", "napcatQqState", "napcatPlugins", "napcatQrCode", "napcatManualLogin"]) {
  expect(!(retired in contract.paths), `runtime contract must not expose legacy paths.${retired}`);
  expect(!schema.properties?.paths?.required?.includes(retired), `runtime schema must retire paths.${retired}`);
}
expect(workspaceLayout.includes('napcatAccounts: "runtime/napcat/accounts"')
  && workspaceLayout.includes('legacyNapcatConfig: "runtime/napcat/config-full"')
  && workspaceLayout.includes('legacyNapcatQqState: "runtime/napcat/qq"'),
"workspace layout must separate current account paths from legacy migration paths");

const admin = contract.network.admin;
const onebot = contract.network.onebot;
const webui = contract.network.napcatWebui;
expect(admin.host === "127.0.0.1" && admin.port === 8787,
  "admin must publish only on host loopback port 8787");
expect(onebot.path === "/onebot/v11/ws" && onebot.internalPort === 8788,
  "OneBot must use the dedicated internal port 8788 and fixed path");
expect(onebot.accessTokenRequired === true, "OneBot access token must be mandatory");
expect(onebot.nativeListenerHosts.macos === "127.0.0.1"
  && onebot.nativeListenerHosts.wsl === "docker-network-gateway"
  && onebot.nativeListenerHosts.linux === "docker-network-gateway",
"Native OneBot listeners must stay on loopback or the private Compose gateway");
expect(webui.host === "127.0.0.1" && webui.port === 6099,
  "NapCat WebUI must publish only on host loopback port 6099");
for (const value of Object.values(onebot.nativeAdvertisedUrls ?? {})) {
  const url = validWebSocketUrl(value);
  expect(url?.hostname === "host.docker.internal" && Number(url?.port) === onebot.internalPort,
    "Native Core must advertise a container-reachable host.docker.internal OneBot URL");
  expect(url?.pathname === onebot.path, "Native OneBot URL must use the fixed path");
}
const dockerOnebot = validWebSocketUrl(onebot.dockerAdvertisedUrl);
expect(dockerOnebot?.hostname === contract.docker.services.core.name,
  "Docker NapCat must address Core by Compose service DNS");
expect(Number(dockerOnebot?.port) === onebot.internalPort && dockerOnebot?.pathname === onebot.path,
  "Docker OneBot URL must match the internal port and path");

expect(contract.mediaTransport.outbound.mode === "inline-base64"
  && contract.mediaTransport.outbound.sharedFilesystem === false,
"cross-component outbound media must default to inline base64 without a shared filesystem");
expect(contract.mediaTransport.inbound.containerLocalPaths === false,
  "container-local inbound paths must be rejected");
expect(outboundMedia.includes('|| "inline-base64"')
  && outboundMedia.includes("SUNABOT_MEDIA_MAX_INLINE_BYTES")
  && outboundMedia.includes('if (value === "inline-base64") return value;')
  && !outboundMedia.includes('value === "shared-path" ||')
  && !outboundMedia.includes('platform === "darwin"'),
"media delivery must be topology-configured, bounded and platform-independent");

expect(JSON.stringify(contract.outboundProxy) === JSON.stringify(PROXY_RUNTIME_CONTRACT),
  "outbound proxy runtime contract must match packages/platform");
expect(contract.native.napcatManagedBy === "docker",
  "NapCat must be Docker-managed in every Core mode");
expect(contract.capabilities.workspaceBash.service === "core"
  && contract.capabilities.workspaceBash.isolation === "bubblewrap"
  && contract.capabilities.workspaceBash.failClosed === true,
"workspace Bash must remain fail-closed inside Core");
expect(contract.capabilities.required.includes("codex-cli")
  && !contract.capabilities.optional.includes("codex-cli")
  && contract.capabilities.codexCli.service === "core"
  && contract.capabilities.codexCli.executable === "/usr/local/bin/codex"
  && contract.capabilities.codexCli.authFile === "secrets/codex/auth.json"
  && contract.capabilities.codexCli.failClosed === true,
"Codex CLI must be a required, pinned Core capability with workspace auth");
expect(hasBubblewrapSeccompRules(dockerSeccompProfile),
  "Docker seccomp must retain the required bubblewrap namespace rules");

const servicesBlock = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
const serviceNames = servicesBlock
  .split(/\r?\n/)
  .flatMap((line) => /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1] ?? []);
expect(arraysEqual(serviceNames, ["webfetch-renderer", "core", "napcat"]),
  "Compose must declare the independent webfetch renderer, core and napcat services");
const rendererBlock = serviceBlock(compose, "webfetch-renderer", "core");
const coreBlock = serviceBlock(compose, "core", "napcat");
const napcatBlock = serviceBlock(compose, "napcat", undefined);
expect(coreBlock.includes('profiles: ["core-docker"]'), "Core Docker service must be profile-controlled");
expect(rendererBlock.includes('127.0.0.1:8790:8790')
  && rendererBlock.includes("read_only: true")
  && rendererBlock.includes("no-new-privileges:true")
  && rendererBlock.includes("seccomp=deploy/docker/seccomp-webfetch-renderer.json")
  && !rendererBlock.includes("env_file:")
  && !rendererBlock.includes("volumes:"),
"WebFetch renderer must be loopback-only, read-only and isolated from Core secrets and workspace mounts");
expect(coreBlock.includes("127.0.0.1:8787:8787"),
  "Core admin port must publish to host loopback only");
expect(coreBlock.includes('expose:\n      - "8788"') && !coreBlock.includes(":8788:8788"),
  "OneBot port must stay inside the Compose network");
expect(napcatBlock.includes('127.0.0.1:${NAPCAT_WEBUI_PORT:-6099}:6099'),
  "each NapCat WebUI must publish its assigned host loopback port");
expect(napcatBlock.includes("host.docker.internal:host-gateway"),
  "NapCat must have the Linux host-gateway compatibility mapping");
expect(!napcatBlock.includes("env_file:"), "NapCat must not receive Core/provider secrets");
expect(napcatBlock.includes(`${contract.paths.napcatAccounts}/\${NAPCAT_ACCOUNT_ID:-primary}/config-full`)
  && napcatBlock.includes(`${contract.paths.napcatAccounts}/\${NAPCAT_ACCOUNT_ID:-primary}/qq`)
  && napcatBlock.includes(`${contract.paths.napcatAccounts}/\${NAPCAT_ACCOUNT_ID:-primary}/plugins`),
"NapCat must mount only its account-scoped state boundary");
expect(napcatBlock.includes("io.sunabot.account-id")
  && napcatBlock.includes("napcat-${NAPCAT_ACCOUNT_ID:-primary}"),
"NapCat must expose a stable account label and private DNS alias");
expect(compose.includes("external: true"), "the shared Core/NapCat network must be launcher-owned");
expect(compose.includes("io.sunabot.runtime-id")
  && compose.includes("io.sunabot.workspace-id")
  && compose.includes("io.sunabot.component"),
"both services and the network must carry runtime ownership labels");

const node = lock.components.node;
const napcat = lock.components.napcat;
const codex = lock.components["codex-cli"];
const officeParser = lock.components.officeparser;
expect(coreDockerfile.includes(`${node.image}@${node.digest}`),
  "Core Dockerfile must pin the Node image digest");
expect(!/napcat|\/opt\/QQ|xvfb-run/i.test(coreDockerfile),
  "Core Dockerfile must not contain QQ or NapCat");
expect(coreDockerfile.includes("dist/apps/api/main.js")
  && coreDockerfile.includes(contract.capabilities.workspaceBash.executable),
"Core image must run the API and contain bubblewrap");
expect(!coreDockerfile.toLowerCase().includes("libreoffice"),
  "Core image must not install the retired LibreOffice runtime");
expect(coreDockerfile.includes("COPY tooling/runtime ./tooling/runtime"),
  "Core build stage must include API runtime helper modules");
expect(officeParser?.version === "7.2.3",
  "Office parser must stay on the reviewed release");
expect(codex.optional !== true
  && codex.version === contract.capabilities.codexCli.version
  && codex.package === "@openai/codex"
  && /^sha512-[A-Za-z0-9+/]+=*$/.test(codex.integrity ?? ""),
"Codex component lock must pin the required npm package and integrity");
expect(coreDockerfile.includes(`ARG CODEX_CLI_VERSION=${codex.version}`)
  && coreDockerfile.includes('"@openai/codex@${CODEX_CLI_VERSION}"')
  && coreDockerfile.includes('test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"'),
"Core image must install and smoke-test the pinned Codex CLI");
expect(coreBlock.includes("SUNABOT_CODEX_EXECUTABLE: /usr/local/bin/codex")
  && coreBlock.includes("SUNABOT_CODEX_BIN: /usr/local/bin/codex"),
"Docker Core must use the pinned in-image Codex executable");
expect(napcatDockerfile.includes(`${napcat.image}@${napcat.digest}`),
  "NapCat wrapper must pin the multi-architecture upstream digest");
expect(napcat.architectures.includes("linux/amd64") && napcat.architectures.includes("linux/arm64"),
  "NapCat lock must cover amd64 and arm64");
expect(napcatEntrypoint.includes("cp -an") && napcatEntrypoint.includes("/app/entrypoint.sh"),
  "NapCat wrapper must seed missing defaults without replacing launcher configuration");
expect(launcher.includes("config.enableLocalFile2Url = true"),
  "the launcher must configure a Base64 get_file fallback across the component boundary");
expect(launcher.includes("loadNapcatAccounts") && launcher.includes('url.searchParams.set("account_id", account.id)'),
  "the launcher must discover and route every registered NapCat account");
expect(!coreHealthcheck.includes("supervisor-state")
  && coreHealthcheck.includes("contract.network.admin.port")
  && coreHealthcheck.includes("contract.network.onebot.internalPort"),
  "Core healthcheck must not depend on the removed combined supervisor");

for (const [name, component] of Object.entries(lock.components ?? {})) {
  expect(Array.isArray(component.architectures) && component.architectures.length > 0,
    `${name} must declare architectures`);
  expect(Array.isArray(component.smoke) && component.smoke.length > 0,
    `${name} must declare a smoke command`);
  expect(Boolean(component.source) && Boolean(component.license),
    `${name} must declare source and license status`);
  if (component.image) {
    expect(/^sha256:[a-f0-9]{64}$/.test(component.digest ?? ""),
      `${name} image must pin a sha256 digest`);
  }
}

expect(apiServer.includes("SUNABOT_ONEBOT_HOST")
  && apiServer.includes("SUNABOT_ONEBOT_PORT")
  && apiServer.includes("assertOneBotAccessToken")
  && apiServer.includes('request.url?.split("?", 1)[0] === "/healthz"'),
"Core must expose a separate authenticated OneBot listener with liveness");
expect(`${launcher}\n${launcherCore}`.includes("SUNABOT_CORE_MODE")
  && launcherCore.includes("nativeAdvertisedUrls")
  && launcher.includes("configureNapcat")
  && launcherShell.includes("tooling/runtime/launcher.mjs"),
"the root launcher must select the Core mode and configure independent NapCat");
expect(launcher.includes("waitForComponentHealth")
  && launcher.includes("assertNonRootRuntimeUser")
  && launcher.includes("docker-network-gateway")
  && launcher.includes("nativeProcessEnvironment"),
"the launcher must enforce readiness, non-root ownership, private Native ingress and one runtime environment");
expect(launcher.includes("recoverStaleDockerOneoffs")
  && dockerRecovery.includes("com.docker.compose.oneoff=true")
  && dockerRecovery.includes("colima restart"),
  "the launcher must detect stale Compose probes and keep Colima recovery interactive");
expect(launcher.includes("assertDockerCoreCodex")
  && launcher.includes("inspectDockerCodex")
  && launcher.includes("inspectNativeCodex")
  && launcher.includes("codexAuth"),
"the launcher and doctor must validate Codex CLI and workspace auth in both Core modes");
expect(launcher.includes("Apple Silicon Docker") && launcher.includes("EINVAL"),
  "the launcher must preserve the observed Apple Silicon amd64 user-namespace failure detail");
expect(agentsGuide.includes("NapCat") && agentsGuide.includes("独立 Docker")
  && !agentsGuide.includes("Linux Native/Docker 继续使用共享 workspace"),
"AGENTS must enforce the split-runtime portability rules");

if (errors.length > 0) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runtimeId: contract.runtimeId,
    schemaVersion: contract.schemaVersion,
    releaseVersion: contract.releaseVersion,
    nodeVersion: contract.nodeVersion,
    platforms: contract.supportedPlatforms,
    components: Object.keys(lock.components),
    composeServices: serviceNames
  }, null, 2)}\n`);
}

function serviceBlock(source, name, nextName) {
  const start = source.indexOf(`\n  ${name}:`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:`, start + 1) : source.indexOf("\nnetworks:", start + 1);
  return start >= 0 ? source.slice(start, end >= 0 ? end : undefined) : "";
}

function validWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function hasBubblewrapSeccompRules(profile) {
  const clone = profile.syscalls?.find((rule) => rule.names?.includes("clone") && rule.action === "SCMP_ACT_ALLOW");
  const mount = profile.syscalls?.find((rule) =>
    ["mount", "pivot_root", "umount2"].every((name) => rule.names?.includes(name))
  );
  return profile.defaultAction === "SCMP_ACT_ERRNO" && Boolean(clone) && mount?.action === "SCMP_ACT_ALLOW";
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}
