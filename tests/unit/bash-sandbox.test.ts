// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_BASH_ISOLATION_ERROR,
  WorkspaceBashIsolationError,
  buildBubblewrapInvocation,
  ensureWorkspaceBashIsolation
} from "../../services/tools/bashSandbox.js";

const workspace = "/srv/sunabot/workspace/business/agents/plana";
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: workspace,
  PWD: workspace,
  TMPDIR: `${workspace}/.tmp/`,
  TMP: `${workspace}/.tmp`,
  TEMP: `${workspace}/.tmp`,
  LANG: "C.UTF-8",
  LC_ALL: "",
  SHELL: "/bin/bash",
  USER: "sunabot"
};

describe("workspace Bash bubblewrap isolation", () => {
  it.each([
    ["path", "printf x > /tmp/outside"],
    ["symlink", "ln -s /tmp escape && printf x > escape/outside"],
    ["mount", "mount --bind . /tmp/escape"],
    ["subprocess", "python3 -c 'open(\"/tmp/outside\", \"w\").write(\"x\")'"]
  ])("keeps the %s bypass inside the same read-only-root sandbox", (_kind, command) => {
    const invocation = buildBubblewrapInvocation(command, workspace, environment);

    expect(invocation.file).toBe("/usr/bin/bwrap");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--bind", workspace, workspace,
      "--cap-drop", "ALL",
      "--unshare-pid"
    ]));
    expect(invocation.args.slice(-6)).toEqual([
      "--", "/bin/bash", "--noprofile", "--norc", "-lc", command
    ]);
  });

  it("fails closed when bubblewrap is missing", async () => {
    const probe = vi.fn();
    await expect(ensureWorkspaceBashIsolation(workspace, environment, {
      platform: "linux",
      access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      probe
    })).rejects.toMatchObject({
      name: "WorkspaceBashIsolationError",
      code: WORKSPACE_BASH_ISOLATION_ERROR
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when the kernel namespace probe is rejected", async () => {
    await expect(ensureWorkspaceBashIsolation(workspace, environment, {
      platform: "linux",
      access: async () => undefined,
      probe: async () => { throw new Error("user namespaces disabled"); }
    })).rejects.toBeInstanceOf(WorkspaceBashIsolationError);
  });
});
