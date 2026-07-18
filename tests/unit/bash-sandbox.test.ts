// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_BASH_ISOLATION_ERROR,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  WorkspaceBashIsolationError,
  buildBubblewrapInvocation,
  buildDockerInvocation,
  ensureWorkspaceBashIsolation
} from "../../services/tools/bashSandbox.js";
import {
  WORKSPACE_BASH_ADMIN_EXECUTABLE,
  WORKSPACE_BASH_RESTRICTED_EXECUTABLES
} from "../../services/tools/bashPolicy.js";

const workbench = "/srv/sunabot/workspace/business/agents/plana/workbench";
const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: WORKSPACE_BASH_VIRTUAL_ROOT,
  PWD: WORKSPACE_BASH_VIRTUAL_ROOT,
  TMPDIR: "/tmp/",
  TMP: "/tmp",
  TEMP: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "",
  SHELL: "/bin/bash",
  USER: "sunabot"
};

describe("workspace Bash isolation", () => {
  it.each([
    ["path", "printf x > /tmp/outside"],
    ["symlink", "ln -s /tmp escape && printf x > escape/outside"],
    ["mount", "mount --bind . /tmp/escape"],
    ["subprocess", "python3 -c 'open(\"/tmp/outside\", \"w\").write(\"x\")'"]
  ])("uses resource-limited minimal bubblewrap for the %s bypass", (_kind, command) => {
    const invocation = buildBubblewrapInvocation({ kind: "shell", command }, workbench, environment);

    expect(invocation.file).toBe("/usr/bin/prlimit");
    expect(invocation.args.slice(0, 6)).toEqual([
      "--nproc=64:64",
      "--as=536870912:536870912",
      "--nofile=128:128",
      "--fsize=268435456:268435456",
      "--core=0:0",
      "--"
    ]);
    expect(invocation.args).toContain("/usr/bin/bwrap");
    expect(hasSequence(invocation.args, ["--tmpfs", "/"])).toBe(true);
    expect(hasSequence(invocation.args, ["--ro-bind", "/", "/"])).toBe(false);
    expect(hasSequence(invocation.args, ["--bind", workbench, WORKSPACE_BASH_VIRTUAL_ROOT])).toBe(true);
    expect(hasSequence(invocation.args, ["--chdir", WORKSPACE_BASH_VIRTUAL_ROOT])).toBe(true);
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--cap-drop", "ALL", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-cgroup", "--clearenv"
    ]));
    expect(hasSequence(invocation.args, ["--setenv", "HOME", WORKSPACE_BASH_VIRTUAL_ROOT])).toBe(true);
    expect(hasSequence(invocation.args, ["--setenv", "PWD", WORKSPACE_BASH_VIRTUAL_ROOT])).toBe(true);
    expect(hasSequence(invocation.args, ["--setenv", "TMPDIR", "/tmp/"])).toBe(true);
    expect(hasSequence(invocation.args, ["--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin"])).toBe(true);
    expect(invocation.args.slice(-6)).toEqual([
      "--", "/bin/bash", "--noprofile", "--norc", "-lc", command
    ]);
  });

  it("executes restricted argv directly without Bash or PATH lookup", () => {
    const invocation = buildBubblewrapInvocation({
      kind: "argv",
      executable: "/usr/bin/ls",
      args: ["-la"]
    }, workbench, environment);

    expect(invocation.args.slice(-3)).toEqual(["--", "/usr/bin/ls", "-la"]);
    expect(invocation.args).not.toContain("-lc");
  });

  it("binds an explicitly approved native file read-only", () => {
    const invocation = buildBubblewrapInvocation(
      { kind: "shell", command: "cat /var/log/app.log" },
      workbench,
      environment,
      "/fixture/bwrap",
      [{ path: "/var/log/app.log", access: "read" }],
      "/fixture/prlimit"
    );

    expect(hasSequence(invocation.args, ["--ro-bind", "/var/log/app.log", "/var/log/app.log"])).toBe(true);
  });

  it.each(["write", "delete"] as const)("rejects a forged outside %s bind", (access) => {
    expect(() => buildBubblewrapInvocation(
      { kind: "shell", command: "printf x" },
      workbench,
      environment,
      "/fixture/bwrap",
      [{ path: "/opt/sunabot/output", access }],
      "/fixture/prlimit"
    )).toThrow("read-only");
  });

  it.each([
    "relative/path",
    "/",
    "/var",
    "/srv/sunabot/workspace/business/agents/plana",
    "/srv/sunabot/workspace/business/agents/plana/../other"
  ])("rejects invalid or overbroad approved bind: %s", (outsidePath) => {
    expect(() => buildBubblewrapInvocation(
      { kind: "shell", command: "cat file" },
      workbench,
      environment,
      "/fixture/bwrap",
      [{ path: outsidePath, access: "read" }],
      "/fixture/prlimit"
    )).toThrow(WorkspaceBashIsolationError);
  });

  it("mounts only workbench into a named short-lived Docker container", () => {
    const containerName = `sunabot-bash-${"a".repeat(32)}`;
    const invocation = buildDockerInvocation(
      { kind: "shell", command: "echo ok" },
      "/host/agent/workbench",
      "/fixture/docker",
      "sunabot-bash:test",
      containerName
    );

    expect(invocation.file).toBe("/fixture/docker");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--pull", "never", "--name", containerName, "--read-only", "--cap-drop", "ALL",
      "--network", "none",
      "--security-opt", "no-new-privileges:true",
      "--ulimit", "fsize=268435456:268435456",
      "--mount", "type=bind,src=/host/agent/workbench,dst=/workbench",
      "--workdir", "/workbench", "--entrypoint", "/usr/bin/env", "sunabot-bash:test"
    ]));
    expect(invocation.args.slice(invocation.args.indexOf("sunabot-bash:test"))).toEqual([
      "sunabot-bash:test", "-i",
      "HOME=/workbench", "PWD=/workbench", "PATH=/usr/local/bin:/usr/bin:/bin",
      "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TMPDIR=/tmp", "TMP=/tmp", "TEMP=/tmp",
      "SHELL=/bin/bash", "USER=sunabot",
      "/bin/bash", "--noprofile", "--norc", "-lc", "echo ok"
    ]);
    for (const variable of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"
    ]) {
      expect(hasSequence(invocation.args, ["--env", `${variable}=`])).toBe(true);
    }
    expect(invocation.cleanup).toMatchObject({ file: "/fixture/docker", args: ["rm", "-f", containerName] });
    expect(invocation.cleanup?.env).toBe(invocation.env);
    expect(invocation.args.join(" ")).not.toContain("docker.sock");
  });

  it("runs restricted Docker argv directly with an unpredictable container name", () => {
    const invocation = buildDockerInvocation(
      { kind: "argv", executable: "/usr/bin/ls", args: ["-la"] },
      "/host/agent/workbench",
      "/fixture/docker",
      "sunabot-bash:test"
    );

    const name = invocation.args[invocation.args.indexOf("--name") + 1];
    expect(name).toMatch(/^sunabot-bash-[a-f0-9]{32}$/);
    expect(hasSequence(invocation.args, ["--network", "none"])).toBe(true);
    expect(hasSequence(invocation.args, ["--entrypoint", "/usr/bin/env"])).toBe(true);
    expect(invocation.args.slice(-2)).toEqual(["/usr/bin/ls", "-la"]);
    expect(invocation.args.indexOf("-i")).toBeLessThan(invocation.args.indexOf("/usr/bin/ls"));
  });

  it("rejects macOS Native Bash without probing or falling back to host Bash", async () => {
    const probe = vi.fn(async () => undefined);

    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "darwin",
      probe
    })).rejects.toMatchObject({
      name: "WorkspaceBashIsolationError",
      code: WORKSPACE_BASH_ISOLATION_ERROR
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("allows macOS restricted Bash only through the Docker image probe", async () => {
    const probe = vi.fn(async () => undefined);

    await expect(ensureWorkspaceBashIsolation("docker", workbench, environment, {
      platform: "darwin",
      runtimeMode: "native",
      effectiveUid: 1_000,
      dockerExecutable: "/fixture/docker",
      dockerImage: "sunabot-bash:test",
      access: async () => undefined,
      probe
    })).resolves.toMatchObject({
      kind: "docker",
      executable: "/fixture/docker",
      image: "sunabot-bash:test"
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("/fixture/docker");
    const probeArgs = probe.mock.calls[0]?.[1] ?? [];
    expect(probeArgs).toEqual(expect.arrayContaining([
      "run", "--rm", "--pull", "never", "--network", "none",
      "--entrypoint", "/usr/bin/env", "sunabot-bash:test", "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin", "/bin/bash", "--noprofile", "--norc", "-ec"
    ]));
    const probeScript = probeArgs.at(-1) ?? "";
    for (const executable of [
      "/usr/bin/env",
      "/usr/bin/test",
      WORKSPACE_BASH_ADMIN_EXECUTABLE,
      ...WORKSPACE_BASH_RESTRICTED_EXECUTABLES
    ]) {
      expect(probeScript).toContain(executable);
    }
    expect(probe.mock.calls[0]?.[2]).toEqual({ env: expect.any(Object) });
  });

  it("fails closed for a root Docker host runtime", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(ensureWorkspaceBashIsolation("docker", workbench, environment, {
      platform: "darwin",
      runtimeMode: "native",
      effectiveUid: 0,
      probe
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when bubblewrap is missing", async () => {
    const probe = vi.fn();
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      probe
    })).rejects.toMatchObject({
      name: "WorkspaceBashIsolationError",
      code: WORKSPACE_BASH_ISOLATION_ERROR
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed for a root Native runtime because RLIMIT_NPROC would not be enforceable", async () => {
    const probe = vi.fn();
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 0,
      access: async () => undefined,
      probe
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when the Native process limiter is missing", async () => {
    const probe = vi.fn();
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      executable: "/fixture/bwrap",
      resourceLimiter: "/fixture/prlimit",
      access: async (file) => {
        if (file.endsWith("prlimit")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      probe
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when any fixed restricted executable is missing", async () => {
    const probe = vi.fn();
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      executable: "/fixture/bwrap",
      resourceLimiter: "/fixture/prlimit",
      access: async (file) => {
        if (file === "/usr/bin/base64") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      probe
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes the hard resource limits together with bubblewrap namespaces", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      executable: "/fixture/bwrap",
      resourceLimiter: "/fixture/prlimit",
      access: async () => undefined,
      probe
    })).resolves.toEqual({
      kind: "bubblewrap",
      executable: "/fixture/bwrap",
      resourceLimiter: "/fixture/prlimit"
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("/fixture/prlimit");
    expect(probe.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "--nproc=64:64", "--as=536870912:536870912", "/fixture/bwrap",
      "--unshare-pid", "--unshare-net", "--unshare-cgroup"
    ]));
  });

  it("fails closed when the resource or kernel isolation probe is rejected", async () => {
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      access: async () => undefined,
      probe: async () => { throw new Error("user namespaces disabled"); }
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
  });

  it("uses bubblewrap inside Docker Core without requiring a Docker socket", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(ensureWorkspaceBashIsolation("docker", workbench, environment, {
      platform: "linux",
      runtimeMode: "docker",
      effectiveUid: 1_000,
      executable: "/fixture/bwrap",
      resourceLimiter: "/fixture/prlimit",
      access: async () => undefined,
      probe
    })).resolves.toMatchObject({ kind: "bubblewrap" });
    expect(probe.mock.calls[0]?.[1].join(" ")).not.toContain("docker.sock");
  });
});

function hasSequence(values: string[], sequence: string[]) {
  return values.some((_value, index) => sequence.every((expected, offset) => values[index + offset] === expected));
}
