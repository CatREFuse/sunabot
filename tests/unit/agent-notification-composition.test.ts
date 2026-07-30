// @vitest-environment node
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import { resolveEnabledAgentAccountId } from "../../apps/api/agentNotificationComposition.js";

describe("Agent administrator notification composition", () => {
  it("selects the first enabled account from the requested Agent", async () => {
    const get = vi.fn(async () => ({
      accounts: [
        { id: "qq_z", enabled: true },
        { id: "qq_disabled", enabled: false },
        { id: "qq_a", enabled: true }
      ]
    }));

    await expect(resolveEnabledAgentAccountId(
      "arona",
      { get } as unknown as Pick<AgentRegistry, "get">
    )).resolves.toBe("qq_a");
    expect(get).toHaveBeenCalledWith("arona");
  });

  it("prefers a connected enabled account before the deterministic enabled fallback", async () => {
    const get = vi.fn(async () => ({
      accounts: [
        { id: "qq_z", enabled: true },
        { id: "qq_disabled", enabled: false },
        { id: "qq_a", enabled: true }
      ]
    }));

    await expect(resolveEnabledAgentAccountId(
      "arona",
      { get } as unknown as Pick<AgentRegistry, "get">,
      ["qq_disabled", "qq_z"]
    )).resolves.toBe("qq_z");
    await expect(resolveEnabledAgentAccountId(
      "arona",
      { get } as unknown as Pick<AgentRegistry, "get">,
      ["qq_disabled"]
    )).resolves.toBe("qq_a");
  });

  it("returns undefined when the Agent has no enabled account", async () => {
    const get = vi.fn(async () => ({
      accounts: [{ id: "qq_disabled", enabled: false }]
    }));

    await expect(resolveEnabledAgentAccountId(
      "arona",
      { get } as unknown as Pick<AgentRegistry, "get">
    )).resolves.toBeUndefined();
  });

  it("binds the real OneBot connected-account reader before runtime initialization", async () => {
    const source = await fs.readFile(
      new URL("../../apps/api/server.ts", import.meta.url),
      "utf8"
    );
    const gatewayIndex = source.indexOf("const onebotGateway = new OneBotGateway");
    const readerIndex = source.indexOf(
      "readConnectedAccountIds = () => (onebotGateway.getStatus().accounts ?? [])"
    );
    const initializeIndex = source.indexOf("await agentRuntimeManager.initialize()");

    expect(gatewayIndex).toBeGreaterThanOrEqual(0);
    expect(readerIndex).toBeGreaterThan(gatewayIndex);
    expect(initializeIndex).toBeGreaterThan(readerIndex);
  });
});
