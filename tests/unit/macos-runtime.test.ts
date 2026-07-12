// @vitest-environment node
import { describe, expect, it } from "vitest";
import { macosLauncherArguments } from "../../tooling/runtime/macos.mjs";

describe("macOS runtime compatibility entry", () => {
  it("delegates lifecycle commands to the unified native launcher", () => {
    expect(macosLauncherArguments("start")).toEqual(["up", "--core=native"]);
    expect(macosLauncherArguments("stop")).toEqual(["down", "--core=native"]);
    expect(macosLauncherArguments("doctor")).toEqual(["doctor", "--core=native"]);
  });

  it("rejects the removed Mac Installer commands", () => {
    expect(() => macosLauncherArguments("configure-napcat")).toThrow("旧 macOS NapCat Installer 入口已移除");
  });
});
