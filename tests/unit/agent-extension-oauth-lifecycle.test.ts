// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import {
  EncryptedFileMcpCredentialVault,
  InMemoryMcpCredentialVault
} from "../../adapters/mcp/public.js";
import { buildAgentExtensionComposition } from "../../apps/api/agentExtensionComposition.js";
import {
  AgentExtensionService,
  type AgentMcpMutationLifecyclePort
} from "../../services/extensions/public.js";
import type { RuntimeAgentExtensionsPort } from "../../src/runtime/agentExtensions.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const temporaryPaths: string[] = [];
let workspace = "";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-mcp-oauth-lifecycle-"));
  temporaryPaths.push(workspace);
  const agentsRoot = path.join(workspace, "business/agents");
  await fs.mkdir(path.join(agentsRoot, "agent-a"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(agentsRoot, "agent-b"), { recursive: true, mode: 0o700 });
  await fs.chmod(agentsRoot, 0o700);
  await fs.chmod(path.join(agentsRoot, "agent-a"), 0o700);
  await fs.chmod(path.join(agentsRoot, "agent-b"), 0o700);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((candidate) => fs.rm(candidate, {
    recursive: true,
    force: true
  })));
});

describe("Agent extension OAuth mutation lifecycle", () => {
  it("closes the composed Agent runtime before revocation and leaves the index intact when close fails", async () => {
    const key = Buffer.alloc(32, 7);
    await fs.mkdir(path.join(workspace, "secrets"), { mode: 0o700 });
    const vaultFilePath = path.join(workspace, "secrets/mcp-oauth-vault.json");
    const vault = new EncryptedFileMcpCredentialVault({ filePath: vaultFilePath, key });
    const resource = resourceFor("server-a");
    const exactBinding = binding("agent-a", "server-a", resource);
    const handle = await vault.storeOAuth(exactBinding, tokens("agent-a"), {
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "sunabot-test"
    });
    const closeAgent = vi.fn()
      .mockRejectedValueOnce(new Error("private runtime detail"))
      .mockResolvedValue(undefined);
    const composition = buildAgentExtensionComposition({
      workspaceRoot: workspace,
      agentExists: () => true,
      runtime: runtimePort({ closeAgent }),
      mcpClientFactory: { create: vi.fn() },
      oauth: { vaultKey: key, vaultFilePath }
    });
    await put(composition.service, "agent-a", oauthServer("server-a", resource, handle));
    const before = await new AgentExtensionStore({ workspaceRoot: workspace }).readMcpServerIndex("agent-a");

    await expect(composition.service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED", statusCode: 503 });
    expect(await new AgentExtensionStore({ workspaceRoot: workspace }).readMcpServerIndex("agent-a")).toEqual(before);
    await expect(vault.resolve(handle, exactBinding)).resolves.toMatchObject({ accessToken: "token-agent-a" });

    await expect(composition.service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" }))
      .resolves.toMatchObject({ id: "server-a" });
    expect(closeAgent).toHaveBeenCalledTimes(2);
    await expect(vault.resolve(handle, exactBinding)).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
  });

  it("revokes a deleted binding so re-adding its old reference cannot restore the credential", async () => {
    const fixture = await lifecycleFixture();
    const resource = resourceFor("server-a");
    const handle = await fixture.vault.store(binding("agent-a", "server-a", resource), tokens("agent-a"));
    const descriptor = oauthServer("server-a", resource, handle);
    await put(fixture.service, "agent-a", descriptor);

    await expect(fixture.service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" }))
      .resolves.toMatchObject({ id: "server-a" });
    expect(fixture.invalidations).toEqual([{ agentId: "agent-a", serverId: "server-a", resource, credentialHandle: handle }]);
    await expect(fixture.vault.resolve(handle, binding("agent-a", "server-a", resource)))
      .rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");

    await put(fixture.service, "agent-a", descriptor);
    await expect(fixture.vault.resolve(handle, binding("agent-a", "server-a", resource)))
      .rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
  });

  it("revokes URL, auth-kind and credential-reference replacements while retaining an unchanged binding", async () => {
    const fixture = await lifecycleFixture();
    const cases = ["url", "auth", "handle"] as const;
    for (const kind of cases) {
      const serverId = `server-${kind}`;
      const resource = resourceFor(serverId);
      const oldHandle = await fixture.vault.store(binding("agent-a", serverId, resource), tokens(`old-${kind}`));
      await put(fixture.service, "agent-a", oauthServer(serverId, resource, oldHandle));
      const nextHandle = kind === "handle"
        ? await fixture.vault.store(binding("agent-a", serverId, resource), tokens("next"))
        : oldHandle;
      const next = kind === "url"
        ? oauthServer(serverId, `${resource}/next`, oldHandle)
        : kind === "auth"
          ? noAuthServer(serverId, resource)
          : oauthServer(serverId, resource, nextHandle);
      await put(fixture.service, "agent-a", next, true);
      await expect(fixture.vault.resolve(oldHandle, binding("agent-a", serverId, resource)))
        .rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
      if (kind === "handle") {
        await expect(fixture.vault.resolve(nextHandle, binding("agent-a", serverId, resource)))
          .resolves.toMatchObject({ accessToken: "token-next" });
      }
    }

    const retainedResource = resourceFor("server-retained");
    const retainedHandle = await fixture.vault.store(
      binding("agent-a", "server-retained", retainedResource),
      tokens("retained")
    );
    await put(fixture.service, "agent-a", oauthServer("server-retained", retainedResource, retainedHandle));
    const invalidationsBefore = fixture.invalidations.length;
    await put(fixture.service, "agent-a", {
      ...oauthServer("server-retained", retainedResource, retainedHandle),
      name: "Updated policy",
      enabledTools: ["issues/list"]
    }, true);
    expect(fixture.invalidations).toHaveLength(invalidationsBefore);
    await expect(fixture.vault.resolve(
      retainedHandle,
      binding("agent-a", "server-retained", retainedResource)
    )).resolves.toMatchObject({ accessToken: "token-retained" });
  }, 20_000);

  it("keeps the index unchanged when credential invalidation fails", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const lifecycle: AgentMcpMutationLifecyclePort = {
      invalidateOAuthCredential: vi.fn(async () => { throw new Error("private vault failure"); })
    };
    const service = serviceFor(store, lifecycle);
    const descriptor = oauthServer("server-a", resourceFor("server-a"), `mcpcred_${"A".repeat(24)}`);
    await put(service, "agent-a", descriptor);
    const before = await store.readMcpServerIndex("agent-a");

    await expect(service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED", statusCode: 503 });
    expect(await store.readMcpServerIndex("agent-a")).toEqual(before);
  });

  it("fails safely on a post-revocation CAS conflict", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const vault = new InMemoryMcpCredentialVault();
    const resource = resourceFor("server-a");
    const handle = await vault.store(binding("agent-a", "server-a", resource), tokens("agent-a"));
    const lifecycle: AgentMcpMutationLifecyclePort = {
      async invalidateOAuthCredential(input) {
        await vault.remove(input.credentialHandle, binding(input.agentId, input.serverId, input.resource));
        await store.putMcpServer({
          agentId: input.agentId,
          server: noAuthServer("concurrent-server", resourceFor("concurrent-server")),
          replace: false
        });
      }
    };
    const service = serviceFor(store, lifecycle);
    await put(service, "agent-a", oauthServer("server-a", resource, handle));

    await expect(service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_PREVIEW_STALE", statusCode: 409 });
    expect((await store.readMcpServerIndex("agent-a")).servers.map((server) => server.id).sort())
      .toEqual(["concurrent-server", "server-a"]);
    await expect(vault.resolve(handle, binding("agent-a", "server-a", resource)))
      .rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
  });

  it("revokes only the exact Agent binding", async () => {
    const fixture = await lifecycleFixture();
    const resource = resourceFor("server-a");
    const handleA = await fixture.vault.store(binding("agent-a", "server-a", resource), tokens("agent-a"));
    const handleB = await fixture.vault.store(binding("agent-b", "server-a", resource), tokens("agent-b"));
    await put(fixture.service, "agent-a", oauthServer("server-a", resource, handleA));
    await put(fixture.service, "agent-b", oauthServer("server-a", resource, handleB));

    await fixture.service.removeMcpServer({ agentId: "agent-a", serverId: "server-a" });
    await expect(fixture.vault.resolve(handleA, binding("agent-a", "server-a", resource)))
      .rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
    await expect(fixture.vault.resolve(handleB, binding("agent-b", "server-a", resource)))
      .resolves.toMatchObject({ accessToken: "token-agent-b" });
    expect((await fixture.store.readMcpServerIndex("agent-b")).servers).toHaveLength(1);
  });
});

async function lifecycleFixture() {
  const store = new AgentExtensionStore({ workspaceRoot: workspace });
  const vault = new InMemoryMcpCredentialVault();
  const invalidations: Array<{ agentId: string; serverId: string; resource: string; credentialHandle: string }> = [];
  const lifecycle: AgentMcpMutationLifecyclePort = {
    async invalidateOAuthCredential(input) {
      invalidations.push({ ...input });
      await vault.remove(input.credentialHandle, binding(input.agentId, input.serverId, input.resource));
    }
  };
  return { store, vault, invalidations, service: serviceFor(store, lifecycle) };
}

function serviceFor(store: AgentExtensionStore, lifecycle: AgentMcpMutationLifecyclePort) {
  return new AgentExtensionService(store, undefined, () => true, undefined, lifecycle);
}

async function put(
  service: AgentExtensionService,
  agentId: string,
  server: ReturnType<typeof oauthServer> | ReturnType<typeof noAuthServer>,
  replace = false
) {
  const preview = await service.previewMcpServer({ agentId, server });
  return service.putMcpServer({
    agentId,
    server,
    replace,
    previewRevision: preview.previewRevision,
    approveCommand: false
  });
}

function oauthServer(serverId: string, url: string, credentialRef: string) {
  return {
    id: serverId,
    name: serverId,
    description: "Remote MCP.",
    enabled: false,
    required: false,
    enabledTools: [] as string[],
    disabledTools: [] as string[],
    approvalMode: "always" as const,
    transport: "streamable_http" as const,
    url,
    auth: { kind: "oauth" as const, credentialRef }
  };
}

function noAuthServer(serverId: string, url: string) {
  return {
    ...oauthServer(serverId, url, "pending"),
    auth: { kind: "none" as const }
  };
}

function binding(agentId: string, serverId: string, resource: string) {
  return { agentId, serverId, subject: "admin", resource };
}

function tokens(label: string) {
  return { accessToken: `token-${label}` };
}

function resourceFor(serverId: string) {
  return `https://mcp.example.test/${serverId}`;
}

function runtimePort(overrides: Partial<RuntimeAgentExtensionsPort> = {}): RuntimeAgentExtensionsPort {
  return {
    prepare: vi.fn(),
    closeConversation: vi.fn().mockResolvedValue(undefined),
    closeAgent: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}
