// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AgentAccount, AgentRegistry } from "../../services/agents/agentRegistry.js";
import {
  AccountIdentityCoordinator,
  type AccountIdentityLoginControl
} from "../../services/agents/accountIdentityCoordinator.js";

describe("AccountIdentityCoordinator", () => {
  it("logs out a connected previous account before transferring the QQ identity", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: true, events });

    await expect(fixture.coordinator.assign("target", "123456789")).resolves.toMatchObject({
      account: { id: "target", qqId: "123456789" },
      previousAccount: { id: "source", qqId: "123456789" },
      transferred: true
    });

    expect(events).toEqual([
      "status:target",
      "manual:source",
      "exit:source",
      "transfer:source->target"
    ]);
    expect(fixture.control.status).not.toHaveBeenCalled();
    expect(fixture.control.cancelManualLogin).not.toHaveBeenCalled();
  });

  it("transfers a previous account only after its offline state is confirmed", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: false, events });
    fixture.control.status.mockImplementation(async () => {
      events.push("status:source");
      return { isLogin: false, manualLogin: false };
    });

    await expect(fixture.coordinator.assign("target", "123456789")).resolves.toMatchObject({
      transferred: true
    });

    expect(events).toEqual([
      "status:target",
      "status:source",
      "manual:source",
      "transfer:source->target"
    ]);
    expect(fixture.gateway.exit).not.toHaveBeenCalled();
  });

  it("keeps the existing owner when the previous account state cannot be confirmed", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: false, events });
    fixture.control.status.mockImplementation(async () => {
      events.push("status:source");
      return {
        isLogin: false,
        manualLogin: false,
        error: "NapCat WebUI unavailable"
      };
    });

    await expect(fixture.coordinator.assign("target", "123456789")).rejects.toMatchObject({
      statusCode: 409,
      code: "QQ_ACCOUNT_TRANSFER_UNAVAILABLE"
    });

    expect(events).toEqual(["status:target", "status:source"]);
    expect(fixture.registry.updateAccountIdentity).not.toHaveBeenCalled();
  });

  it("restores the previous quick-login state when its exit action fails", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: true, events });
    fixture.gateway.exit.mockImplementation(async (accountId) => {
      events.push(`exit:${accountId}`);
      throw new Error("transport unavailable");
    });

    await expect(fixture.coordinator.assign("target", "123456789")).rejects.toMatchObject({
      statusCode: 502,
      code: "QQ_ACCOUNT_TRANSFER_FAILED"
    });

    expect(events).toEqual([
      "status:target",
      "manual:source",
      "exit:source",
      "cancel:source"
    ]);
    expect(fixture.registry.updateAccountIdentity).not.toHaveBeenCalled();
  });

  it("keeps the previous connection registered when the identity transaction fails", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: true, events });
    fixture.registry.updateAccountIdentity.mockImplementation(async () => {
      events.push("transfer:source->target");
      throw new Error("injected transaction failure");
    });

    await expect(fixture.coordinator.assign("target", "123456789")).rejects.toMatchObject({
      statusCode: 502,
      code: "QQ_ACCOUNT_TRANSFER_FAILED"
    });

    expect(events).toEqual([
      "status:target",
      "manual:source",
      "exit:source",
      "transfer:source->target",
      "cancel:source"
    ]);
  });

  it("keeps an already assigned account idempotent", async () => {
    const target = account("target", "agent-target", "123456789");
    const registry = {
      account: vi.fn(() => target),
      list: vi.fn(async () => [{ id: target.agentId, accounts: [target] }]),
      updateAccountIdentity: vi.fn(async () => target),
    } as unknown as AgentRegistry;
    const coordinator = new AccountIdentityCoordinator({
      registry,
      controlFor: vi.fn(),
      gateway: {
        isConnected: vi.fn(() => true),
        exit: vi.fn(),
      }
    });

    await expect(coordinator.assign("target", "123456789")).resolves.toEqual({
      account: target,
      transferred: false
    });
    expect(registry.updateAccountIdentity).toHaveBeenCalledOnce();
  });

  it("serializes concurrent refreshes into one transfer", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: true, events });

    await expect(Promise.all([
      fixture.coordinator.assign("target", "123456789"),
      fixture.coordinator.assign("target", "123456789")
    ])).resolves.toMatchObject([
      { transferred: true },
      { transferred: false }
    ]);

    expect(fixture.gateway.exit).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === "transfer:source->target")).toHaveLength(1);
  });

  it("does not let the released account reclaim the QQ from a stale login observation", async () => {
    const events: string[] = [];
    const fixture = coordinatorFixture({ connected: true, events });
    await fixture.coordinator.assign("target", "123456789");
    events.length = 0;

    await expect(fixture.coordinator.assign("source", "123456789")).rejects.toMatchObject({
      statusCode: 409,
      code: "QQ_ACCOUNT_TRANSFER_UNAVAILABLE"
    });

    expect(events).toEqual(["status:source"]);
    expect(fixture.gateway.exit).toHaveBeenCalledTimes(1);
    expect(fixture.registry.updateAccountIdentity).toHaveBeenCalledTimes(1);
  });
});

function coordinatorFixture(input: { connected: boolean; events: string[] }) {
  let source = account("source", "agent-source", "123456789");
  let target = account("target", "agent-target");
  const control = {
    status: vi.fn(async () => {
      input.events.push("status:source");
      return { isLogin: false, manualLogin: false };
    }),
    beginManualLogin: vi.fn(async () => {
      input.events.push("manual:source");
    }),
    cancelManualLogin: vi.fn(async () => {
      input.events.push("cancel:source");
    })
  } satisfies AccountIdentityLoginControl;
  const targetControl = {
    status: vi.fn(async () => {
      input.events.push("status:target");
      return { isLogin: true, manualLogin: false };
    }),
    beginManualLogin: vi.fn(),
    cancelManualLogin: vi.fn()
  } satisfies AccountIdentityLoginControl;
  const registry = {
    account: vi.fn((accountId: string) => accountId === source.id ? source : accountId === target.id ? target : undefined),
    list: vi.fn(async () => [
      { id: source.agentId, accounts: [source] },
      { id: target.agentId, accounts: [target] }
    ]),
    updateAccountIdentity: vi.fn(async (accountId: string, qqId: string, _label?: string, transfer?: boolean) => {
      if (!transfer) return target;
      input.events.push(`transfer:${source.id}->${accountId}`);
      source = { ...source, qqId: undefined };
      target = { ...target, qqId };
      return target;
    })
  } as unknown as AgentRegistry;
  const gateway = {
    isConnected: vi.fn(() => input.connected),
    exit: vi.fn(async (accountId: string) => {
      input.events.push(`exit:${accountId}`);
    }),
  };
  return {
    registry,
    control,
    targetControl,
    gateway,
    coordinator: new AccountIdentityCoordinator({
      registry,
      controlFor: vi.fn((candidate) => candidate.id === source.id ? control : targetControl),
      gateway
    })
  };
}

function account(id: string, agentId: string, qqId?: string): AgentAccount {
  return {
    id,
    agentId,
    label: id,
    qqId,
    enabled: true,
    webuiPort: id === "source" ? 6099 : 6100,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}
