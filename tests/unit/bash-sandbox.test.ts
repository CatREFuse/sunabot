// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_BASH_ISOLATION_ERROR,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  WorkspaceBashIsolationError,
  buildBubblewrapInvocation,
  buildHostNativeInvocation,
  ensureWorkspaceBashIsolation,
  resolveWorkspaceBashSandboxExecutable
} from "../../services/tools/bashSandbox.js";

const workbench = "/srv/sunabot/workspace/business/agents/plana/workbench";
const readOnlyMounts = {
  skills: "/srv/sunabot/workspace/business/agents/plana/workbench/skills",
  mcp: "/srv/sunabot/workspace/business/agents/plana/extensions/mcp"
};
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
  it("uses only an absolute launcher-injected Bubblewrap path in packaged runtimes", () => {
    expect(resolveWorkspaceBashSandboxExecutable({
      SUNABOT_BWRAP_EXECUTABLE: "/opt/sunabot/current/runtime/bubblewrap/bwrap",
      SUNABOT_PACKAGED_RELEASE: "1"
    })).toBe("/opt/sunabot/current/runtime/bubblewrap/bwrap");
    expect(resolveWorkspaceBashSandboxExecutable({})).toBe("/usr/bin/bwrap");
    expect(() => resolveWorkspaceBashSandboxExecutable({ SUNABOT_PACKAGED_RELEASE: "1" }))
      .toThrow(WorkspaceBashIsolationError);
    for (const value of ["relative/bwrap", "/opt/../usr/bin/bwrap", "/opt/bwrap\nforged"]) {
      expect(() => resolveWorkspaceBashSandboxExecutable({
        SUNABOT_BWRAP_EXECUTABLE: value,
        SUNABOT_PACKAGED_RELEASE: "1"
      })).toThrow(WorkspaceBashIsolationError);
    }
  });

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

  it("binds Native Bash Skill and MCP configuration read-only", () => {
    const invocation = buildBubblewrapInvocation(
      { kind: "shell", command: "ls /skills /mcp" },
      workbench,
      environment,
      "/fixture/bwrap",
      [],
      "/fixture/prlimit",
      readOnlyMounts
    );

    expect(hasSequence(invocation.args, ["--ro-bind", readOnlyMounts.skills, "/skills"])).toBe(true);
    expect(hasSequence(invocation.args, ["--ro-bind", readOnlyMounts.mcp, "/mcp"])).toBe(true);
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

  it("uses an audited macOS host Bash for the Native backend", async () => {
    const access = vi.fn(async () => undefined);
    const probe = vi.fn(async () => undefined);

    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "darwin",
      effectiveUid: 501,
      access,
      probe
    })).resolves.toEqual({ kind: "host", executable: "/bin/bash" });
    expect(access).toHaveBeenCalledWith("/bin/bash", expect.any(Number));
    expect(probe).toHaveBeenCalledWith("/bin/bash", ["--noprofile", "--norc", "-lc", ":"]);
  });

  it("builds Native host execution with a sanitized environment and real shared paths", () => {
    expect(buildHostNativeInvocation(
      { kind: "shell", command: "pwd && ls \"$SUNABOT_SKILLS\" \"$SUNABOT_MCP_CONFIG\"" },
      workbench,
      environment,
      "/bin/bash",
      [],
      readOnlyMounts
    )).toMatchObject({
      file: "/bin/bash",
      args: ["--noprofile", "--norc", "-lc", "pwd && ls \"$SUNABOT_SKILLS\" \"$SUNABOT_MCP_CONFIG\""],
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: workbench,
        PWD: workbench,
        SUNABOT_SKILLS: readOnlyMounts.skills,
        SUNABOT_MCP_CONFIG: readOnlyMounts.mcp
      }
    });
  });

  it("fails closed for a root macOS Native runtime", async () => {
    const probe = vi.fn(async () => undefined);

    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "darwin",
      effectiveUid: 0,
      access: async () => undefined,
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
      resourceLimiter: "/fixture/prlimit",
      networkAccess: true
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("/fixture/prlimit");
    expect(probe.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "--nproc=64:64", "--as=536870912:536870912", "/fixture/bwrap",
      "--unshare-pid", "--unshare-cgroup"
    ]));
    expect(probe.mock.calls[0]?.[1]).not.toContain("--unshare-net");
  });

  it("fails closed when the resource or kernel isolation probe is rejected", async () => {
    await expect(ensureWorkspaceBashIsolation("native", workbench, environment, {
      platform: "linux",
      effectiveUid: 1_000,
      access: async () => undefined,
      probe: async () => { throw new Error("user namespaces disabled"); }
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
  });

});

function hasSequence(values: string[], sequence: string[]) {
  return values.some((_value, index) => sequence.every((expected, offset) => values[index + offset] === expected));
}
