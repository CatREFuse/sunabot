// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_PROTOCOL_VERSION,
  StrictMcpClientAdapter,
  createStrictMcpClient,
  sanitizeMcpServerInstructions,
  type McpSdkClientPort
} from "../../adapters/mcp/clientAdapter.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  SdkMcpRuntimeClientFactory,
  type HardenedStdioLaunchHandlers,
  type HardenedStdioLaunchSpec,
  type HardenedStdioProcess,
  type HardenedStdioProcessLauncher,
  type McpPinnedFetch
} from "../../adapters/mcp/public.js";
import { ClearableMcpHttpAuthorization } from "../../adapters/mcp/controlledHttp.js";

class ServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  readonly sent: JSONRPCMessage[] = [];
  constructor(private readonly serverVersion = MCP_PROTOCOL_VERSION, private readonly capabilities: Record<string, unknown> = {}) {}

  async start() {}
  async close() { this.onclose?.(); }
  async send(message: JSONRPCMessage) {
    this.sent.push(structuredClone(message));
    if ("method" in message && message.method === "initialize" && "id" in message) {
      queueMicrotask(() => this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: this.serverVersion,
          capabilities: this.capabilities,
          serverInfo: { name: "fake", version: "1" }
        }
      }));
    }
  }
}

function fakeClient(overrides: Partial<McpSdkClientPort> = {}): McpSdkClientPort {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listResourceTemplates: vi.fn().mockResolvedValue({ resourceTemplates: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    subscribeResource: vi.fn().mockResolvedValue({}),
    unsubscribeResource: vi.fn().mockResolvedValue({}),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("strict MCP client adapter", () => {
  it("pins initialize to 2025-06-18, enforces strict capabilities, and exposes only the workbench root", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, { roots: {} });
    const { client, connect } = createStrictMcpClient({ name: "sunabot", version: "1" });
    await connect(transport, { timeout: 100, maxTotalTimeout: 100 });

    const initialize = transport.sent.find((message) => "method" in message && message.method === "initialize");
    expect(initialize).toMatchObject({
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { roots: {} }
      }
    });
    expect(JSON.stringify(initialize)).not.toContain("sampling");
    expect(JSON.stringify(initialize)).not.toContain("elicitation");
    expect(JSON.stringify(initialize)).not.toContain("tasks");
    expect(JSON.stringify(initialize)).not.toContain("listChanged");

    transport.onmessage?.({ jsonrpc: "2.0", id: 99, method: "roots/list" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { roots: [{ uri: "file:///workbench", name: "workbench" }] }
    });
    await client.close();
  });

  it("rejects server protocol versions outside the single-version allowlist", async () => {
    const transport = new ServerTransport("2025-11-25");
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    await expect(strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 }))
      .rejects.toThrow("MCP_PROTOCOL_VERSION_UNSUPPORTED");
  });

  it.each(["experimental", "tasks", "sampling", "elicitation"])(
    "preserves forbidden server capability %s for the host negotiation gate",
    async (capability) => {
      const launcher = new LoopbackMcpLauncher("ok", "External instructions", { [capability]: {} });
      const factory = new SdkMcpRuntimeClientFactory({
        stdioLauncher: launcher,
        secrets: {
          resolveEnvironment: vi.fn().mockResolvedValue({}),
          resolveHttpCredential: vi.fn()
        }
      });
      const client = await factory.create({
        agentId: "agent-a",
        server: {
          id: "server-a", name: "Server", description: "Test", enabled: true,
          transport: "stdio", command: "/usr/bin/server", args: [], envKeys: []
        },
        signal: new AbortController().signal
      });

      expect(client.capabilities).toMatchObject({ [capability]: {} });
      await client.close();
    }
  );

  it("uses SDK strict capability enforcement instead of calling undeclared primitives", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, {});
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    const adapter = await strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 });

    await expect(adapter.listTools()).rejects.toThrow("Server does not support tools");
    expect(transport.sent.some((message) => "method" in message && message.method === "tools/list")).toBe(false);
  });

  it("requires negotiated resource subscriptions for subscribe and unsubscribe", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, { resources: {} });
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    const adapter = await strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 });

    await expect(adapter.subscribeResource({ uri: "file:///workbench/a.txt" }))
      .rejects.toThrow("MCP_RESOURCE_SUBSCRIPTIONS_UNAVAILABLE");
    await expect(adapter.unsubscribeResource({ uri: "file:///workbench/a.txt" }))
      .rejects.toThrow("MCP_RESOURCE_SUBSCRIPTIONS_UNAVAILABLE");
    expect(transport.sent.some((message) => "method" in message && message.method === "resources/subscribe")).toBe(false);
  });

  it("passes explicit bounded request options and rejects stale late responses after close", async () => {
    let resolveTools!: (value: { tools: [] }) => void;
    const listTools = vi.fn().mockReturnValue(new Promise((resolve) => { resolveTools = resolve; }));
    const client = fakeClient({ listTools });
    const adapter = new StrictMcpClientAdapter(client, { requestTimeoutMs: 50, maxTotalTimeoutMs: 75 });
    const controller = new AbortController();
    const pending = adapter.listTools(undefined, controller.signal);

    expect(listTools).toHaveBeenCalledWith(undefined, expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeout: 50,
      maxTotalTimeout: 75,
      resetTimeoutOnProgress: false
    }));
    await adapter.close();
    resolveTools({ tools: [] });
    await expect(pending).rejects.toThrow("MCP_REQUEST_STALE");
  });

  it("loads every catalog page atomically and preserves the old snapshot on a later-page failure", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "next" })
      .mockResolvedValueOnce({ tools: [{ name: "second", inputSchema: { type: "object" } }] })
      .mockResolvedValueOnce({ tools: [{ name: "replacement", inputSchema: { type: "object" } }], nextCursor: "broken" })
      .mockRejectedValueOnce(new Error("page failed"));
    const adapter = new StrictMcpClientAdapter(fakeClient({ listTools }), {
      requestTimeoutMs: 50,
      maxTotalTimeoutMs: 75,
      catalogLimits: { maxPages: 4, maxItems: 8, maxBytes: 8_192 }
    });
    adapter.setNegotiatedCapabilities({ tools: {} });

    const initial = await adapter.refreshCatalog();
    expect(initial.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    await expect(adapter.refreshCatalog()).rejects.toThrow("page failed");
    expect(adapter.catalogSnapshot()?.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
  });

  it("retains and enforces output schemas from every tool page", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({
        tools: [{
          name: "first",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false
          }
        }],
        nextCursor: "next"
      })
      .mockResolvedValueOnce({
        tools: [{ name: "second", inputSchema: { type: "object" } }]
      });
    const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: {} });
    const adapter = new StrictMcpClientAdapter(fakeClient({ listTools, callTool }));
    adapter.setNegotiatedCapabilities({ tools: {} });
    await adapter.refreshCatalog();

    await expect(adapter.callTool({ name: "first", arguments: {} })).rejects.toThrow("MCP_TOOL_OUTPUT_INVALID");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("publishes runtime tool validators only after every negotiated catalog primitive completes", async () => {
    const launcher = new CatalogGenerationMcpLauncher();
    const factory = new SdkMcpRuntimeClientFactory({
      stdioLauncher: launcher,
      secrets: {
        resolveEnvironment: vi.fn().mockResolvedValue({}),
        resolveHttpCredential: vi.fn()
      }
    });
    const client = await factory.create({
      agentId: "agent-a",
      server: {
        id: "server-a", name: "Server", description: "Test", enabled: true,
        transport: "stdio", command: "/usr/bin/server", args: [], envKeys: []
      },
      signal: new AbortController().signal
    });
    const requestOptions = { timeout: 100, maxTotalTimeout: 100, resetTimeoutOnProgress: false as const };

    const tools = await client.listTools(undefined, requestOptions);
    const resources = await client.listResources(undefined, requestOptions);
    const resourceTemplates = await client.listResourceTemplates(undefined, requestOptions);
    const prompts = await client.listPrompts(undefined, requestOptions);
    await expect(client.callTool("shape", {}, requestOptions)).rejects.toThrow("MCP_TOOL_CATALOG_REQUIRED");
    client.commitCatalog?.({
      snapshot: runtimeCatalogSnapshot({ tools, resources, resourceTemplates, prompts }),
      generation: 1
    });
    await expect(client.callTool("shape", {}, requestOptions)).resolves.toMatchObject({
      structuredContent: { oldValue: "kept" }
    });
    expect(() => client.commitCatalog?.({
      snapshot: runtimeCatalogSnapshot({ tools, resources, resourceTemplates, prompts }),
      generation: 1
    })).toThrow("MCP_CATALOG_GENERATION_STALE");
    expect(() => client.commitCatalog?.({
      snapshot: runtimeCatalogSnapshot({ tools, resources, resourceTemplates, prompts }),
      generation: 3
    })).toThrow("MCP_CATALOG_GENERATION_STALE");

    launcher.catalogGeneration = 2;
    await client.listTools(undefined, requestOptions);
    await expect(client.listResources(undefined, requestOptions)).rejects.toThrow();
    await expect(client.callTool("shape", {}, requestOptions)).resolves.toMatchObject({
      structuredContent: { oldValue: "kept" }
    });
    await client.close();
  });

  it("fails closed on pagination loops and only permits prompts after explicit user selection", async () => {
    const listResources = vi.fn().mockResolvedValue({ resources: [], nextCursor: "same" });
    const getPrompt = vi.fn().mockResolvedValue({ messages: [] });
    const adapter = new StrictMcpClientAdapter(fakeClient({ listResources, getPrompt }));
    adapter.setNegotiatedCapabilities({ resources: {} });

    await expect(adapter.refreshResources()).rejects.toThrow("MCP_CATALOG_CURSOR_LOOP");
    await expect(adapter.getPrompt({ name: "deploy" }, { explicitUserSelection: false })).rejects.toThrow("MCP_PROMPT_EXPLICIT_SELECTION_REQUIRED");
    await expect(adapter.getPrompt({ name: "deploy" }, { explicitUserSelection: true })).resolves.toEqual({ messages: [] });
  });

  it("never maps file resources outside the virtual workbench", async () => {
    const readResource = vi.fn().mockResolvedValue({ contents: [] });
    const adapter = new StrictMcpClientAdapter(fakeClient({ readResource }));
    await expect(adapter.readResource({ uri: "file:///etc/passwd" })).rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
    await expect(adapter.readResource({ uri: "file:///workbench/%2fetc/passwd" })).rejects.toThrow("MCP_RESOURCE_URI_FORBIDDEN");
    expect(readResource).not.toHaveBeenCalled();
    await expect(adapter.readResource({ uri: "file:///workbench/readme.md" })).resolves.toEqual({ contents: [] });
    await expect(adapter.readResource({ uri: "https://mcp.example.test/resource/1" })).resolves.toEqual({ contents: [] });
  });

  it("marks server instructions as bounded external input", () => {
    expect(sanitizeMcpServerInstructions(`  ${"文".repeat(513)}  `)).toEqual({
      text: "文".repeat(512),
      trust: "external",
      truncated: true
    });
    expect(sanitizeMcpServerInstructions("   ")).toBeUndefined();
  });

  it.each([
    ["tools-only", { tools: {} }, { tools: 1, resources: 0, templates: 0, prompts: 0 }],
    ["resources-only", { resources: {} }, { tools: 0, resources: 1, templates: 1, prompts: 0 }],
    ["prompts-only", { prompts: {} }, { tools: 0, resources: 0, templates: 0, prompts: 1 }],
    ["none", {}, { tools: 0, resources: 0, templates: 0, prompts: 0 }]
  ] as const)("refreshes only the negotiated %s catalog primitives", async (_name, capabilities, expected) => {
    const client = fakeClient();
    const adapter = new StrictMcpClientAdapter(client);
    adapter.setNegotiatedCapabilities(capabilities);

    const snapshot = await adapter.refreshCatalog();
    expect(snapshot).toMatchObject({
      tools: expect.any(Array), resources: expect.any(Array), resourceTemplates: expect.any(Array), prompts: expect.any(Array)
    });
    expect(client.listTools).toHaveBeenCalledTimes(expected.tools);
    expect(client.listResources).toHaveBeenCalledTimes(expected.resources);
    expect(client.listResourceTemplates).toHaveBeenCalledTimes(expected.templates);
    expect(client.listPrompts).toHaveBeenCalledTimes(expected.prompts);

    adapter.notifyListChanged("tools");
    adapter.notifyListChanged("resources");
    adapter.notifyListChanged("prompts");
    await adapter.refreshCatalog();
    expect(client.listTools).toHaveBeenCalledTimes(expected.tools * 2);
    expect(client.listResources).toHaveBeenCalledTimes(expected.resources * 2);
    expect(client.listResourceTemplates).toHaveBeenCalledTimes(expected.templates * 2);
    expect(client.listPrompts).toHaveBeenCalledTimes(expected.prompts * 2);
  });

  it("marks the atomic snapshot stale on negotiated listChanged notifications", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, { tools: { listChanged: true } });
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    const adapter = await strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 });
    expect(adapter.catalogStale()).toBe(false);

    transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.catalogStale()).toBe(true);
    await expect(adapter.callTool({ name: "anything", arguments: {} })).rejects.toThrow("MCP_TOOL_CATALOG_REQUIRED");
  });

  it("ignores listChanged notifications that were not negotiated", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, { tools: {} });
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    const adapter = await strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 });
    transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await Promise.resolve();
    expect(adapter.catalogStale()).toBe(false);
  });

  it("forwards only negotiated and bounded resource update notifications", async () => {
    const transport = new ServerTransport(MCP_PROTOCOL_VERSION, { resources: { subscribe: true } });
    const strict = createStrictMcpClient({ name: "sunabot", version: "1" });
    const adapter = await strict.connect(transport, { timeout: 100, maxTotalTimeout: 100 });
    const updated = vi.fn();
    adapter.onResourceUpdated(updated);
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "file:///workbench/readme.md" }
    });
    await Promise.resolve();
    expect(updated).toHaveBeenCalledWith("file:///workbench/readme.md");
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "file:///etc/passwd" }
    });
    await Promise.resolve();
    expect(updated).toHaveBeenCalledOnce();
  });

  it("builds a real per-server stdio client using only resolver-provided environment", async () => {
    const launcher = new LoopbackMcpLauncher();
    const secrets = {
      resolveEnvironment: vi.fn().mockResolvedValue({ MCP_TOKEN: "server-a-secret" }),
      resolveHttpCredential: vi.fn()
    };
    const factory = new SdkMcpRuntimeClientFactory({ secrets, stdioLauncher: launcher });
    const client = await factory.create({
      agentId: "agent-a",
      server: {
        id: "server-a",
        name: "Server A",
        description: "Test",
        enabled: true,
        transport: "stdio",
        command: "/usr/local/bin/server-a",
        args: ["--stdio"],
        envKeys: ["MCP_TOKEN"]
      },
      signal: new AbortController().signal
    });

    expect(secrets.resolveEnvironment).toHaveBeenCalledWith({
      agentId: "agent-a",
      serverId: "server-a",
      keys: ["MCP_TOKEN"]
    });
    expect(launcher.snapshot).toMatchObject({
      cwd: "/workbench",
      env: { MCP_TOKEN: "server-a-secret" },
      inheritEnv: false,
      killScope: "process_group"
    });
    expect(launcher.snapshot?.env).not.toHaveProperty("HOME");
    expect(launcher.spec?.env).toEqual({});
    expect(launcher.spec?.args).toEqual([]);
    expect(JSON.stringify(launcher.spec)).not.toContain("server-a-secret");

    const requestOptions = { timeout: 100, maxTotalTimeout: 100, resetTimeoutOnProgress: false as const };
    const tools = await client.listTools(undefined, requestOptions);
    expect(tools).toMatchObject({
      items: [expect.objectContaining({ name: "echo" })]
    });
    client.commitCatalog?.({ snapshot: runtimeCatalogSnapshot({ tools }), generation: 1 });
    await expect(client.callTool("echo", { text: "hello" }, requestOptions)).resolves.toMatchObject({
      structuredContent: { value: "ok" }
    });
    await expect(client.subscribeResource("file:///workbench/a.txt", requestOptions)).resolves.toEqual({});
    await expect(client.unsubscribeResource("file:///workbench/a.txt", requestOptions)).resolves.toEqual({});
    await client.close();
    expect(launcher.process.lifecycle[0]).toBe("stdin");
  });

  it("redacts injected secrets and host paths from instructions and tool output", async () => {
    const secret = "server+secret/7f3c";
    const secretBytes = Buffer.from(secret, "utf8");
    const secretVariants = [
      secret,
      `Bearer ${secret}`,
      encodeURIComponent(secret),
      secretBytes.toString("base64"),
      secretBytes.toString("base64url"),
      secretBytes.toString("hex")
    ];
    const launcher = new LoopbackMcpLauncher(
      `${secretVariants.join(" ")} /Users/private C:\\private \\\\server\\share`,
      `Use ${secretVariants.join(" ")} from /Users/private or C:\\private`
    );
    const factory = new SdkMcpRuntimeClientFactory({
      stdioLauncher: launcher,
      secrets: {
        resolveEnvironment: vi.fn().mockResolvedValue({ MCP_TOKEN: secret }),
        resolveHttpCredential: vi.fn()
      }
    });
    const client = await factory.create({
      agentId: "agent-a",
      server: {
        id: "server-a", name: "Server", description: "Test", enabled: true,
        transport: "stdio", command: "/usr/bin/server", args: [], envKeys: ["MCP_TOKEN"]
      },
      signal: new AbortController().signal
    });
    expect(client.instructions).toContain("[REDACTED]");
    expect(client.instructions).toContain("[HOST_PATH]");
    for (const variant of secretVariants) expect(client.instructions).not.toContain(variant);
    const requestOptions = { timeout: 100, maxTotalTimeout: 100, resetTimeoutOnProgress: false as const };
    const tools = await client.listTools(undefined, requestOptions);
    client.commitCatalog?.({ snapshot: runtimeCatalogSnapshot({ tools }), generation: 1 });
    const result = await client.callTool("echo", { text: "hello" }, requestOptions);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[HOST_PATH]");
    for (const variant of secretVariants) expect(serialized).not.toContain(variant);
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("C:\\private");
    await client.close();
  });

  it("fails closed when a server secret resolver injects undeclared environment", async () => {
    const launcher = new LoopbackMcpLauncher();
    const factory = new SdkMcpRuntimeClientFactory({
      stdioLauncher: launcher,
      secrets: {
        resolveEnvironment: vi.fn().mockResolvedValue({ MCP_TOKEN: "ok", OTHER_TOKEN: "leak" }),
        resolveHttpCredential: vi.fn()
      }
    });
    await expect(factory.create({
      agentId: "agent-a",
      server: {
        id: "server-a", name: "Server", description: "Test", enabled: true,
        transport: "stdio", command: "/usr/bin/server", args: [], envKeys: ["MCP_TOKEN"]
      },
      signal: new AbortController().signal
    })).rejects.toThrow("MCP_STDIO_ENV_UNAVAILABLE");
    expect(launcher.spec).toBeUndefined();
  });

  it("retains and retries a pre-host client owner when create cleanup fails", async () => {
    const events: string[] = [];
    let allowDelete = false;
    let initializeCount = 0;
    const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method === "DELETE") {
        events.push("old-cleanup");
        if (!allowDelete) throw new Error("cleanup failed");
        return new Response(null, { status: 405 });
      }
      const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
      if (request.method === "initialize") {
        initializeCount += 1;
        events.push(`initialize-${initializeCount}`);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "cleanup", version: "1" },
            instructions: "External instructions"
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(initializeCount === 1 ? { "mcp-session-id": "s".repeat(16 * 1024 + 1) } : {})
          }
        });
      }
      return new Response(null, { status: 202 });
    });
    const factory = new SdkMcpRuntimeClientFactory({
      secrets: {
        resolveEnvironment: vi.fn(),
        resolveHttpCredential: vi.fn()
      },
      http: {
        resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
        fetchPinned
      }
    });
    const input = {
      agentId: "agent-a",
      server: {
        id: "server-a", name: "Server", description: "Test", enabled: true,
        transport: "streamable_http" as const,
        url: "https://mcp.example.test/mcp",
        auth: { kind: "none" as const }
      },
      signal: new AbortController().signal
    };

    await expect(factory.create(input)).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    expect(initializeCount).toBe(1);
    await expect(factory.create(input)).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    expect(initializeCount).toBe(1);
    allowDelete = true;

    const recovered = await factory.create(input);
    expect(initializeCount).toBe(2);
    expect(events.indexOf("old-cleanup")).toBeLessThan(events.indexOf("initialize-2"));
    await recovered.close();
  });

  it("retains a pre-host owner after the factory cleanup deadline expires", async () => {
    vi.useFakeTimers();
    const clearSecrets = vi.spyOn(ClearableMcpHttpAuthorization.prototype, "clear");
    try {
      let initializeCount = 0;
      let deleteCount = 0;
      let deleteStarted!: () => void;
      let releaseDelete!: (response: Response) => void;
      const firstDelete = new Promise<void>((resolve) => { deleteStarted = resolve; });
      const pendingDelete = new Promise<Response>((resolve) => { releaseDelete = resolve; });
      const events: string[] = [];
      const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
        if (init.method === "DELETE") {
          deleteCount += 1;
          events.push("cleanup");
          deleteStarted();
          if (deleteCount === 1) return pendingDelete;
          return new Response(null, { status: 405 });
        }
        const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
        if (request.method === "initialize") {
          initializeCount += 1;
          events.push(`initialize-${initializeCount}`);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: "cleanup-timeout", version: "1" },
              instructions: "External instructions"
            }
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...(initializeCount === 1 ? { "mcp-session-id": "s".repeat(16 * 1024 + 1) } : {})
            }
          });
        }
        return new Response(null, { status: 202 });
      });
      const factory = runtimeHttpFactory(fetchPinned, "cleanup-secret");
      const baseInput = runtimeHttpInput("agent-a", "server-a");
      const input = {
        ...baseInput,
        server: {
          ...baseInput.server,
          auth: { kind: "bearer" as const, credentialRef: "credential-a" }
        }
      };

      const creating = factory.create(input);
      await firstDelete;
      const rejected = expect(creating).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(initializeCount).toBe(1);
      expect(clearSecrets).toHaveBeenCalledOnce();

      const recovering = factory.create(input);
      await Promise.resolve();
      expect(deleteCount).toBe(1);
      releaseDelete(new Response(null, { status: 405 }));
      const recovered = await recovering;
      expect(initializeCount).toBe(2);
      expect(events.indexOf("cleanup")).toBeLessThan(events.indexOf("initialize-2"));
      await recovered.close();
    } finally {
      clearSecrets.mockRestore();
      vi.useRealTimers();
    }
  });

  it("isolates retained pre-host owners by both Agent and server", async () => {
    let allowDelete = false;
    let initializeCount = 0;
    const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method === "DELETE") {
        if (!allowDelete) throw new Error("cleanup failed");
        return new Response(null, { status: 405 });
      }
      const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
      if (request.method === "initialize") {
        initializeCount += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "scope", version: "1" },
            instructions: "External instructions"
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(initializeCount === 1 ? { "mcp-session-id": "s".repeat(16 * 1024 + 1) } : {})
          }
        });
      }
      return new Response(null, { status: 202 });
    });
    const factory = runtimeHttpFactory(fetchPinned);
    const orphaned = runtimeHttpInput("agent-a", "server-a");

    await expect(factory.create(orphaned)).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    const otherServer = await factory.create(runtimeHttpInput("agent-a", "server-b"));
    const otherAgent = await factory.create(runtimeHttpInput("agent-b", "server-a"));
    await factory.cleanupOrphans({ agentId: "agent-b" });
    await expect(factory.create(orphaned)).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    expect(initializeCount).toBe(3);

    allowDelete = true;
    const recovered = await factory.create(orphaned);
    expect(initializeCount).toBe(4);
    await Promise.all([otherServer.close(), otherAgent.close(), recovered.close()]);
  });

  it("retains the owner when secret clearing itself fails", async () => {
    let initializeCount = 0;
    const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method === "DELETE") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
      if (request.method === "initialize") {
        initializeCount += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "secret-cleanup", version: "1" },
            instructions: "External instructions"
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(initializeCount === 1 ? { "mcp-session-id": "s".repeat(16 * 1024 + 1) } : {})
          }
        });
      }
      return new Response(null, { status: 202 });
    });
    const clearSecrets = vi.spyOn(ClearableMcpHttpAuthorization.prototype, "clear")
      .mockImplementation(() => { throw new Error("clear failed"); });
    const factory = runtimeHttpFactory(fetchPinned, "cleanup-secret");
    const baseInput = runtimeHttpInput("agent-a", "server-a");
    const input = {
      ...baseInput,
      server: {
        ...baseInput.server,
        auth: { kind: "bearer" as const, credentialRef: "credential-a" }
      }
    };

    await expect(factory.create(input)).rejects.toThrow("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    expect(clearSecrets).toHaveBeenCalledTimes(3);
    expect(initializeCount).toBe(1);
    clearSecrets.mockRestore();

    const recovered = await factory.create(input);
    expect(initializeCount).toBe(2);
    await recovered.close();
  });

  it("keeps HTTP credentials inside the controlled transport and terminates the session", async () => {
    const resolve = vi.fn().mockResolvedValue(["93.184.216.34"]);
    const observedAuthorizations: Array<string | null> = [];
    const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
      observedAuthorizations.push(new Headers(init.headers).get("authorization"));
      const method = init.method ?? "GET";
      if (method === "GET" || method === "DELETE") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
      if (request.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "http", version: "1" }
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-a" }
        });
      }
      return new Response(null, { status: 202 });
    });
    const credential = { accessToken: "http-super-secret" };
    const secrets = {
      resolveEnvironment: vi.fn(),
      resolveHttpCredential: vi.fn().mockResolvedValue(credential)
    };
    const factory = new SdkMcpRuntimeClientFactory({
      secrets,
      http: { resolve, fetchPinned }
    });
    const client = await factory.create({
      agentId: "agent-a",
      server: {
        id: "remote", name: "Remote", description: "Test", enabled: true,
        transport: "streamable_http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "oauth", credentialRef: "credential-handle" }
      },
      signal: new AbortController().signal
    });

    expect(secrets.resolveHttpCredential).toHaveBeenCalledWith({
      agentId: "agent-a",
      serverId: "remote",
      credentialRef: "credential-handle",
      resource: "https://mcp.example.test/mcp",
      authKind: "oauth"
    });
    const initializeCall = fetchPinned.mock.calls.find((call) => call[1]?.method === "POST" && String(call[1]?.body).includes("initialize"));
    expect(observedAuthorizations).toContain("Bearer http-super-secret");
    expect(credential.accessToken).toBe("");
    expect(new Headers(initializeCall?.[1]?.headers).has("authorization")).toBe(false);
    expect(String(initializeCall?.[0])).not.toContain("http-super-secret");
    expect(String(initializeCall?.[1]?.body)).not.toContain("http-super-secret");
    await client.close();
    expect(fetchPinned.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(true);
    expect(fetchPinned.mock.calls.every((call) => !new Headers(call[1]?.headers).has("authorization"))).toBe(true);
  });

  it("shares a pending runtime session cleanup and still clears transport secrets", async () => {
    vi.useFakeTimers();
    const clearSecrets = vi.spyOn(ClearableMcpHttpAuthorization.prototype, "clear");
    try {
      let deleteCount = 0;
      let deleteStarted!: () => void;
      let releaseDelete!: (response: Response) => void;
      const firstDelete = new Promise<void>((resolve) => { deleteStarted = resolve; });
      const pendingDelete = new Promise<Response>((resolve) => { releaseDelete = resolve; });
      const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
        if (init.method === "DELETE") {
          deleteCount += 1;
          deleteStarted();
          return pendingDelete;
        }
        const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
        if (request.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: "runtime-cleanup", version: "1" }
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-a" }
          });
        }
        return new Response(null, { status: 202 });
      });
      const factory = runtimeHttpFactory(fetchPinned, "cleanup-secret");
      const baseInput = runtimeHttpInput("agent-a", "server-a");
      const client = await factory.create({
        ...baseInput,
        server: {
          ...baseInput.server,
          auth: { kind: "bearer" as const, credentialRef: "credential-a" }
        }
      });

      const firstClose = client.close();
      await firstDelete;
      const rejected = expect(firstClose).rejects.toThrow("MCP_CLIENT_CLEANUP_FAILED");
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(clearSecrets).toHaveBeenCalledOnce();

      const recovering = client.close();
      await Promise.resolve();
      expect(deleteCount).toBe(1);
      releaseDelete(new Response(null, { status: 405 }));
      await recovering;
      expect(deleteCount).toBe(1);
    } finally {
      clearSecrets.mockRestore();
      vi.useRealTimers();
    }
  });

  it("treats the negotiated HTTP session id as a non-persistent secret", async () => {
    const sessionId = "mcp-session-secret-7f3c9";
    const bytes = Buffer.from(sessionId, "utf8");
    const variants = [
      sessionId,
      bytes.toString("base64"),
      bytes.toString("base64").replace(/=+$/u, ""),
      [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")
    ];
    const fetchPinned = vi.fn(async (_url: URL, init: RequestInit) => {
      if ((init.method ?? "GET") === "DELETE") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body)) as { id?: string | number; method?: string };
      if (request.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "http", version: "1" }
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": sessionId
          }
        });
      }
      if (request.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [{
              name: "echo",
              inputSchema: { type: "object", properties: {}, additionalProperties: false }
            }]
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: variants.join(" ") }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const factory = new SdkMcpRuntimeClientFactory({
      secrets: {
        resolveEnvironment: vi.fn(),
        resolveHttpCredential: vi.fn()
      },
      http: {
        resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
        fetchPinned
      }
    });
    const client = await factory.create({
      agentId: "agent-a",
      server: {
        id: "remote", name: "Remote", description: "Test", enabled: true,
        transport: "streamable_http", url: "https://mcp.example.test/mcp", auth: { kind: "none" }
      },
      signal: new AbortController().signal
    });
    const requestOptions = {
      timeout: 100,
      maxTotalTimeout: 100,
      resetTimeoutOnProgress: false as const
    };
    const tools = await client.listTools(undefined, requestOptions);
    client.commitCatalog?.({ snapshot: runtimeCatalogSnapshot({ tools }), generation: 1 });
    const result = await client.callTool("echo", {}, requestOptions);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[REDACTED]");
    for (const variant of variants) expect(serialized).not.toContain(variant);
    await client.close();
  });
});

class LoopbackMcpProcess implements HardenedStdioProcess {
  readonly lifecycle: string[] = [];
  constructor(
    private readonly handlers: HardenedStdioLaunchHandlers,
    private readonly toolValue = "ok",
    private readonly instructions = "External instructions",
    private readonly capabilities: Record<string, unknown> = {
      tools: {}, resources: { subscribe: true }, prompts: {}
    }
  ) {}

  async writeStdin(value: string) {
    const request = JSON.parse(value) as { id?: string | number; method?: string; params?: Record<string, unknown> };
    if (request.id === undefined) return;
    let result: Record<string, unknown>;
    if (request.method === "initialize") {
      result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: this.capabilities,
        serverInfo: { name: "loopback", version: "1" },
        instructions: this.instructions
      };
    } else if (request.method === "tools/list") {
      result = {
        tools: [{
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false
          }
        }]
      };
    } else if (request.method === "tools/call") {
      result = { content: [], structuredContent: { value: this.toolValue } };
    } else if (request.method === "resources/subscribe" || request.method === "resources/unsubscribe") {
      result = {};
    } else {
      result = {};
    }
    queueMicrotask(() => this.handlers.stdout(Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id, result
    })}\n`)));
  }

  async closeStdin() { this.lifecycle.push("stdin"); }
  async waitForExit(timeoutMs: number) { this.lifecycle.push(`wait:${timeoutMs}`); return true; }
  async terminateGroup(signal: "SIGTERM" | "SIGKILL") { this.lifecycle.push(signal); }
}

class LoopbackMcpLauncher implements HardenedStdioProcessLauncher {
  spec?: HardenedStdioLaunchSpec;
  snapshot?: HardenedStdioLaunchSpec;
  process!: LoopbackMcpProcess;
  constructor(
    private readonly toolValue = "ok",
    private readonly instructions = "External instructions",
    private readonly capabilities: Record<string, unknown> = {
      tools: {}, resources: { subscribe: true }, prompts: {}
    }
  ) {}
  async launch(spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers) {
    this.spec = spec;
    this.snapshot = { ...spec, args: [...spec.args], env: { ...spec.env } };
    this.process = new LoopbackMcpProcess(handlers, this.toolValue, this.instructions, this.capabilities);
    return this.process;
  }
}

class CatalogGenerationMcpProcess implements HardenedStdioProcess {
  private exited = false;

  constructor(
    private readonly handlers: HardenedStdioLaunchHandlers,
    private readonly generation: () => number
  ) {}

  async writeStdin(value: string) {
    const request = JSON.parse(value) as { id?: string | number; method?: string };
    if (request.id === undefined) return;
    if (request.method === "resources/list" && this.generation() === 2) {
      this.respond({ jsonrpc: "2.0", id: request.id, error: { code: -32_003, message: "page failed" } });
      return;
    }
    let result: Record<string, unknown>;
    if (request.method === "initialize") {
      result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "catalog-generation", version: "1" },
        instructions: "External instructions"
      };
    } else if (request.method === "tools/list") {
      const field = this.generation() === 1 ? "oldValue" : "newValue";
      result = {
        tools: [{
          name: "shape",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: {
            type: "object",
            properties: { [field]: { type: "string" } },
            required: [field],
            additionalProperties: false
          }
        }]
      };
    } else if (request.method === "resources/list") {
      result = { resources: [{ uri: "file:///workbench/item.txt", name: "item" }] };
    } else if (request.method === "resources/templates/list") {
      result = { resourceTemplates: [{ uriTemplate: "https://mcp.example.test/items/{path}", name: "items" }] };
    } else if (request.method === "prompts/list") {
      result = { prompts: [{ name: "review" }] };
    } else if (request.method === "tools/call") {
      result = { content: [], structuredContent: { oldValue: "kept" } };
    } else result = {};
    this.respond({ jsonrpc: "2.0", id: request.id, result });
  }

  async closeStdin() { this.exited = true; }
  async waitForExit() { return this.exited; }
  async terminateGroup() { this.exited = true; }

  private respond(message: JSONRPCMessage) {
    queueMicrotask(() => this.handlers.stdout(Buffer.from(`${JSON.stringify(message)}\n`)));
  }
}

class CatalogGenerationMcpLauncher implements HardenedStdioProcessLauncher {
  catalogGeneration = 1;

  async launch(_spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers) {
    return new CatalogGenerationMcpProcess(handlers, () => this.catalogGeneration);
  }
}

function runtimeCatalogSnapshot(input: {
  tools?: { items: Record<string, unknown>[] };
  resources?: { items: Record<string, unknown>[] };
  resourceTemplates?: { items: Record<string, unknown>[] };
  prompts?: { items: Record<string, unknown>[] };
}) {
  return {
    digestSha256: "a".repeat(64),
    tools: input.tools?.items ?? [],
    resources: input.resources?.items ?? [],
    resourceTemplates: input.resourceTemplates?.items ?? [],
    prompts: input.prompts?.items ?? [],
    refreshedAt: new Date(0).toISOString()
  };
}

function runtimeHttpFactory(fetchPinned: McpPinnedFetch, accessToken?: string) {
  return new SdkMcpRuntimeClientFactory({
    secrets: {
      resolveEnvironment: vi.fn(),
      resolveHttpCredential: vi.fn(async () => ({ accessToken: accessToken ?? "unused" }))
    },
    http: {
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned
    }
  });
}

function runtimeHttpInput(agentId: string, serverId: string) {
  return {
    agentId,
    server: {
      id: serverId,
      name: serverId,
      description: "Test",
      enabled: true,
      transport: "streamable_http" as const,
      url: `https://mcp.example.test/${serverId}`,
      auth: { kind: "none" as const }
    },
    signal: new AbortController().signal
  };
}
