// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restartCoreRuntime } from "../../tooling/runtime/launcher.mjs";
import { composeProjectName, resolveLauncherContract, workspaceIdentity } from "../../tooling/runtime/launcher-core.mjs";
import { readProcessSignature } from "../../tooling/runtime/process-signature.mjs";
import { listNativeCoreProcessGroups, stopNativeCoreProcessGroups } from "../../tooling/runtime/native-core-process.mjs";
import { listNativeWebfetchRendererProcessGroups, stopNativeWebfetchRendererProcessGroups } from "../../tooling/runtime/native-webfetch-renderer-process.mjs";
import { listAccountRuntimeProcesses, stopAccountRuntimeProcesses } from "../../tooling/runtime/account-runtime-daemon.mjs";

// External engine and workspace/provider probes are fixtures; process identity,
// shutdown, startup, HTTP readiness and the account daemon use production code.
vi.mock("../../tooling/runtime/native-webfetch-renderer.mjs", () => ({
  prepareNativeWebfetchRendererInstallation: async (context: any) => ({
    supervisorEntry: path.join(context.root, "fixture/native-webfetch-renderer-supervisor.mjs")
  }),
  createNativeWebfetchRendererLaunch: async (context: any, installation: any) => {
    const runRoot = await fs.mkdtemp(path.join(context.workspace, "renderer-"));
    return {
      executable: process.execPath, args: [installation.supervisorEntry], runRoot,
      logPath: path.join(context.workspace, "renderer.log"), runtimeIsolation: "linux-bubblewrap",
      environment: { ...process.env, SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID: context.identity,
        FIXTURE_PORT: String(context.contract.webfetchRendererPort) }
    };
  },
  verifyNativeWebfetchRendererIsolation: async () => {}
}));
vi.mock("../../tooling/runtime/probe.mjs", async (original) => ({
  ...await original<any>(),
  collectWorkspaceProbeFacts: async (options: any) => ({
    workspace: { path: options.workspace, exists: true, migrationState: "trusted" },
    accounts: [], capabilities: {}, conflicts: options.conflicts
  })
}));

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures: any[] = [];
const foreignChildren: ChildProcess[] = [];

afterEach(async () => {
  for (const context of fixtures.splice(0)) {
    const daemon = { workspace: context.workspace, workspaceId: context.identity,
      entry: path.join(context.root, "tooling/runtime/account-runtime-daemon.mjs") };
    await stopAccountRuntimeProcesses({ ...daemon, processes: await listAccountRuntimeProcesses(daemon), timeoutMs: 1000 });
    const core = { root: context.root, workspace: context.workspace };
    await stopNativeCoreProcessGroups({ ...core, groups: await listNativeCoreProcessGroups(core), timeoutMs: 1000 });
    const renderer = { workspaceId: context.identity };
    await stopNativeWebfetchRendererProcessGroups({ ...renderer,
      groups: await listNativeWebfetchRendererProcessGroups(renderer), timeoutMs: 1000 });
    for (const child of foreignChildren.splice(0)) child.kill("SIGTERM");
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")("Core-only restart", () => {
  it("replaces Native processes while retaining NapCat, network, credentials and unrelated processes", async () => {
    const context = await fixture();
    const foreign = spawn(process.execPath, [context.apiEntry], {
      detached: true, stdio: "ignore", env: { ...process.env, FIXTURE_FOREIGN: "1", SUNABOT_WORKSPACE: `${context.workspace}-other` }
    });
    foreignChildren.push(foreign);
    await restartCoreRuntime(context);
    const before = JSON.parse(await fs.readFile(context.statePath, "utf8"));
    await restartCoreRuntime(context);
    const after = JSON.parse(await fs.readFile(context.statePath, "utf8"));
    for (const key of ["core", "reconciler", "webfetchRenderer"]) {
      expect(after[key].pid).not.toBe(before[key].pid);
      await expect(readProcessSignature(before[key].pid)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readProcessSignature(after[key].pid)).toBe(after[key].signature);
    }
    expect(await readProcessSignature(foreign.pid)).toBeTruthy();
    expect(after.reverseWebSocket).toBe(before.reverseWebSocket);
    expect(after.onebotListenHost).toBe(before.onebotListenHost);
    expect(after.accounts).toEqual(before.accounts);
    await expectPreserved(context);
  }, 45_000);

  it.each(["dependency", "build"])("keeps the old Core alive on %s preflight failure", async (failure) => {
    const context = await fixture();
    await restartCoreRuntime(context);
    const before = await fs.readFile(context.statePath, "utf8");
    if (failure === "dependency") {
      context.runtimeEnvironment.SUNABOT_CODEX_EXECUTABLE = "/missing-fixture-codex";
    } else {
      await fs.writeFile(path.join(context.root, "package.json"), JSON.stringify({ type: "module",
        scripts: { build: 'node -e "process.exit(42)"' } }));
    }
    await expect(restartCoreRuntime(context)).rejects.toThrow(failure === "dependency" ? "Native Codex CLI" : "42");
    expect(await fs.readFile(context.statePath, "utf8")).toBe(before);
    expect(await readProcessSignature(JSON.parse(before).core.pid)).toBeTruthy();
    await expectPreserved(context);
  }, 30_000);

  it("cleans failed Native startup without losing NapCat state and supports retry", async () => {
    const context = await fixture();
    context.runtimeEnvironment.FIXTURE_FAIL_CORE = "1";
    await expect(restartCoreRuntime(context)).rejects.toThrow("健康检查超时");
    const failed = JSON.parse(await fs.readFile(context.statePath, "utf8"));
    expect(failed.core).toBeUndefined();
    expect(failed.webfetchRenderer).toBeUndefined();
    expect(failed.reconciler).toBeUndefined();
    expect(failed.reverseWebSocket).toContain("/onebot/v11/ws");
    expect(await listNativeCoreProcessGroups(context)).toEqual([]);
    expect(await listNativeWebfetchRendererProcessGroups({ workspaceId: context.identity })).toEqual([]);
    await expectPreserved(context);
    delete context.runtimeEnvironment.FIXTURE_FAIL_CORE;
    await restartCoreRuntime(context);
    expect(JSON.parse(await fs.readFile(context.statePath, "utf8")).core.pid).toBeGreaterThan(1);
    await expectPreserved(context);
  }, 30_000);

  it.each(["state", "network"])("rejects missing %s without mutating the deployment", async (missing) => {
    const context = await fixture();
    if (missing === "state") await fs.rm(context.statePath);
    else context.runtimeEnvironment.FIXTURE_NO_NETWORK = "1";
    await expect(restartCoreRuntime(context)).rejects.toMatchObject({
      code: missing === "state" ? "CORE_RESTART_STATE_MISSING" : "DOCKER_NETWORK_IDENTITY_INVALID"
    });
    expect(await listNativeCoreProcessGroups(context)).toEqual([]);
    await expectPreserved(context);
  });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-core-restart-"));
  const workspace = path.join(root, "workspace");
  const identity = workspaceIdentity(workspace);
  const raw = JSON.parse(await fs.readFile(path.join(sourceRoot, "deploy/runtime-contract.json"), "utf8"));
  const contract = resolveLauncherContract(raw, { root, platform: "linux", wsl: false });
  contract.adminPort = await freePort();
  contract.onebotPort = await freePort();
  contract.webfetchRendererPort = await freePort();
  contract.coreReadyTimeoutSeconds = 1;
  contract.shutdownTimeoutSeconds = 2;
  const project = composeProjectName(contract.composeBase, identity);
  for (const dir of ["tooling", "packages/platform"]) {
    await fs.cp(path.join(sourceRoot, dir), path.join(root, dir), { recursive: true });
  }
  for (const dir of ["bin", "fixture", "node_modules", "dist/apps/api", "apps/admin-web/dist",
    "workspace/secrets/codex", "workspace/runtime/napcat/accounts/qq_fixture/qq"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "AGENTS.md"), "fixture");
  await fs.writeFile(path.join(root, "package-lock.json"), "{}");
  await fs.writeFile(path.join(root, "node_modules/.package-lock.json"), "{}");
  const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_TRACE"
case "$1 $2" in
  'info '*|'compose version') exit 0 ;;
  'network ls') [ "$FIXTURE_NO_NETWORK" = 1 ] || printf '%s\\t%s\\n' '${project}-runtime' '${identity}'; exit 0 ;;
  'ps -a') case "$*" in *label=io.sunabot.workspace-id*) printf '%s\\n' 'fixture-container\tnapcat\trunning\t${project}-napcat-qq_fixture\tqq_fixture\tfalse\tfixture\t${contract.runtimeId}\t${identity}' ;; esac; exit 0 ;;
esac
echo "unexpected Docker mutation: $*" >&2
exit 97
`;
  await fs.writeFile(path.join(root, "bin/docker"), docker, { mode: 0o755 });
  await fs.writeFile(path.join(root, "bin/codex"), "#!/bin/sh\necho 'codex-cli 0.162.1'\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "fixture/native-webfetch-renderer-supervisor.mjs"), `
import http from 'node:http';
import fs from 'node:fs';
fs.createReadStream(null, {fd: 3}).resume();
http.createServer((req,res) => res.end(JSON.stringify({ok:true,engine:'lightpanda',runtimeIsolation:'linux-bubblewrap'})))
  .listen(Number(process.env.FIXTURE_PORT), '127.0.0.1');
`);
  const apiEntry = path.join(root, "dist/apps/api/main.js");
  await fs.writeFile(apiEntry, `
import http from 'node:http';
import fs from 'node:fs';
if (process.env.FIXTURE_FOREIGN) { setInterval(() => {}, 1000); }
else {
  fs.createReadStream(null, {fd: 3}).resume();
  for (const name of ['SUNABOT_PORT','SUNABOT_ONEBOT_PORT']) {
    http.createServer((req,res) => { res.statusCode = process.env.FIXTURE_FAIL_CORE ? 503 : 200; res.end('ok'); })
      .listen(Number(process.env[name]), '127.0.0.1');
  }
}
`);
  const webEntry = path.join(root, "apps/admin-web/dist/index.html");
  await fs.writeFile(webEntry, "fixture");
  const context = { root, workspace, identity, project, contract, apiEntry, webEntry,
    dev: false, packaged: false, environment: { ...process.env },
    runtimeEnvironment: { PATH: `${root}/bin:${process.env.PATH}`, SUNABOT_CODEX_EXECUTABLE: `${root}/bin/codex`,
      FIXTURE_TRACE: `${root}/docker-trace`, SUNABOT_PROXY_MODE: "off" } as Record<string, string>,
    statePath: `${workspace}/runtime/launcher-state.json`, coreLog: `${workspace}/core.log`,
    reconcilerLog: `${workspace}/reconciler.log` };
  await fs.writeFile(context.statePath, JSON.stringify({ mode: "native", workspaceId: identity,
    onebotListenHost: "127.0.0.1", reverseWebSocket: `ws://host.docker.internal:${contract.onebotPort}/onebot/v11/ws`,
    accounts: [{ id: "qq_fixture", webuiPort: 6099 }] }));
  await fs.writeFile(`${workspace}/secrets/runtime.env`, "ONEBOT_ACCESS_TOKEN=fixture-token\n");
  await fs.writeFile(`${workspace}/runtime/napcat/accounts/qq_fixture/qq/login-cache`, "persistent-login");
  fixtures.push(context);
  return context;
}

async function expectPreserved(context: any) {
  const calls = (await fs.readFile(`${context.root}/docker-trace`, "utf8")).trim().split("\n");
  expect(calls.every((line) => /^(info|ps |network ls|compose version)/u.test(line))).toBe(true);
  expect(await fs.readFile(`${context.workspace}/secrets/runtime.env`, "utf8")).toBe("ONEBOT_ACCESS_TOKEN=fixture-token\n");
  expect(await fs.readFile(`${context.workspace}/runtime/napcat/accounts/qq_fixture/qq/login-cache`, "utf8")).toBe("persistent-login");
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
