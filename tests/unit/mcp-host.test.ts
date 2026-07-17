// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  AgentMcpHost,
  isMcpToolAlias,
  type McpRuntimeClientPort
} from "../../services/extensions/mcpHost.js";
import { MCP_PROVIDER_TOOL_MAX_DEFINITIONS } from "../../services/extensions/mcpToolCatalog.js";

describe("Agent MCP host", () => {
  it("isolates clients by Agent/server, exposes only allowlisted tools and requires approval", async () => {
    const clients: McpRuntimeClientPort[] = [];
    const factory = { create: vi.fn(async () => {
      const client = clientMock();
      clients.push(client);
      return client;
    }) };
    const host = new AgentMcpHost(factory);
    await host.reconcileAgent("agent-a", [server("server-a")]);
    await host.reconcileAgent("agent-b", [server("server-a")]);
    expect(factory.create).toHaveBeenCalledTimes(2);
    const definition = host.toolDefinitions("agent-a")[0] as { name: string };
    expect(definition.name).toHaveLength(52);
    expect(isMcpToolAlias(definition.name)).toBe(true);
    await expect(host.callTool({
      agentId: "agent-a", alias: definition.name, arguments: {}, approved: false
    })).rejects.toThrow("MCP_TOOL_APPROVAL_REQUIRED");
    await expect(host.callTool({
      agentId: "agent-a", alias: definition.name, arguments: { query: "test" }, approved: true
    })).resolves.toEqual({ ok: true });
    expect(clients[0]!.callTool).toHaveBeenCalledWith("search", { query: "test" }, expect.objectContaining({
      timeout: 60_000, maxTotalTimeout: 60_000, resetTimeoutOnProgress: false
    }));
    await host.closeAgent("agent-a");
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    expect(clients[1]!.close).not.toHaveBeenCalled();
  });

  it("rejects cyclic, deep, wide and oversized tool arguments before any server call", async () => {
    const client = clientMock();
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    const alias = (host.toolDefinitions("agent-a")[0] as { name: string }).name;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 25; index += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "hidden" });
    const hostileProxy = new Proxy({}, { ownKeys: () => { throw new Error("host path"); } });
    const rejected = [
      cycle,
      deepRoot,
      { values: Array.from({ length: 4_097 }, () => 0) },
      { text: "x".repeat(64 * 1024 + 1) },
      accessor,
      hostileProxy
    ];
    for (const argumentsValue of rejected) {
      await expect(host.callTool({
        agentId: "agent-a", alias, arguments: argumentsValue, approved: true
      })).rejects.toThrow("MCP_TOOL_ARGUMENTS_INVALID");
    }
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("rejects unsupported versions/experimental capabilities and keeps required failure local", async () => {
    const bad = clientMock();
    bad.protocolVersion = "2025-11-25";
    bad.capabilities = { tools: true, tasks: {} };
    const host = new AgentMcpHost({ create: vi.fn(async () => bad) });
    await expect(host.reconcileAgent("agent-a", [server("required", true)])).resolves.toEqual({
      ready: false, requiredFailures: ["required"]
    });
    await expect(host.reconcileAgent("agent-b", [])).resolves.toEqual({ ready: true, requiredFailures: [] });
    expect(host.toolDefinitions("agent-a")).toEqual([]);
  });

  it("fails readiness for a required disabled server without starting it", async () => {
    const create = vi.fn(async () => clientMock());
    const host = new AgentMcpHost({ create });
    await expect(host.reconcileAgent("agent-a", [{ ...server("required", true), enabled: false }]))
      .resolves.toEqual({ ready: false, requiredFailures: ["required"] });
    expect(create).not.toHaveBeenCalled();
    expect(host.status("agent-a")).toEqual([{
      serverId: "required",
      status: "unavailable",
      toolCatalogStatus: "unavailable",
      errorCode: "MCP_REQUIRED_SERVER_DISABLED"
    }]);
  });

  it("keeps prompts user-explicit and roots fixed to the virtual workbench", async () => {
    const client = clientMock();
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    expect(client.setRootsHandler).toHaveBeenCalledWith(expect.any(Function));
    const roots = client.setRootsHandler.mock.calls[0]![0]();
    expect(roots).toEqual({ roots: [{ uri: "file:///workbench", name: "Agent workbench" }] });
    await expect(host.getPrompt({
      agentId: "agent-a", serverId: "server-a", name: "review", arguments: {}, userExplicit: false
    })).rejects.toThrow("MCP_PROMPT_EXPLICIT_SELECTION_REQUIRED");
    await expect(host.readResource({
      agentId: "agent-a", serverId: "server-a", uri: "file:///etc/passwd"
    })).rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
  });

  it.each([
    "FILE:///workbench/readme.md",
    "FiLe:///workbench/readme.md",
    "file:///workbench/../skills/secret",
    "file:///workbench/%2e%2e/skills/secret",
    "file:///workbench/%252e%252e/skills/secret",
    "file:///workbench/%2fetc/passwd",
    "file:///workbench/%5c..%5csecret",
    "file:///workbench//secret",
    "file://localhost/workbench/secret",
    "file:///workbench/secret?query=1",
    "file:///workbench/secret#fragment",
    "file:///workbench/%77orkbench"
  ])("rejects non-canonical virtual file URI before every server operation: %s", async (uri) => {
    const client = clientMock();
    client.capabilities = { resources: true, resourceSubscriptions: true };
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    await expect(host.readResource({ agentId: "agent-a", serverId: "server-a", uri }))
      .rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
    await expect(host.subscribeResource({ agentId: "agent-a", serverId: "server-a", uri }))
      .rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
    await expect(host.unsubscribeResource({ agentId: "agent-a", serverId: "server-a", uri }))
      .rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
    expect(client.readResource).not.toHaveBeenCalled();
    expect(client.subscribeResource).not.toHaveBeenCalled();
    expect(client.unsubscribeResource).not.toHaveBeenCalled();
  });

  it("treats an explicit empty enabledTools allowlist as deny-all", async () => {
    const client = clientMock();
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [{ ...server("server-a"), enabledTools: [] }]);
    expect(host.toolDefinitions("agent-a")).toEqual([]);
  });

  it("single-flights concurrent starts and aborts the in-flight client without restart on close", async () => {
    const client = clientMock();
    const gate = deferred<McpRuntimeClientPort>();
    let startSignal: AbortSignal | undefined;
    const factory = { create: vi.fn(async (input: { signal: AbortSignal }) => {
      startSignal = input.signal;
      return gate.promise;
    }) };
    const host = new AgentMcpHost(factory);
    const first = host.reconcileAgent("agent-a", [server("server-a")]);
    const second = host.reconcileAgent("agent-a", [server("server-a")]);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledOnce());
    const closing = host.closeAgent("agent-a");
    expect(startSignal?.aborted).toBe(true);
    gate.resolve(client);
    await Promise.all([first, second, closing]);
    expect(factory.create).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(host.toolDefinitions("agent-a")).toEqual([]);
  });

  it("includes a late factory client close failure in the Agent lifecycle and retries its orphan", async () => {
    const client = clientMock();
    client.close.mockRejectedValueOnce(new Error("late close failed")).mockResolvedValue(undefined);
    const gate = deferred<McpRuntimeClientPort>();
    const factory = { create: vi.fn(async () => gate.promise) };
    const host = new AgentMcpHost(factory, undefined, { reconcileTimeoutMs: 50 });
    const reconciling = host.reconcileAgent("agent-a", [server("server-a")]);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledOnce());

    const closing = host.closeAgent("agent-a");
    let closingSettled = false;
    void closing.then(() => { closingSettled = true; }, () => { closingSettled = true; });
    await flushAsync();
    expect(closingSettled).toBe(false);

    gate.resolve(client);
    await expect(closing).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
    await expect(reconciling).resolves.toEqual({ ready: true, requiredFailures: [] });
    expect(client.close).toHaveBeenCalledTimes(2);
    await expect(host.closeAgent("agent-a")).resolves.toBeUndefined();
  });

  it("bounds a late factory client whose close never settles and preserves it for retry", async () => {
    const client = clientMock();
    client.close.mockImplementationOnce(() => new Promise<void>(() => undefined)).mockResolvedValue(undefined);
    const gate = deferred<McpRuntimeClientPort>();
    const factory = { create: vi.fn(async () => gate.promise) };
    const host = new AgentMcpHost(factory, undefined, { reconcileTimeoutMs: 10 });
    const reconciling = host.reconcileAgent("agent-a", [server("server-a")]);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledOnce());

    const closing = host.closeAgent("agent-a");
    gate.resolve(client);
    await expect(closing).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
    await expect(reconciling).resolves.toEqual({ ready: true, requiredFailures: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(host.closeAgent("agent-a")).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
    await expect(host.closeAgent("agent-a")).resolves.toBeUndefined();
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("drains a late creation after its start entry expired when the server is disabled", async () => {
    const client = clientMock();
    client.close.mockRejectedValueOnce(new Error("late close failed")).mockResolvedValue(undefined);
    const gate = deferred<McpRuntimeClientPort>();
    const factory = { create: vi.fn(async () => gate.promise) };
    const host = new AgentMcpHost(factory, undefined, { reconcileTimeoutMs: 10 });

    await expect(host.reconcileAgent("agent-a", [server("server-a")]))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
    const disabling = host.reconcileAgent("agent-a", []);
    let disablingSettled = false;
    void disabling.then(() => { disablingSettled = true; }, () => { disablingSettled = true; });
    await flushAsync();
    expect(disablingSettled).toBe(false);

    gate.resolve(client);
    await expect(disabling).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
    expect(client.close).toHaveBeenCalledTimes(2);
    await expect(host.reconcileAgent("agent-a", []))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
  });

  it("bounds Agent reconciliation while keeping healthy servers and other Agents independent", async () => {
    const requiredGate = deferred<McpRuntimeClientPort>();
    const optionalGate = deferred<McpRuntimeClientPort>();
    const healthyA = clientMock();
    const healthyB = clientMock();
    let active = 0;
    let maxActive = 0;
    const factory = { create: vi.fn(async ({ agentId, server: value }: {
      agentId: string;
      server: { id: string };
    }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (value.id === "b-required") return await requiredGate.promise;
        if (value.id === "c-optional") return await optionalGate.promise;
        return agentId === "agent-a" ? healthyA : healthyB;
      } finally {
        active -= 1;
      }
    }) };
    const host = new AgentMcpHost(factory, undefined, {
      maxConcurrentStarts: 2,
      reconcileTimeoutMs: 20
    });

    const agentA = host.reconcileAgent("agent-a", [
      server("a-healthy"),
      server("b-required", true),
      server("c-optional")
    ]);
    await Promise.resolve();
    await expect(host.reconcileAgent("agent-b", [server("a-healthy")]))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
    await expect(agentA).resolves.toEqual({ ready: false, requiredFailures: ["b-required"] });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(host.toolDefinitions("agent-a")).not.toEqual([]);
    expect(host.toolDefinitions("agent-b")).not.toEqual([]);

    const lateRequired = clientMock();
    const lateOptional = clientMock();
    requiredGate.resolve(lateRequired);
    optionalGate.resolve(lateOptional);
    await vi.waitFor(() => {
      expect(lateRequired.close).toHaveBeenCalledOnce();
      expect(lateOptional.close).toHaveBeenCalledOnce();
    });
  });

  it("removes definitions on close failure and retries retained orphan cleanup", async () => {
    const client = clientMock();
    client.close.mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    expect(host.toolDefinitions("agent-a")).not.toEqual([]);

    await expect(host.closeAgent("agent-a")).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
    expect(host.toolDefinitions("agent-a")).toEqual([]);
    await expect(host.closeAgent("agent-a")).resolves.toBeUndefined();
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("does not publish a replacement when closing the previous client fails", async () => {
    const previous = clientMock();
    const replacement = clientMock();
    previous.close.mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    const factory = { create: vi.fn()
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(clientMock()) };
    const host = new AgentMcpHost(factory);
    await host.reconcileAgent("agent-a", [server("server-a")]);

    await expect(host.reconcileAgent("agent-a", [{ ...server("server-a"), args: ["--changed"] }]))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
    expect(host.toolDefinitions("agent-a")).toEqual([]);
    expect(replacement.close).toHaveBeenCalledOnce();

    await host.reconcileAgent("agent-a", [{ ...server("server-a"), args: ["--changed"] }]);
    expect(previous.close).toHaveBeenCalledTimes(2);
    expect(host.toolDefinitions("agent-a")).not.toEqual([]);
  });

  it("drops late listChanged and resource notifications after replacement or close", async () => {
    const previous = clientMock();
    const replacement = clientMock();
    let previousListChanged = () => undefined;
    let previousResourceUpdated = (_uri: string) => undefined;
    previous.setListChangedHandler.mockImplementation((handler: () => void) => { previousListChanged = handler; });
    previous.setResourceUpdatedHandler.mockImplementation((handler: (uri: string) => void) => {
      previousResourceUpdated = handler;
    });
    const factory = { create: vi.fn()
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(replacement) };
    const host = new AgentMcpHost(factory);
    await host.reconcileAgent("agent-a", [server("server-a")]);
    const previousCalls = previous.listTools.mock.calls.length;
    await host.reconcileAgent("agent-a", [{ ...server("server-a"), args: ["--changed"] }]);

    previousListChanged();
    previousResourceUpdated("file:///workbench/readme.md");
    await Promise.resolve();
    expect(previous.listTools).toHaveBeenCalledTimes(previousCalls);

    let replacementListChanged = () => undefined;
    replacement.setListChangedHandler.mockImplementation((handler: () => void) => { replacementListChanged = handler; });
    await host.closeAgent("agent-a");
    const replacementCalls = replacement.listTools.mock.calls.length;
    replacementListChanged();
    await Promise.resolve();
    expect(replacement.listTools).toHaveBeenCalledTimes(replacementCalls);
  });

  it("invalidates an unexpectedly closed client without affecting another Agent and restarts on reconcile", async () => {
    const crashed = clientMock();
    const recovered = clientMock();
    const other = clientMock();
    let crash = (_event: { unexpected: boolean }) => undefined;
    crashed.setLifecycleHandler.mockImplementation((handler: typeof crash) => { crash = handler; });
    const factory = { create: vi.fn()
      .mockImplementationOnce(async () => crashed)
      .mockImplementationOnce(async () => other)
      .mockImplementationOnce(async () => recovered) };
    const host = new AgentMcpHost(factory);
    const invalidated = vi.fn();
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [server("server-a", true)]);
    await host.reconcileAgent("agent-b", [server("server-a", true)]);

    crash({ unexpected: true });
    expect(host.toolDefinitions("agent-a")).toEqual([]);
    expect(host.toolDefinitions("agent-b")).not.toEqual([]);
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ serverId: "server-a", errorCode: "MCP_CLIENT_DISCONNECTED" })
    ]);
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledWith("agent-a"));
    await vi.waitFor(() => expect(crashed.close).toHaveBeenCalledOnce());

    await expect(host.reconcileAgent("agent-a", [server("server-a", true)]))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
    expect(host.toolDefinitions("agent-a")).not.toEqual([]);
    expect(crashed.close).toHaveBeenCalledOnce();
  });

  it("keeps failed unexpected-close cleanup unavailable until a later reconcile retries it", async () => {
    const crashed = clientMock();
    const recovered = clientMock();
    crashed.close.mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    let crash = (_event: { unexpected: boolean }) => undefined;
    crashed.setLifecycleHandler.mockImplementation((handler: typeof crash) => { crash = handler; });
    const factory = { create: vi.fn()
      .mockResolvedValueOnce(crashed)
      .mockResolvedValueOnce(recovered) };
    const invalidated = vi.fn();
    const host = new AgentMcpHost(factory);
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [server("server-a", true)]);

    crash({ unexpected: true });
    await vi.waitFor(() => expect(crashed.close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledWith("agent-a"));
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ serverId: "server-a", errorCode: "MCP_CLIENT_DISCONNECTED" })
    ]);
    expect(host.toolDefinitions("agent-a")).toEqual([]);

    await expect(host.reconcileAgent("agent-a", [server("server-a", true)]))
      .resolves.toEqual({ ready: true, requiredFailures: [] });
    expect(crashed.close).toHaveBeenCalledTimes(2);
    expect(recovered.close).not.toHaveBeenCalled();
  });

  it("cannot resurrect a stale catalog when transport closes during listChanged refresh", async () => {
    const client = clientMock();
    let listChanged = () => undefined;
    let crash = (_event: { unexpected: boolean }) => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { listChanged = handler; });
    client.setLifecycleHandler.mockImplementation((handler: typeof crash) => { crash = handler; });
    const refreshStarted = deferred<void>();
    const refreshGate = deferred<{ items: Array<{ name: string; inputSchema: { type: string } }> }>();
    client.listTools.mockImplementation(async () => {
      if (client.listTools.mock.calls.length === 1) return page("initial");
      refreshStarted.resolve();
      return refreshGate.promise;
    });
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a", true)]);
    listChanged();
    await refreshStarted.promise;
    crash({ unexpected: true });
    refreshGate.resolve(page("stale"));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.toolDefinitions("agent-a")).toEqual([]);
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ errorCode: "MCP_CLIENT_DISCONNECTED" })
    ]);
  });

  it("reports a required server degraded when a later catalog page fails", async () => {
    const client = clientMock();
    client.capabilities = { tools: true };
    client.listTools
      .mockResolvedValueOnce({ items: [{ name: "search", inputSchema: { type: "object" } }], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("later page failed"));
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await expect(host.reconcileAgent("agent-a", [server("required", true)])).resolves.toEqual({
      ready: false,
      requiredFailures: ["required"]
    });
    expect(host.toolDefinitions("agent-a")).toEqual([]);
  });

  it("publishes a catalog and its tool validators as one committed generation", async () => {
    const client = clientMock();
    const events: string[] = [];
    for (const [name, method] of [
      ["tools", client.listTools],
      ["resources", client.listResources],
      ["templates", client.listResourceTemplates],
      ["prompts", client.listPrompts]
    ] as const) {
      const implementation = method.getMockImplementation()!;
      method.mockImplementation(async (...args: unknown[]) => {
        events.push(name);
        return implementation(...args);
      });
    }
    client.commitCatalog.mockImplementation(() => { events.push("commit"); });
    let changed = () => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { changed = handler; });
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [openServer("server-a")]);

    expect(client.commitCatalog).toHaveBeenCalledOnce();
    expect(events.slice(0, 5)).toEqual(["tools", "resources", "templates", "prompts", "commit"]);
    expect(client.commitCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 1 }));
    const firstAlias = (host.toolDefinitions("agent-a")[0] as { name: string }).name;
    expect(host.describeToolAlias("agent-a", firstAlias)).toMatchObject({ catalogGeneration: 1 });

    client.listTools.mockResolvedValue(page("replacement"));
    client.listResources.mockRejectedValueOnce(new Error("later primitive failed"));
    changed();
    await vi.waitFor(() => expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ status: "degraded" })
    ]));
    expect(client.commitCatalog).toHaveBeenCalledTimes(1);

    client.commitCatalog.mockImplementationOnce(() => { throw new Error("validator compile failed"); });
    changed();
    await vi.waitFor(() => expect(client.commitCatalog).toHaveBeenCalledTimes(2));
    expect(client.commitCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }));
    expect(host.status("agent-a")).toEqual([expect.objectContaining({ status: "degraded" })]);

    changed();
    await vi.waitFor(() => expect(client.commitCatalog).toHaveBeenCalledTimes(3));
    expect(client.commitCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }));
    await vi.waitFor(() => expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ status: "ready" })
    ]));
    const replacementAlias = (host.toolDefinitions("agent-a")[0] as { name: string }).name;
    expect(replacementAlias).not.toBe(firstAlias);
    expect(host.describeToolAlias("agent-a", replacementAlias)).toMatchObject({ catalogGeneration: 2 });
  });

  it("drains factory-owned pre-host clients even when no host state exists", async () => {
    const cleanupOrphans = vi.fn(async () => undefined);
    const host = new AgentMcpHost({ create: vi.fn(async () => clientMock()), cleanupOrphans });

    await host.closeAgent("agent-a");
    expect(cleanupOrphans).toHaveBeenCalledWith({ agentId: "agent-a" });
    await host.close();
    expect(cleanupOrphans).toHaveBeenLastCalledWith(undefined);
  });

  it("bounds a never-resolving factory orphan drain", async () => {
    vi.useFakeTimers();
    try {
      const cleanupOrphans = vi.fn(() => new Promise<void>(() => undefined));
      const host = new AgentMcpHost(
        { create: vi.fn(async () => clientMock()), cleanupOrphans },
        undefined,
        { reconcileTimeoutMs: 10 }
      );
      const closing = host.closeAgent("agent-a");
      const rejected = expect(closing).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates published readiness in both directions after a catalog refresh fails and recovers", async () => {
    const clientA = clientMock();
    const clientB = clientMock();
    let changedA = () => undefined;
    clientA.setListChangedHandler.mockImplementation((handler: () => void) => { changedA = handler; });
    const factory = { create: vi.fn(async ({ agentId }: { agentId: string }) =>
      agentId === "agent-a" ? clientA : clientB) };
    const invalidated = vi.fn(async () => undefined);
    const host = new AgentMcpHost(factory);
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [server("required", true)]);
    await host.reconcileAgent("agent-b", [server("required", true)]);

    clientA.listTools.mockRejectedValueOnce(new Error("refresh failed"));
    changedA();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
    expect(invalidated).toHaveBeenLastCalledWith("agent-a");
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ serverId: "required", status: "degraded" })
    ]);
    expect(host.status("agent-b")).toEqual([
      expect.objectContaining({ serverId: "required", status: "ready" })
    ]);

    clientA.listTools.mockResolvedValue(page("search"));
    changedA();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
    expect(invalidated).toHaveBeenLastCalledWith("agent-a");
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ serverId: "required", status: "ready" })
    ]);
  });

  it("retries required readiness with bounded backoff until a silent server recovery", async () => {
    vi.useFakeTimers();
    try {
      const client = clientMock();
      let changed = () => undefined;
      client.setListChangedHandler.mockImplementation((handler: () => void) => { changed = handler; });
      client.listTools
        .mockResolvedValueOnce(page("initial"))
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("second failure"))
        .mockResolvedValue(page("recovered"));
      const descriptor = server("required", true);
      const host = new AgentMcpHost({ create: vi.fn(async () => client) }, undefined, {
        requiredRetryBaseMs: 10,
        requiredRetryMaxMs: 20
      });
      const invalidated = vi.fn(async () => {
        await host.reconcileAgent("agent-a", [descriptor]);
      });
      host.setReadinessInvalidationHandler(invalidated);
      await host.reconcileAgent("agent-a", [descriptor]);

      changed();
      await flushAsync();
      expect(client.listTools).toHaveBeenCalledTimes(3);
      expect(host.status("agent-a")).toEqual([
        expect.objectContaining({ status: "degraded" })
      ]);

      await vi.advanceTimersByTimeAsync(9);
      expect(client.listTools).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
      expect(client.listTools).toHaveBeenCalledTimes(4);
      expect(host.status("agent-a")).toEqual([
        expect.objectContaining({ status: "ready" })
      ]);

      const callsAfterRecovery = client.listTools.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.listTools).toHaveBeenCalledTimes(callsAfterRecovery);
      await host.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a delayed invalidation handler so closeAgent cannot resurrect a client", async () => {
    const crashed = clientMock();
    const recovered = clientMock();
    let crash = (_event: { unexpected: boolean }) => undefined;
    crashed.setLifecycleHandler.mockImplementation((handler: typeof crash) => { crash = handler; });
    const factory = { create: vi.fn()
      .mockResolvedValueOnce(crashed)
      .mockResolvedValueOnce(recovered) };
    const host = new AgentMcpHost(factory);
    const entered = deferred<void>();
    const release = deferred<void>();
    const descriptor = server("required", true);
    const invalidated = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      await host.reconcileAgent("agent-a", [descriptor]);
    });
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [descriptor]);

    crash({ unexpected: true });
    await entered.promise;
    await host.closeAgent("agent-a");
    release.resolve();
    await expect(invalidated.mock.results[0]!.value).rejects.toThrow("MCP_CLIENT_START_ABORTED");
    expect(factory.create).toHaveBeenCalledOnce();
    expect(host.toolDefinitions("agent-a")).toEqual([]);

    await expect(host.reconcileAgent("agent-a", [descriptor])).resolves.toEqual({
      ready: true,
      requiredFailures: []
    });
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it("coalesces a published listChanged storm into one readiness invalidation", async () => {
    const client = clientMock();
    client.capabilities = { tools: true };
    let changed = () => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { changed = handler; });
    const invalidated = vi.fn(async () => undefined);
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [server("required", true)]);

    client.listTools.mockImplementation(async () => {
      changed();
      return page("search");
    });
    changed();

    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
    expect(host.status("agent-a")).toEqual([
      expect.objectContaining({ serverId: "required", status: "degraded" })
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("invalidates readiness when a published catalog develops and clears an alias collision", async () => {
    const first = clientMock();
    const second = clientMock();
    let changed = () => undefined;
    second.setListChangedHandler.mockImplementation((handler: () => void) => { changed = handler; });
    first.listTools.mockResolvedValue(page("one"));
    second.listTools.mockResolvedValue({ items: [] });
    const invalidated = vi.fn(async () => undefined);
    const host = new AgentMcpHost({
      create: vi.fn(async ({ server: value }: { server: { id: string } }) =>
        value.id === "server-a" ? first : second)
    }, () => "a".repeat(64));
    host.setReadinessInvalidationHandler(invalidated);
    await host.reconcileAgent("agent-a", [openServer("server-a"), openServer("server-b")]);

    second.listTools.mockResolvedValue(page("two"));
    changed();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
    expect(host.status("agent-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCatalogStatus: "degraded" })
    ]));

    second.listTools.mockResolvedValue({ items: [] });
    changed();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
    expect(host.status("agent-a").every((state) => state.toolCatalogStatus === "ready")).toBe(true);
  });

  it("reruns a full refresh when listChanged arrives during refresh and degrades after a notification storm", async () => {
    const client = clientMock();
    client.capabilities = { tools: true };
    let listChanged = () => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { listChanged = handler; });
    const secondStarted = deferred<void>();
    const releaseSecond = deferred<void>();
    const thirdStarted = deferred<void>();
    client.listTools.mockImplementation(async () => {
      const call = client.listTools.mock.calls.length;
      if (call === 1) return page("initial");
      if (call === 2) {
        secondStarted.resolve();
        await releaseSecond.promise;
        return page("intermediate");
      }
      thirdStarted.resolve();
      return page("final");
    });
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    listChanged();
    await secondStarted.promise;
    listChanged();
    releaseSecond.resolve();
    await thirdStarted.promise;
    await host.reconcileAgent("agent-a", [server("server-a")]);
    expect(host.catalog("agent-a", "server-a").tools).toEqual([
      expect.objectContaining({ name: "final" })
    ]);

    const storm = clientMock();
    storm.capabilities = { tools: true };
    let stormChanged = () => undefined;
    storm.setListChangedHandler.mockImplementation((handler: () => void) => { stormChanged = handler; });
    storm.listTools.mockImplementation(async () => {
      stormChanged();
      return page("search");
    });
    const stormHost = new AgentMcpHost({ create: vi.fn(async () => storm) });
    await expect(stormHost.reconcileAgent("agent-a", [server("required", true)])).resolves.toEqual({
      ready: false,
      requiredFailures: ["required"]
    });
    expect(storm.listTools).toHaveBeenCalledTimes(3);
  });

  it("tracks negotiated subscriptions and refreshes only subscribed resource updates", async () => {
    const client = clientMock();
    client.capabilities = { resources: true, resourceSubscriptions: true };
    let updated = (_uri: string) => undefined;
    client.setResourceUpdatedHandler.mockImplementation((handler: (uri: string) => void) => { updated = handler; });
    const refreshed = deferred<void>();
    client.listResources.mockImplementation(async () => {
      if (client.listResources.mock.calls.length === 2) refreshed.resolve();
      return { items: [{ uri: "file:///workbench/readme.md" }] };
    });
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    await host.subscribeResource({
      agentId: "agent-a",
      serverId: "server-a",
      uri: "file:///workbench/readme.md"
    });
    updated("file:///workbench/other.md");
    await Promise.resolve();
    expect(client.listResources).toHaveBeenCalledOnce();
    updated("file:///workbench/readme.md");
    await refreshed.promise;
    await host.unsubscribeResource({
      agentId: "agent-a",
      serverId: "server-a",
      uri: "file:///workbench/readme.md"
    });
    const calls = client.listResources.mock.calls.length;
    updated("file:///workbench/readme.md");
    await Promise.resolve();
    expect(client.listResources).toHaveBeenCalledTimes(calls);
    await host.closeAgent("agent-a");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("maps bounded canonical and same-name tools to distinct provider-safe aliases", async () => {
    const longName = "a".repeat(128);
    const first = clientMock();
    first.listTools.mockResolvedValue({ items: [
      { name: longName, inputSchema: {
        type: "object",
        properties: { optional: { type: "string" } },
        oneOf: [{ required: ["optional"] }, {}]
      } },
      { name: "shared", inputSchema: { type: "object" } }
    ] });
    const second = clientMock();
    second.listTools.mockResolvedValue({ items: [
      { name: "shared", inputSchema: { type: "object" } }
    ] });
    const host = new AgentMcpHost({
      create: vi.fn(async ({ server }: { server: { id: string } }) => server.id === "server-a" ? first : second)
    });
    await host.reconcileAgent("agent-a", [openServer("server-a"), openServer("server-b")]);
    const definitions = host.toolDefinitions("agent-a") as Array<{ name: string; parameters: unknown }>;
    expect(definitions).toHaveLength(3);
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(3);
    expect(definitions.every((definition) => isMcpToolAlias(definition.name) && definition.name.length <= 64)).toBe(true);
    expect(definitions.every((definition) => !("x-sunabot-mcp" in definition) && !("strict" in definition))).toBe(true);
    const unicodeAlias = host.toolAlias("agent-a", "server-a", longName);
    expect(definitions.find((definition) => definition.name === unicodeAlias)?.parameters).toEqual({
      type: "object",
      properties: { optional: { type: "string" } },
      additionalProperties: true
    });
    await host.callTool({ agentId: "agent-a", alias: unicodeAlias, arguments: {}, approved: true });
    expect(first.callTool).toHaveBeenCalledWith(longName, {}, expect.any(Object));
  });

  it("invalidates an old alias when listChanged atomically replaces its snapshot", async () => {
    const client = clientMock();
    client.listTools.mockResolvedValue({ items: [
      { name: "search", description: "first", inputSchema: { type: "object" } }
    ] });
    let changed = () => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { changed = handler; });
    const host = new AgentMcpHost({ create: vi.fn(async () => client) });
    await host.reconcileAgent("agent-a", [server("server-a")]);
    const oldAlias = (host.toolDefinitions("agent-a")[0] as { name: string }).name;
    client.listTools.mockResolvedValue({ items: [
      { name: "search", description: "second", inputSchema: { type: "object" } }
    ] });
    changed();
    await host.reconcileAgent("agent-a", [server("server-a")]);
    const newAlias = (host.toolDefinitions("agent-a")[0] as { name: string }).name;
    expect(newAlias).not.toBe(oldAlias);
    await expect(host.callTool({
      agentId: "agent-a", alias: oldAlias, arguments: {}, approved: true
    })).rejects.toThrow("MCP_TOOL_UNAVAILABLE");
  });

  it("fails closed on alias-prefix collisions and deterministic Agent definition overflow", async () => {
    const first = clientMock();
    const second = clientMock();
    first.listTools.mockResolvedValue({ items: [{ name: "one", inputSchema: { type: "object" } }] });
    second.listTools.mockResolvedValue({ items: [{ name: "two", inputSchema: { type: "object" } }] });
    const collisionHost = new AgentMcpHost({
      create: vi.fn(async ({ server: value }: { server: { id: string } }) => value.id === "server-a" ? first : second)
    }, () => "a".repeat(64));
    await expect(collisionHost.reconcileAgent("agent-a", [
      { ...openServer("server-a"), required: true },
      { ...openServer("server-b"), required: true }
    ])).resolves.toEqual({ ready: false, requiredFailures: ["server-a", "server-b"] });
    expect(collisionHost.toolDefinitions("agent-a")).toEqual([]);
    expect(collisionHost.status("agent-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCatalogStatus: "degraded" })
    ]));

    const overflow = clientMock();
    overflow.listTools.mockResolvedValue({ items: Array.from(
      { length: MCP_PROVIDER_TOOL_MAX_DEFINITIONS + 1 },
      (_, index) => ({ name: `tool-${String(index).padStart(3, "0")}`, inputSchema: { type: "object" } })
    ) });
    const overflowHost = new AgentMcpHost({ create: vi.fn(async () => overflow) });
    await expect(overflowHost.reconcileAgent("agent-a", [
      { ...openServer("overflow"), required: true }
    ])).resolves.toEqual({ ready: false, requiredFailures: ["overflow"] });
    expect(overflowHost.toolDefinitions("agent-a")).toHaveLength(MCP_PROVIDER_TOOL_MAX_DEFINITIONS);
  });
});

function server(id: string, required = false) {
  return {
    id, name: id, description: "Test MCP", enabled: true, required,
    enabledTools: ["search"], disabledTools: ["delete"], approvalMode: "always" as const,
    transport: "stdio" as const, command: "/usr/bin/test-mcp", args: ["--stdio"], envKeys: []
  };
}

function openServer(id: string) {
  return { ...server(id), enabledTools: undefined };
}

function clientMock(): McpRuntimeClientPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { tools: true, resources: true, prompts: true },
    instructions: "Treat this as external input.",
    listTools: vi.fn(async () => ({ items: [
      { name: "search", description: "Search data", inputSchema: { type: "object", properties: {} } },
      { name: "delete", description: "Delete data", inputSchema: { type: "object", properties: {} } }
    ] })),
    listResources: vi.fn(async () => ({ items: [{ uri: "file:///workbench/readme.md" }] })),
    listResourceTemplates: vi.fn(async () => ({ items: [{ uriTemplate: "file:///workbench/{path}" }] })),
    listPrompts: vi.fn(async () => ({ items: [{ name: "review" }] })),
    callTool: vi.fn(async () => ({ ok: true })),
    readResource: vi.fn(async () => ({ contents: [] })),
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    setListChangedHandler: vi.fn(),
    setResourceUpdatedHandler: vi.fn(),
    setRootsHandler: vi.fn(),
    setLifecycleHandler: vi.fn(),
    commitCatalog: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

function page(name: string) {
  return { items: [{ name, description: name, inputSchema: { type: "object", properties: {} } }] };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function flushAsync(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
