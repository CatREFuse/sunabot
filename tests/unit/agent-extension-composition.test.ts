// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentExtensionComposition } from "../../apps/api/agentExtensionComposition.js";
import { McpSandboxProjectionBuilder } from "../../adapters/mcp/public.js";
import { mcpStdioCredentialEnvironmentKey } from "../../packages/contracts/extensions/agentExtensions.js";
import type { RuntimeAgentExtensionsPort } from "../../src/runtime/agentExtensions.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((candidate) => fs.rm(candidate, {
    recursive: true,
    force: true
  })));
});

describe("Agent extension composition", () => {
  it("reuses one projection builder across concurrent stdio server launches", async () => {
    const builders = new Set<McpSandboxProjectionBuilder>();
    vi.spyOn(McpSandboxProjectionBuilder.prototype, "build").mockImplementation(async function () {
      builders.add(this);
      throw new Error("TEST_PROJECTION_STOP");
    });
    const composition = buildAgentExtensionComposition({
      workspaceRoot: "/tmp/sunabot-agent-extension-composition-projection-test",
      agentExists: () => true,
      oauth: false,
      mcpStdio: {
        backend: "docker",
        dockerImage: "sunabot-mcp:local",
        executableManifestSha256: "a".repeat(64)
      }
    });
    const internals = composition.mcpRuntimeService as unknown as {
      host: { pool: { factory: { options: { stdioLauncherFor(input: {
        agentId: string;
        server: ReturnType<typeof stdioServer>;
        signal: AbortSignal;
      }): Promise<{ launch(spec: unknown, handlers: unknown): Promise<unknown> }> } } } };
    };
    const factory = internals.host.pool.factory;
    const abort = new AbortController();
    const serverA = stdioServer();
    const serverB = { ...serverA, id: "server-b", command: "/usr/bin/server-b" };
    const [launcherA, launcherB] = await Promise.all([
      factory.options.stdioLauncherFor({ agentId: "agent-a", server: serverA, signal: abort.signal }),
      factory.options.stdioLauncherFor({ agentId: "agent-a", server: serverB, signal: abort.signal })
    ]);

    const launches = await Promise.allSettled([
      launcherA.launch({}, {}),
      launcherB.launch({}, {})
    ]);
    expect(launches).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" })
    ]);
    expect(builders.size).toBe(1);
    await composition.close();
  });

  it("refreshes readiness even when stale runtime cleanup fails", async () => {
    const closeFailure = new Error("must not escape");
    const runtime = runtimePort({ closeAgent: vi.fn().mockRejectedValue(closeFailure) });
    const composition = buildAgentExtensionComposition({
      workspaceRoot: "/tmp/sunabot-agent-extension-composition-test",
      agentExists: () => true,
      oauth: false,
      runtime,
      mcpClientFactory: { create: vi.fn() }
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    composition.setAgentChangedHandler(refresh);

    await expect(composition.notifyAgentChanged("agent-a"))
      .rejects.toThrow("AGENT_EXTENSION_CHANGE_RECONCILE_FAILED");
    expect(runtime.closeAgent).toHaveBeenCalledWith("agent-a");
    expect(refresh).toHaveBeenCalledWith("agent-a");
  });

  it("reports a stable aggregate failure after both cleanup and refresh fail", async () => {
    const runtime = runtimePort({ closeAgent: vi.fn().mockRejectedValue(new Error("cleanup detail")) });
    const composition = buildAgentExtensionComposition({
      workspaceRoot: "/tmp/sunabot-agent-extension-composition-test",
      agentExists: () => true,
      oauth: false,
      runtime,
      mcpClientFactory: { create: vi.fn() }
    });
    const refresh = vi.fn().mockRejectedValue(new Error("readiness detail"));
    composition.setAgentChangedHandler(refresh);

    const error = await composition.notifyAgentChanged("agent-a").catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      name: "AgentExtensionChangeError",
      message: "AGENT_EXTENSION_CHANGE_RECONCILE_FAILED"
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reports the Agent-bound physical stdio environment key and keeps another Agent missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-extension-composition-"));
    temporaryPaths.push(workspaceRoot);
    for (const directory of [
      "business/agents",
      "business/agents/agent-a",
      "business/agents/agent-b"
    ]) {
      await fs.mkdir(path.join(workspaceRoot, directory), { recursive: true });
      await fs.chmod(path.join(workspaceRoot, directory), 0o700);
    }
    const logicalKey = "TOKEN";
    const agentAKey = mcpStdioCredentialEnvironmentKey("agent-a", "local-mcp", logicalKey);
    const agentBKey = mcpStdioCredentialEnvironmentKey("agent-b", "local-mcp", logicalKey);
    vi.stubEnv(logicalKey, "unbound-global-token");
    vi.stubEnv(agentAKey, "agent-a-token");
    vi.stubEnv(agentBKey, "");
    const composition = buildAgentExtensionComposition({
      workspaceRoot,
      agentExists: () => true,
      oauth: false,
      mcpClientFactory: { create: vi.fn() }
    });
    const server = {
      id: "local-mcp",
      name: "Local MCP",
      description: "Local tools.",
      enabled: false,
      transport: "stdio" as const,
      command: "/usr/bin/local-mcp",
      args: [],
      envKeys: [logicalKey]
    };

    for (const agentId of ["agent-a", "agent-b"]) {
      const preview = await composition.service.previewMcpServer({ agentId, server });
      await composition.service.putMcpServer({
        agentId,
        server,
        replace: false,
        previewRevision: preview.previewRevision,
        approveCommand: true
      });
    }

    await expect(composition.service.overview("agent-a")).resolves.toMatchObject({
      mcp: {
        servers: [{ envKeys: [logicalKey] }],
        secrets: { configuredKeys: [agentAKey], missingKeys: [] }
      }
    });
    await expect(composition.service.overview("agent-b")).resolves.toMatchObject({
      mcp: {
        servers: [{ envKeys: [logicalKey] }],
        secrets: { configuredKeys: [], missingKeys: [agentBKey] }
      }
    });
    expect(agentAKey).not.toBe(agentBKey);
    expect(agentAKey).not.toContain(logicalKey);
    await composition.close();
  });

  it("enables OAuth administration only with a valid production vault key", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-extension-oauth-"));
    temporaryPaths.push(workspaceRoot);
    vi.stubEnv("SUNABOT_MCP_CREDENTIAL_VAULT_KEY", "");
    const disabled = buildAgentExtensionComposition({
      workspaceRoot,
      agentExists: () => true,
      mcpClientFactory: { create: vi.fn() }
    });
    expect(disabled.mcpOAuthService).toBeUndefined();
    await disabled.close();

    vi.stubEnv("SUNABOT_MCP_CREDENTIAL_VAULT_KEY", Buffer.alloc(32, 9).toString("base64url"));
    const enabled = buildAgentExtensionComposition({
      workspaceRoot,
      agentExists: () => true,
      mcpClientFactory: { create: vi.fn() }
    });
    expect(enabled.mcpOAuthService).toBeDefined();
    await enabled.close();
  });
});

function runtimePort(overrides: Partial<RuntimeAgentExtensionsPort> = {}): RuntimeAgentExtensionsPort {
  return {
    prepare: vi.fn(),
    closeConversation: vi.fn().mockResolvedValue(undefined),
    closeAgent: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function stdioServer() {
  return {
    id: "server-a",
    name: "Server A",
    description: "Local MCP server.",
    enabled: true,
    transport: "stdio" as const,
    command: "/usr/bin/server-a",
    args: [],
    envKeys: []
  };
}
