// @vitest-environment node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspaceBashEnvironment, buildBubblewrapInvocation, ensureWorkspaceBashIsolation } from "../../services/tools/bashSandbox.js";
import { bubblewrapProbeArguments } from "../../tooling/runtime/launcher.mjs";

const supported = process.platform === "linux" && process.getuid?.() !== 0
  && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/python3");
const execute = promisify(execFile);
const environment = buildWorkspaceBashEnvironment();
let workbench = "";
let load: ChildProcess | undefined;

describe.skipIf(!supported)("real Linux Native tool sandbox", () => {
  beforeAll(async () => {
    workbench = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-native-runtime-"));
    load = spawn("/usr/bin/python3", ["-c", [
      "import threading, time",
      "event = threading.Event()",
      "threads = [threading.Thread(target=event.wait, daemon=True) for _ in range(80)]",
      "for thread in threads: thread.start()",
      "print('ready', flush=True)",
      "time.sleep(120)"
    ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      load!.once("error", reject);
      load!.once("exit", (code) => reject(new Error(`load exited before readiness: ${code}`)));
      load!.stdout!.once("data", (data) => String(data).includes("ready")
        ? resolve() : reject(new Error("load did not report readiness")));
    });
  });

  afterAll(async () => {
    if (load && load.exitCode === null) {
      const exited = new Promise<void>((resolve) => load!.once("exit", () => resolve()));
      load.kill("SIGTERM");
      await exited;
    }
    if (workbench) await fs.rm(workbench, { recursive: true, force: true });
  });

  it("executes Bash, Node and Python with more than 64 host threads", async () => {
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment)).resolves.toMatchObject({ kind: "bubblewrap" });
    const invocation = buildBubblewrapInvocation({ kind: "shell", command:
      "node -e 'console.log(3+5)' && python3 -c 'print(3+5)' && test ! -e /mnt && test ! -e /root/.ssh"
    }, workbench, environment);
    const result = await execute(invocation.file, invocation.args, { env: environment, timeout: 10_000 });
    expect(result.stdout).toBe("8\n8\n");
  });

  it("continues enforcing the thread limit inside the new namespace", async () => {
    const invocation = buildBubblewrapInvocation({ kind: "argv", executable: "/usr/bin/python3", args: ["-c", [
      "import errno, os",
      "try:",
      "    pid = os.fork()",
      "except OSError as error:",
      "    assert error.errno == errno.EAGAIN",
      "    print('limited')",
      "else:",
      "    if pid == 0: os._exit(0)",
      "    os.waitpid(pid, 0)",
      "    raise AssertionError('fork exceeded the limit')"
    ].join("\n")] }, workbench, environment);
    invocation.args = invocation.args.map((value) => value === "--nproc=64:64" ? "--nproc=1:1" : value);
    const result = await execute(invocation.file, invocation.args, { env: environment, timeout: 10_000 });
    expect(result.stdout).toBe("limited\n");
  });

  it("applies the same resource limits in the launcher health probe", async () => {
    const args = bubblewrapProbeArguments(workbench, true);
    await expect(execute("/usr/bin/bwrap", args, { timeout: 10_000 })).resolves.toMatchObject({ stderr: "" });
    const limited = args.map((value) => value === "--as=4294967296:4294967296"
      ? "--as=536870912:536870912" : value);
    await expect(execute("/usr/bin/bwrap", limited, { timeout: 10_000 })).rejects.toThrow();
  });
});
