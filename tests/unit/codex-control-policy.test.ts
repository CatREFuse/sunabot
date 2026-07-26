// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  codexControlAvailable,
  codexTurnAvailable
} from "../../services/tools/codexControlPolicy.js";

describe("Codex control policy", () => {
  it("allows only administrator private turns on macOS Native Core", () => {
    expect(codexControlAvailable({
      isAdmin: true,
      scope: "private",
      platform: "darwin",
      runtimeMode: "native"
    })).toBe(true);
    expect(codexControlAvailable({
      isAdmin: false,
      scope: "private",
      platform: "darwin",
      runtimeMode: "native"
    })).toBe(false);
    expect(codexControlAvailable({
      isAdmin: true,
      scope: "user_group",
      platform: "darwin",
      runtimeMode: "native"
    })).toBe(false);
    expect(codexControlAvailable({
      isAdmin: true,
      scope: "private",
      platform: "darwin",
      runtimeMode: "docker"
    })).toBe(false);
    expect(codexControlAvailable({
      isAdmin: true,
      scope: "private",
      platform: "linux",
      runtimeMode: "native"
    })).toBe(false);
    expect(codexControlAvailable({
      isAdmin: true,
      scope: "private",
      promptOverride: "scheduled callback",
      platform: "darwin",
      runtimeMode: "native"
    })).toBe(false);
  });

  it("keeps Native control available independently of isolated worker auth", () => {
    expect(codexTurnAvailable({
      enabled: true,
      control: true,
      workerAvailable: false
    })).toBe(true);
    expect(codexTurnAvailable({
      enabled: true,
      control: false,
      workerAvailable: true
    })).toBe(true);
    expect(codexTurnAvailable({
      enabled: true,
      control: false,
      workerAvailable: false
    })).toBe(false);
    expect(codexTurnAvailable({
      enabled: false,
      control: true,
      workerAvailable: true
    })).toBe(false);
  });
});
