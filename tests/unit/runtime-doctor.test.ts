// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("runtime doctor", () => {
  it("accepts an isolated workspace and free port from an arbitrary cwd", async () => {
    const workspace = await temporaryWorkspace();
    const port = await freePort();
    const result = await runDoctor(workspace, port, os.tmpdir());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, expectation: "free" });
  });

  it("rejects a port already owned by another process", async () => {
    const workspace = await temporaryWorkspace();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener did not bind");
    try {
      const result = await runDoctor(workspace, address.port, os.tmpdir());
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, listener: { listening: true } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function temporaryWorkspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener did not bind");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function runDoctor(workspace: string, port: number, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve("tooling/runtime/doctor.mjs"),
      `--port=${port}`
    ], {
      cwd,
      env: { ...process.env, SUNABOT_WORKSPACE: workspace },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

