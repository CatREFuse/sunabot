// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nativeNodeRuntimeMounts, nativeToolPath } from "../../packages/platform/nativeToolSandbox.mjs";

describe("Native tool Node runtime projection", () => {
  it("mounts only the running Node distribution when installed under a private home", () => {
    const executable = "/home/operator/.local/node-v24/bin/node";
    expect(nativeNodeRuntimeMounts(executable)).toEqual([
      "--ro-bind", "/home/operator/.local/node-v24", "/home/operator/.local/node-v24"
    ]);
    expect(nativeToolPath(executable)).toBe(
      "/home/operator/.local/node-v24/bin:/usr/local/bin:/usr/bin:/bin"
    );
  });

  it("uses existing system mounts and supports bundled release runtimes", () => {
    expect(nativeNodeRuntimeMounts("/usr/bin/node")).toEqual([]);
    expect(nativeNodeRuntimeMounts("/opt/sunabot/runtime/node/bin/node")).toEqual([
      "--ro-bind", "/opt/sunabot/runtime/node", "/opt/sunabot/runtime/node"
    ]);
  });

  it("projects a standalone executable without exposing its parent directory", () => {
    expect(nativeNodeRuntimeMounts("/home/operator/node")).toEqual([
      "--ro-bind", "/home/operator/node", "/usr/local/bin/node"
    ]);
  });
});
