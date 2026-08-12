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
  packageManifest,
  packageLock,
  compose,
  napcatEntrypoint,
  launcher,
  launcherCore,
  launcherShell,
  installer,
  buildRelease,
  releaseIntegrity,
  nativeRenderer,
  rendererSupervisor,
  rendererMain,
  rendererProxy,
  rendererClient,
  bashSandbox,
  mcpSandbox,
  skillScriptSandbox,
  outboundMedia,
  agentsGuide
] = await Promise.all([
  readJson("deploy/runtime-contract.json"),
  readJson("deploy/runtime-contract.schema.json"),
  readJson("components/component.lock.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  read("deploy/napcat/compose.yml"),
  read("deploy/napcat/napcat-entrypoint.sh"),
  read("tooling/runtime/launcher.mjs"),
  read("tooling/runtime/launcher-core.mjs"),
  read("sunabot.sh"),
  read("install.sh"),
  read("tooling/runtime/build-release.mjs"),
  read("tooling/runtime/release-integrity.mjs"),
  read("tooling/runtime/native-webfetch-renderer.mjs"),
  read("tooling/runtime/native-webfetch-renderer-supervisor.mjs"),
  read("apps/webfetch-renderer/main.ts"),
  read("apps/webfetch-renderer/safeProxy.ts"),
  read("adapters/webfetch/dynamicRendererClient.ts"),
  read("services/tools/bashSandbox.ts"),
  read("adapters/mcp/stdioSandboxLauncher.ts"),
  read("adapters/filesystem/agentSkillScriptSandbox.ts"),
  read("services/delivery/outboundMedia.ts"),
  read("AGENTS.md")
]);

const errors = [
  ...validateNodeVersionEntrypoints(await readNodeVersionContractInputs(root)),
  ...validateOfficeParserContract({ componentLock: lock, packageManifest, packageLock })
];
const expect = (condition, message) => { if (!condition) errors.push(message); };

expect(contract.schemaVersion === 3, "runtime contract schemaVersion must be 3");
expect(schema.properties?.schemaVersion?.const === 3, "runtime schema must fix schemaVersion 3");
expect(contract.runtimeId === "sunabot-qq-runtime", "runtimeId must stay canonical");
expect(contract.releaseVersion === packageManifest.version, "runtime and package release versions must match");
expect(packageLock.version === packageManifest.version
  && packageLock.packages?.[""]?.version === packageManifest.version,
"package lock versions must match package version");
expect(contract.nodeVersion === "24.18.0", "runtime must use pinned Node 24.18.0");
expect(arraysEqual(contract.supportedPlatforms, lock.supportedPlatforms),
  "runtime and component platforms must match");
expect(arraysEqual(contract.supportedPlatforms, ["linux/amd64", "linux/arm64"]),
  "release must support Linux amd64 and arm64");
expect(!("docker" in contract), "runtime contract must not expose a general Docker runtime");

expect(path.isAbsolute(contract.paths.installPrefix) && path.isAbsolute(contract.paths.workspace),
  "installPrefix and workspace must be absolute");
for (const [name, value] of Object.entries(contract.paths)) {
  if (name === "installPrefix" || name === "workspace") continue;
  expect(typeof value === "string" && !path.isAbsolute(value) && !value.split(/[\\/]/u).includes(".."),
    `paths.${name} must be workspace-relative`);
}
expect(contract.paths.napcatAccounts === "runtime/napcat/accounts", "NapCat account root must stay canonical");
expect(JSON.stringify(contract.outboundProxy) === JSON.stringify(PROXY_RUNTIME_CONTRACT),
  "outbound proxy contract must match packages/platform");
expect(contract.mediaTransport?.outbound?.mode === "inline-base64"
  && contract.mediaTransport?.outbound?.sharedFilesystem === false
  && contract.mediaTransport?.inbound?.containerLocalPaths === false,
"Core and NapCat must not share application media paths");
expect(outboundMedia.includes('|| "inline-base64"') && !outboundMedia.includes('value === "shared-path" ||'),
  "media delivery must keep inline base64 as the component boundary");

const napcat = lock.components?.napcat;
expect(contract.napcat?.managedBy === "docker"
  && contract.napcat?.composeFile === "deploy/napcat/compose.yml"
  && contract.napcat?.service === "napcat"
  && contract.napcat?.pullPolicy === "never",
"NapCat must be the only Docker-managed component and use pull-never startup");
expect(contract.napcat?.image === napcat?.image && contract.napcat?.digest === napcat?.digest,
  "NapCat contract must match the locked upstream image digest");
expect(napcat?.redistribution === "local-build-only-pending-review",
  "public release must not claim NapCat redistribution rights");
const composeServices = /^services:\s*$([\s\S]*?)^networks:\s*$/mu.exec(compose)?.[1] ?? "";
const serviceNames = composeServices.split(/\r?\n/u)
  .flatMap((line) => /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line)?.[1] ?? []);
expect(arraysEqual(serviceNames, ["napcat"]), "NapCat Compose must declare only the napcat service");
for (const required of [
  "pull_policy: never",
  "NAPCAT_IMAGE",
  "host.docker.internal:host-gateway",
  "127.0.0.1:${NAPCAT_WEBUI_PORT:-6099}:6099",
  "io.sunabot.account-id",
  "external: true"
]) expect(compose.includes(required), `NapCat Compose missing ${required}`);
expect(!compose.includes("build:") && !compose.includes("SUNABOT_WEBFETCH") && !compose.includes("SUNABOT_CORE"),
  "NapCat Compose must not build or host Core/WebFetch");
expect(napcatEntrypoint.includes("/app/entrypoint.sh"), "NapCat wrapper must delegate to the upstream entrypoint");

expect(contract.native?.core?.managedBy === "launcher", "Core must be launcher-managed Native only");
expect(contract.native?.bubblewrap?.managedBy === "launcher"
  && contract.native.bubblewrap.releaseExecutable === "runtime/bubblewrap/bwrap"
  && contract.native.bubblewrap.executableEnvironment === "SUNABOT_BWRAP_EXECUTABLE"
  && contract.native.bubblewrap.packagedFallback === false
  && contract.native.bubblewrap.verifiedByLauncher === true
  && arraysEqual(contract.native.bubblewrap.consumers, [
    "native-bash", "mcp-stdio", "skill-script", "webfetch-renderer"
  ]),
"Native Bubblewrap consumers must share the verified launcher-owned release executable");
expect(contract.native?.webfetchRenderer?.engine === "lightpanda"
  && contract.native?.webfetchRenderer?.deploymentByPlatform?.linux === "launcher"
  && contract.native?.webfetchRenderer?.deploymentByPlatform?.wsl === "launcher"
  && contract.native?.webfetchRenderer?.deploymentByPlatform?.macos === "unavailable",
"dynamic WebFetch must use the native Lightpanda launcher on Linux/WSL with explicit macOS degradation");
expect(contract.capabilities?.webfetch?.staticEngine === "node-defuddle"
  && contract.capabilities?.webfetch?.dynamicEngine === "lightpanda"
  && contract.capabilities?.webfetch?.chromium === false
  && contract.capabilities?.webfetch?.telemetry === false,
"WebFetch contract must forbid Chromium and Lightpanda telemetry");
expect(!packageManifest.dependencies?.playwright, "Playwright must not be a production dependency");
for (const [name, source] of Object.entries({ nativeRenderer, rendererSupervisor, rendererMain })) {
  expect(!/playwright|chromium/iu.test(source), `${name} must not contain Playwright or Chromium runtime code`);
}
for (const required of [
  "SUNABOT_WEBFETCH_LIGHTPANDA_EXECUTABLE",
  "LIGHTPANDA_DISABLE_TELEMETRY",
  "context.bubblewrapExecutable",
  "WEBFETCH_LINUX_BUBBLEWRAP_UNAVAILABLE",
  "WEBFETCH_LIGHTPANDA_MISSING"
]) expect(nativeRenderer.includes(required) || rendererSupervisor.includes(required), `native renderer missing ${required}`);
expect(!nativeRenderer.includes("context.runtimeEnvironment?.SUNABOT_BWRAP_EXECUTABLE"),
  "native renderer must not accept a runtime.env Bubblewrap override");
const launcherBubblewrapResolver = /export function bubblewrapExecutable\(context\) \{[\s\S]*?\n\}/u.exec(launcher)?.[0] ?? "";
expect(launcherBubblewrapResolver.includes('context.packaged ? bundled : "/usr/bin/bwrap"')
  && !launcherBubblewrapResolver.includes("runtimeEnvironment")
  && launcher.includes("SUNABOT_BWRAP_EXECUTABLE: bubblewrapExecutable(context)")
  && launcher.includes('SUNABOT_PACKAGED_RELEASE: context.packaged ? "1" : "0"'),
"launcher must pin the bundled release Bubblewrap and mark packaged child processes");
for (const [name, source] of Object.entries({ bashSandbox, mcpSandbox, skillScriptSandbox })) {
  expect(source.includes("SUNABOT_BWRAP_EXECUTABLE")
    && source.includes("SUNABOT_PACKAGED_RELEASE")
    && source.includes('=== "1"'),
  `${name} must consume launcher-owned Bubblewrap and forbid packaged system fallback`);
}
expect(rendererMain.includes('engine: "lightpanda"')
  && rendererMain.includes("execFile")
  && rendererMain.includes("maxBuffer: MAX_DOM_BYTES")
  && rendererMain.includes('killSignal: "SIGKILL"'),
"Lightpanda renderer must be bounded, short-lived and health-identifiable");
expect(rendererProxy.includes('server.on("connect"') && rendererProxy.includes("MAX_RENDER_RESPONSE_BYTES"),
  "renderer proxy must authenticate and bound HTTP and HTTPS traffic");
expect(rendererClient.includes("authorization: `Bearer ${this.authToken}`"),
  "Core must authenticate renderer requests");

const napcatUpFunction = /export function napcatAccountUpArguments[\s\S]*?\n\}\n/u.exec(launcher)?.[0] ?? "";
expect(!launcher.includes("upDocker")
  && !launcher.includes("prepareDockerWebfetchRenderer")
  && !launcher.includes("nativeBashImageComposeArguments")
  && !napcatUpFunction.includes("--build")
  && napcatUpFunction.includes('"--pull", "never"'),
"launcher must run Native Core and never build or pull at startup");
expect(!launcherCore.includes('new Set(["auto", "native", "docker"])')
  && launcherCore.includes("SUNABOT_CORE_MODE 已移除")
  && launcherCore.includes("--core 已移除"),
"launcher arguments must retire Core mode selection");
expect(launcher.includes('"--landing"') && launcher.includes("completeFirstRunBootstrap"),
  "first run must execute and complete the administrator Landing flow");

expect(launcherShell.includes("RELEASE_MANIFEST")
  && launcherShell.includes("RELEASE_DEPENDENCIES_MISSING")
  && launcherShell.includes('exec "$BUNDLED_NODE"')
  && launcherShell.indexOf("npm ci") > launcherShell.indexOf("if [ -f \"$RELEASE_MANIFEST\" ]"),
"packaged startup must use bundled Node/dependencies without npm");
for (const required of [
  "runtime/node/bin/node",
  "runtime/bubblewrap/bwrap",
  "runtime/bubblewrap/SOURCE.txt",
  "runtime/lightpanda/lightpanda",
  "node_modules/.package-lock.json",
  "licenses/lightpanda/LICENSE",
  "sources"
]) expect(buildRelease.includes(required) || releaseIntegrity.includes(required), `release bundle missing ${required}`);
expect(installer.includes("docker pull")
  && installer.includes("docker image inspect")
  && installer.includes('SUNABOT_WORKSPACE="$PREFIX/workspace"')
  && installer.includes(".sha256"),
"installer must verify assets, prepare locked NapCat once and keep a persistent workspace");
expect(!launcher.includes("docker pull") && !launcher.includes('"pull"'),
  "launcher must never download container images");

const codex = lock.components?.["codex-cli"];
expect(packageManifest.dependencies?.["@openai/codex"] === codex?.version
  && contract.capabilities?.codexCli?.version === codex?.version,
"release must bundle the exact locked Codex CLI");
expect(lock.components?.lightpanda?.license === "AGPL-3.0-only"
  && lock.components?.lightpanda?.correspondingSource?.sha256,
"Lightpanda binary must ship with locked corresponding source");
const bubblewrap = lock.components?.bubblewrap;
expect(bubblewrap?.license === "LGPL-2.0-or-later"
  && bubblewrap?.sourceArchives?.length === 3
  && bubblewrap.sourceArchives.every((source) => /^[a-f0-9]{64}$/u.test(source.sha256))
  && bubblewrap.runtimeSourceArchives?.length >= 1
  && bubblewrap.runtimeSourceArchives.every((source) => /^[a-f0-9]{64}$/u.test(source.sha256))
  && contract.supportedPlatforms.every((target) => {
    const runtime = bubblewrap.runtimeDependencies?.[target];
    return typeof runtime?.loader === "string"
      && runtime.needed?.includes("libc.so.6")
      && runtime.needed?.includes("libcap.so.2")
      && runtime.needed?.includes("libselinux.so.1")
      && runtime.needed?.includes("libpcre2-8.so.0")
      && runtime.archives?.every((archive) => /^[a-f0-9]{64}$/u.test(archive.sha256));
  })
  && buildRelease.includes("--inhibit-cache")
  && buildRelease.includes('"--list", binary')
  && buildRelease.includes("bubblewrapNamespaceProbeArguments"),
"Bubblewrap binary, loader, library closure and corresponding Debian sources must be locked and verified");
expect(agentsGuide.includes("NapCat 是唯一 Docker 运行组件")
  && agentsGuide.includes("每个 QQ 使用独立容器"),
  "project guide must preserve the NapCat container exception");

const retiredDockerDirectory = path.join(root, "deploy/docker");
expect(!await exists(retiredDockerDirectory), "deploy/docker must be removed; only deploy/napcat may use Docker");

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    schemaVersion: contract.schemaVersion,
    releaseVersion: contract.releaseVersion,
    core: "native",
    webfetch: contract.capabilities.webfetch.dynamicEngine,
    containerException: contract.napcat.service,
    platforms: contract.supportedPlatforms
  }, null, 2));
}

async function read(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

async function readJson(relative) {
  return JSON.parse(await read(relative));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
