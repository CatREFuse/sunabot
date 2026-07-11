// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute
} from "../../src/groupReplyPolicy.js";

describe("user group reply policy", () => {
  it.each([
    [{ enabled: false, command: true, explicitRule: true, orchestratorEnabled: true }, "none"],
    [{ enabled: true, command: true, explicitRule: false, orchestratorEnabled: false }, "command"],
    [{ enabled: true, command: false, explicitRule: true, orchestratorEnabled: false }, "direct"],
    [{ enabled: true, command: false, explicitRule: true, orchestratorEnabled: true }, "direct"],
    [{ enabled: true, command: false, explicitRule: false, orchestratorEnabled: false }, "none"],
    [{ enabled: true, command: false, explicitRule: false, orchestratorEnabled: true }, "ambient"]
  ] as const)("resolves %o to %s", (input, expected) => {
    expect(resolveUserGroupReplyRoute(input)).toBe(expected);
  });

  it("limits orchestrator replies for a sliding 60-second window", () => {
    const lastReplyAt = "2026-07-10T08:00:00.000Z";
    expect(isOrchestratorReplyRateLimited(lastReplyAt, Date.parse(lastReplyAt) + 59_999)).toBe(true);
    expect(isOrchestratorReplyRateLimited(lastReplyAt, Date.parse(lastReplyAt) + 60_000)).toBe(false);
    expect(isOrchestratorReplyRateLimited(undefined, Date.parse(lastReplyAt))).toBe(false);
  });
});

describe("ReplyGateEpochs", () => {
  it("does not revive stale tasks after disable and re-enable", () => {
    const gates = new ReplyGateEpochs();
    const stale = gates.capture("user_group", "group:1");

    gates.invalidateScope("user_group");
    const fresh = gates.capture("user_group", "group:1");

    expect(gates.isCurrent(stale)).toBe(false);
    expect(gates.isCurrent(fresh)).toBe(true);
  });

  it("invalidates only the selected conversation", () => {
    const gates = new ReplyGateEpochs();
    const first = gates.capture("user_group", "group:1");
    const second = gates.capture("user_group", "group:2");

    gates.invalidateConversation("group:1");

    expect(gates.isCurrent(first)).toBe(false);
    expect(gates.isCurrent(second)).toBe(true);
  });
});
