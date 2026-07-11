import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root, { requireExplicit: true });
const port = Number(process.env.SUNABOT_SMOKE_PORT ?? "18877");
const host = "127.0.0.1";

await assertPortFree(host, port);
const child = spawn(process.execPath, ["--use-env-proxy", path.join(root, "dist/apps/api/main.js")], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    NODE_ENV: "production",
    SUNABOT_HOST: host,
    SUNABOT_PORT: String(port),
    SUNABOT_WORKSPACE: workspace
  }
});

let output = "";
child.stdout.on("data", (chunk) => { output = appendBounded(output, chunk); });
child.stderr.on("data", (chunk) => { output = appendBounded(output, chunk); });

try {
  const response = await waitForSession(`http://${host}:${port}/api/auth/session`, 30_000);
  if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload !== "object" || payload == null) throw new Error("health endpoint returned an invalid payload");
  console.log(`API smoke passed on ${host}:${port}.`);
} catch (error) {
  if (output.trim()) console.error(output.trim());
  throw error;
} finally {
  await stopChild(child);
}

async function waitForSession(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(2_000) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error("API smoke timed out");
}

function assertPortFree(hostname, portNumber) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(portNumber, hostname, () => server.close(resolve));
  });
}

async function stopChild(processHandle) {
  if (processHandle.exitCode != null || processHandle.signalCode != null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (processHandle.exitCode == null && processHandle.signalCode == null) processHandle.kill("SIGKILL");
}

function appendBounded(current, chunk) {
  return `${current}${String(chunk)}`.slice(-16_000);
}
