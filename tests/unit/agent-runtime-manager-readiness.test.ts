// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { AgentRegistry, AgentSummary } from "../../services/agents/agentRegistry.js";
import {
  AgentRuntimeManager,
  type AgentRuntimeReadiness
} from "../../services/agents/agentRuntimeManager.js";
import { BroadcastStormDetector } from "../../services/orchestration/broadcastStormDetector.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("AgentRuntimeManager extension readiness", () => {
  it("keeps required failures unroutable while optional failures remain locally degraded", async () => {
    const plana = runtime("plana");
    const optional = runtime("optional");
    const required = runtime("required");
    const gateway = {} as MessagingPort;
    const states = new Map<string, AgentRuntimeReadiness>([
      ["plana", unavailable("default-required")],
      ["required", unavailable("required-server")],
      ["optional", degraded("optional-server")]
    ]);
    const registry = registryFor(["plana", "required", "optional"]);
    const createRuntime = vi.fn((config) => config.persona.defaultAgentId === "required" ? required : optional);
    const manager = new AgentRuntimeManager(registry, {
      defaultRuntime: plana,
      createRuntime,
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async (agentId) => states.get(agentId)!)
    });

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(plana.initialize).not.toHaveBeenCalled();
    expect(required.initialize).not.toHaveBeenCalled();
    expect(optional.initialize).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(() => manager.require("plana")).toThrow("Agent runtime is not available: plana");
    expect(() => manager.require("required")).toThrow("Agent runtime is not available: required");
    expect(manager.require("optional")).toBe(optional);

    const decorated = manager.decorateAgents(await registry.list(), { connected: false, accounts: [] });
    expect(decorated.map((agent) => [agent.id, agent.runtime])).toEqual([
      ["plana", expect.objectContaining({
        loaded: false,
        readiness: expect.objectContaining({ status: "not_ready", code: "AGENT_REQUIRED_MCP_UNAVAILABLE" })
      })],
      ["required", expect.objectContaining({
        loaded: false,
        readiness: expect.objectContaining({ status: "not_ready", requiredMcpServers: ["required-server"] })
      })],
      ["optional", expect.objectContaining({
        loaded: true,
        readiness: expect.objectContaining({ status: "degraded", degradedMcpServers: ["optional-server"] })
      })]
    ]);
    await manager.resumeUserGroupOrchestrators(gateway);
    expect(optional.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();
    expect(optional.resumeUserGroupOrchestrators).toHaveBeenCalledWith(gateway);
    expect(plana.resumeUserGroupOrchestrators).not.toHaveBeenCalled();
    expect(required.resumeUserGroupOrchestrators).not.toHaveBeenCalled();

    states.set("plana", ready());
    states.set("required", ready());
    await manager.start("plana");
    await manager.start("required");
    expect(plana.initialize).toHaveBeenCalledOnce();
    expect(required.initialize).toHaveBeenCalledOnce();
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenCalledWith(gateway);
    expect(required.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();
    expect(required.resumeUserGroupOrchestrators).toHaveBeenCalledWith(gateway);
    expect(manager.require("plana")).toBe(plana);
    expect(manager.require("required")).toBe(required);
  });

  it("unloads a custom runtime when a required server later fails and retries after recovery", async () => {
    const plana = runtime("plana");
    const customFirst = runtime("custom");
    const customSecond = runtime("custom");
    let customState = ready();
    const registry = registryFor(["plana", "custom"]);
    const createRuntime = vi.fn()
      .mockReturnValueOnce(customFirst)
      .mockReturnValueOnce(customSecond);
    const manager = new AgentRuntimeManager(registry, {
      defaultRuntime: plana,
      createRuntime,
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async (agentId) => agentId === "custom" ? customState : ready())
    });
    await manager.initialize();
    expect(manager.require("custom")).toBe(customFirst);

    customState = unavailable("required-server");
    await manager.refreshReadiness("custom");
    expect(customFirst.close).toHaveBeenCalledOnce();
    expect(() => manager.require("custom")).toThrow("Agent runtime is not available: custom");

    customState = ready();
    await manager.refreshReadiness("custom");
    expect(customSecond.initialize).toHaveBeenCalledOnce();
    expect(customSecond.resumeUserGroupOrchestrators).not.toHaveBeenCalled();
    expect(manager.require("custom")).toBe(customSecond);
  });

  it("rebuilds and resumes a recovered custom runtime while the global gateway remains active", async () => {
    const plana = runtime("plana");
    const customFirst = runtime("custom");
    const customSecond = runtime("custom");
    const gateway = {} as MessagingPort;
    let customState = ready();
    const manager = new AgentRuntimeManager(registryFor(["plana", "custom"]), {
      defaultRuntime: plana,
      createRuntime: vi.fn()
        .mockReturnValueOnce(customFirst)
        .mockReturnValueOnce(customSecond),
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async (agentId) => agentId === "custom" ? customState : ready())
    });
    await manager.initialize();
    await manager.resumeUserGroupOrchestrators(gateway);
    expect(customFirst.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();
    expect(customFirst.resumeUserGroupOrchestrators).toHaveBeenCalledWith(gateway);

    customState = unavailable("required-server");
    await manager.refreshReadiness("custom");
    expect(customFirst.close).toHaveBeenCalledOnce();
    expect(() => manager.require("custom")).toThrow("Agent runtime is not available: custom");

    customState = ready();
    await manager.refreshReadiness("custom");
    expect(customSecond.initialize).toHaveBeenCalledOnce();
    expect(customSecond.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();
    expect(customSecond.resumeUserGroupOrchestrators).toHaveBeenCalledWith(gateway);
    expect(manager.require("custom")).toBe(customSecond);
  });

  it("resumes default MCP recovery only while the global gateway remains active", async () => {
    const plana = runtime("plana");
    const gateway = {} as MessagingPort;
    let planaState = ready();
    const manager = new AgentRuntimeManager(registryFor(["plana"]), {
      defaultRuntime: plana,
      createRuntime: vi.fn(),
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async () => planaState)
    });
    await manager.initialize();
    await manager.resumeUserGroupOrchestrators(gateway);
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenCalledOnce();

    planaState = unavailable("required-server");
    await manager.refreshReadiness("plana");
    expect(() => manager.require("plana")).toThrow("Agent runtime is not available: plana");

    planaState = ready();
    await manager.refreshReadiness("plana");
    expect(manager.require("plana")).toBe(plana);
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenCalledTimes(2);
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenLastCalledWith(gateway);

    manager.suspendUserGroupOrchestrators();
    planaState = unavailable("required-server");
    await manager.refreshReadiness("plana");
    planaState = ready();
    await manager.refreshReadiness("plana");
    expect(manager.require("plana")).toBe(plana);
    expect(plana.resumeUserGroupOrchestrators).toHaveBeenCalledTimes(2);
  });

  it("lets a later suspension win while global resume is still refreshing readiness", async () => {
    const plana = runtime("plana");
    const gate = deferred<void>();
    const entered = deferred<void>();
    let probeCount = 0;
    const manager = new AgentRuntimeManager(registryFor(["plana"]), {
      defaultRuntime: plana,
      createRuntime: vi.fn(),
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async () => {
        probeCount += 1;
        if (probeCount === 2) {
          entered.resolve();
          await gate.promise;
        }
        return ready();
      })
    });
    await manager.initialize();

    const resuming = manager.resumeUserGroupOrchestrators({} as MessagingPort);
    await entered.promise;
    manager.suspendUserGroupOrchestrators();
    gate.resolve();

    await expect(resuming).resolves.toBeUndefined();
    expect(plana.resumeUserGroupOrchestrators).not.toHaveBeenCalled();
    expect(plana.suspendUserGroupOrchestrators).toHaveBeenCalledOnce();
  });

  it("serializes concurrent readiness refreshes so a runtime is created and initialized once", async () => {
    const plana = runtime("plana");
    const custom = runtime("custom");
    const gate = deferred<void>();
    const entered = deferred<void>();
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    const probe = vi.fn(async () => {
      activeProbes += 1;
      maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
      entered.resolve();
      if (probe.mock.calls.length === 1) await gate.promise;
      activeProbes -= 1;
      return ready();
    });
    const createRuntime = vi.fn(() => custom);
    const manager = new AgentRuntimeManager(registryFor(["plana", "custom"]), {
      defaultRuntime: plana,
      createRuntime,
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: probe
    });

    const first = manager.refreshReadiness("custom");
    const second = manager.refreshReadiness("custom");
    await entered.promise;
    expect(probe).toHaveBeenCalledOnce();
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([custom, custom]);
    expect(maximumActiveProbes).toBe(1);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(custom.initialize).toHaveBeenCalledOnce();
  });

  it("does not resurrect or leak a runtime when close races a failing readiness refresh", async () => {
    const plana = runtime("plana");
    const custom = runtime("custom");
    const state = { current: ready() };
    const gate = deferred<void>();
    let probeCount = 0;
    const manager = new AgentRuntimeManager(registryFor(["plana", "custom"]), {
      defaultRuntime: plana,
      createRuntime: vi.fn(() => custom),
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: vi.fn(async () => {
        probeCount += 1;
        if (probeCount === 2) await gate.promise;
        return state.current;
      })
    });
    await manager.start("custom");
    state.current = unavailable("required-server");

    const refresh = manager.refreshReadiness("custom");
    await Promise.resolve();
    const closing = manager.close();
    gate.resolve();

    await expect(Promise.all([refresh, closing])).resolves.toEqual([undefined, undefined]);
    expect(custom.close).toHaveBeenCalledOnce();
    expect(manager.get("custom")).toBeUndefined();
    await expect(manager.refreshReadiness("custom")).resolves.toBeUndefined();
  });

  it("keeps different Agent readiness lanes independent", async () => {
    const plana = runtime("plana");
    const agentA = runtime("agent-a");
    const agentB = runtime("agent-b");
    const gateA = deferred<void>();
    const probe = vi.fn(async (agentId: string) => {
      if (agentId === "agent-a") await gateA.promise;
      return ready();
    });
    const manager = new AgentRuntimeManager(registryFor(["plana", "agent-a", "agent-b"]), {
      defaultRuntime: plana,
      createRuntime: vi.fn((config) => config.persona.defaultAgentId === "agent-a" ? agentA : agentB),
      initializeRuntime: true,
      broadcastStormDetector: detector(),
      probeExtensionReadiness: probe
    });

    const pendingA = manager.refreshReadiness("agent-a");
    await expect(manager.refreshReadiness("agent-b")).resolves.toBe(agentB);
    expect(agentB.initialize).toHaveBeenCalledOnce();
    expect(agentA.initialize).not.toHaveBeenCalled();
    gateA.resolve();
    await expect(pendingA).resolves.toBe(agentA);
  });
});

function runtime(agentId: string) {
  const config = createAdminTestConfig(`/tmp/sunabot-agent-readiness-${agentId}`);
  config.persona.defaultAgentId = agentId;
  return {
    config,
    initialize: vi.fn(async () => undefined),
    close: vi.fn(),
    getPersonaStatus: vi.fn(() => ({ loaded: true })),
    resumeUserGroupOrchestrators: vi.fn(),
    suspendUserGroupOrchestrators: vi.fn()
  } as unknown as SunaRuntime & Record<string, ReturnType<typeof vi.fn>>;
}

function registryFor(ids: string[]) {
  const summaries = ids.map(agent);
  const configs = new Map(ids.map((id) => [id, runtime(id).config]));
  return {
    list: vi.fn(async () => summaries),
    config: vi.fn(async (agentId: string) => configs.get(agentId)!)
  } as unknown as AgentRegistry & { list: () => Promise<AgentSummary[]> };
}

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    enabled: true,
    workspace: `/tmp/${id}`,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    accounts: []
  } as AgentSummary;
}

function ready(): AgentRuntimeReadiness {
  return { status: "ready", code: null, requiredMcpServers: [], degradedMcpServers: [] };
}

function unavailable(serverId: string): AgentRuntimeReadiness {
  return {
    status: "not_ready",
    code: "AGENT_REQUIRED_MCP_UNAVAILABLE",
    requiredMcpServers: [serverId],
    degradedMcpServers: []
  };
}

function degraded(serverId: string): AgentRuntimeReadiness {
  return {
    status: "degraded",
    code: "AGENT_OPTIONAL_MCP_DEGRADED",
    requiredMcpServers: [],
    degradedMcpServers: [serverId]
  };
}

function detector() {
  return new BroadcastStormDetector({
    enabled: false,
    windowMinutes: 2,
    replyThreshold: 2,
    cooldownMinutes: 1,
    additionalQqIds: []
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
