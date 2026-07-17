// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { McpOAuthAdminService } from "../../src/admin/mcpOAuthAdminService.js";

const handle = `mcpcred_${"a".repeat(24)}`;

describe("MCP OAuth admin service", () => {
  it("binds a loopback callback to the captured Agent/server revision and never returns credentials", async () => {
    const fixture = setup();
    const result = await fixture.service.begin({
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "session:browser-a",
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "client-a",
      scopes: ["tools"],
      signal: new AbortController().signal
    });
    expect(result).toEqual({
      authorizationUrl: "https://auth.example.test/authorize?opaque=1",
      authorizationOrigin: "https://auth.example.test",
      expiresAt: "2026-07-17T00:05:00.000Z"
    });
    expect(fixture.oauth.begin).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "session:browser-a",
      redirectUri: "http://127.0.0.1:50000/oauth/callback",
      resource: "https://mcp.example.test/mcp"
    }));
    await fixture.callback!({
      state: "state-a", code: "authorization-code", signal: new AbortController().signal
    });
    expect(fixture.repository.bindMcpOAuthCredential).toHaveBeenCalledWith({
      agentId: "agent-a",
      serverId: "server-a",
      expectedRevision: "b".repeat(64),
      expectedUrl: "https://mcp.example.test/mcp",
      credentialRef: handle
    });
    expect(fixture.changed).toHaveBeenCalledWith("agent-a");
    expect(JSON.stringify(result)).not.toContain(handle);
  });

  it("revokes the new credential when the descriptor CAS changes during callback", async () => {
    const fixture = setup();
    fixture.repository.bindMcpOAuthCredential.mockRejectedValue(new Error("MCP_INDEX_REVISION_CONFLICT"));
    await fixture.service.begin(beginInput());
    await expect(fixture.callback!({
      state: "state-a", code: "authorization-code", signal: new AbortController().signal
    })).rejects.toThrow("MCP_INDEX_REVISION_CONFLICT");
    expect(fixture.oauth.revoke).toHaveBeenCalledWith({
      agentId: "agent-a",
      serverId: "server-a",
      subject: "admin",
      resource: "https://mcp.example.test/mcp",
      credentialHandle: handle
    });
    expect(fixture.changed).not.toHaveBeenCalled();
  });

  it("refreshes exact bindings, and revoke disables the matching descriptor", async () => {
    const fixture = setup(true);
    await expect(fixture.service.refresh({ agentId: "agent-a", serverId: "server-a" }))
      .resolves.toEqual({ ok: true, expiresAt: "2026-07-17T01:00:00.000Z" });
    expect(fixture.oauth.refresh).toHaveBeenCalledWith({
      agentId: "agent-a", serverId: "server-a", subject: "admin",
      resource: "https://mcp.example.test/mcp", credentialHandle: handle, signal: undefined
    });
    await expect(fixture.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .resolves.toEqual({ ok: true });
    expect(fixture.repository.disableMcpOAuthCredential).toHaveBeenCalledWith({
      agentId: "agent-a", serverId: "server-a", expectedRevision: "b".repeat(64),
      expectedUrl: "https://mcp.example.test/mcp", credentialRef: handle
    });
    expect(fixture.repository.disableMcpOAuthCredential.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.changed.mock.invocationCallOrder.at(-1)!);
    expect(fixture.changed.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(fixture.oauth.revoke.mock.invocationCallOrder[0]!);
  });

  it("keeps the vault and runtime untouched when revoke descriptor CAS fails", async () => {
    const fixture = setup(true);
    fixture.repository.disableMcpOAuthCredential.mockRejectedValue(new Error("MCP_INDEX_REVISION_CONFLICT"));
    await expect(fixture.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_INDEX_REVISION_CONFLICT" });
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.oauth.revoke).not.toHaveBeenCalled();
  });

  it("always attempts vault cleanup after disabling even when runtime reload fails", async () => {
    const closeFailure = setup(true);
    closeFailure.changed.mockRejectedValue(new Error("client close failed"));
    await expect(closeFailure.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_RUNTIME_RELOAD_FAILED" });
    expect(closeFailure.repository.disableMcpOAuthCredential).toHaveBeenCalledOnce();
    expect(closeFailure.oauth.revoke).toHaveBeenCalledOnce();

    const vaultFailure = setup(true);
    vaultFailure.oauth.revoke.mockRejectedValue(new Error("vault unavailable"));
    await expect(vaultFailure.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_REQUEST_FAILED" });
    expect(vaultFailure.repository.disableMcpOAuthCredential).toHaveBeenCalledOnce();
    expect(vaultFailure.changed).toHaveBeenCalledOnce();
  });

  it("retains failed credential cleanup for an explicit revoke retry", async () => {
    const fixture = setup(true);
    fixture.oauth.revoke.mockRejectedValueOnce(new Error("MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED"));
    await expect(fixture.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED" });
    await expect(fixture.service.revoke({ agentId: "agent-a", serverId: "server-a" }))
      .resolves.toEqual({ ok: true });
    expect(fixture.oauth.revoke).toHaveBeenCalledTimes(2);
  });

  it("reports lifecycle reload failures after refresh and rolls back a newly bound callback", async () => {
    const refresh = setup(true);
    refresh.changed.mockRejectedValue(new Error("client close failed"));
    await expect(refresh.service.refresh({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_RUNTIME_RELOAD_FAILED" });

    const callback = setup(true);
    callback.changed.mockRejectedValueOnce(new Error("client close failed"));
    await callback.service.begin(beginInput());
    await expect(callback.callback!({
      state: "state-a", code: "authorization-code", signal: new AbortController().signal
    })).rejects.toThrow("MCP_OAUTH_RUNTIME_RELOAD_FAILED");
    expect(callback.repository.disableMcpOAuthCredential).toHaveBeenCalledOnce();
    expect(callback.changed).toHaveBeenCalledTimes(2);
    expect(callback.oauth.revoke).toHaveBeenCalledWith({
      agentId: "agent-a", serverId: "server-a", subject: "admin",
      resource: "https://mcp.example.test/mcp", credentialHandle: handle
    });
  });

  it("revokes a rolled-back callback credential even when the second runtime reload fails", async () => {
    const fixture = setup(true);
    fixture.changed.mockRejectedValue(new Error("client close failed"));
    await fixture.service.begin(beginInput());
    await expect(fixture.callback!({
      state: "state-a", code: "authorization-code", signal: new AbortController().signal
    })).rejects.toThrow("MCP_OAUTH_RUNTIME_RELOAD_FAILED");
    expect(fixture.repository.disableMcpOAuthCredential).toHaveBeenCalledOnce();
    expect(fixture.changed).toHaveBeenCalledTimes(2);
    expect(fixture.oauth.revoke).toHaveBeenCalledOnce();
    expect(fixture.changed.mock.invocationCallOrder[1])
      .toBeLessThan(fixture.oauth.revoke.mock.invocationCallOrder[0]!);
  });

  it("cleans invalid_grant credentials even when the runtime reload fails", async () => {
    const fixture = setup(true);
    fixture.oauth.refresh.mockRejectedValue(new Error("MCP_OAUTH_INVALID_GRANT"));
    fixture.changed.mockRejectedValue(new Error("client close failed"));
    await expect(fixture.service.refresh({ agentId: "agent-a", serverId: "server-a" }))
      .rejects.toMatchObject({ code: "MCP_OAUTH_RUNTIME_RELOAD_FAILED" });
    expect(fixture.repository.disableMcpOAuthCredential).toHaveBeenCalledOnce();
    expect(fixture.oauth.revoke).toHaveBeenCalledOnce();
  });

  it("closes pending loopback reservations with the Agent lifecycle", async () => {
    const fixture = setup();
    await fixture.service.begin(beginInput());
    await fixture.service.closeAgent("agent-a");
    expect(fixture.oauth.revokeAgent).toHaveBeenCalledWith("agent-a");
    expect(fixture.reservation.close).toHaveBeenCalledOnce();
  });

  it("keeps a failed loopback close available for a bounded lifecycle retry", async () => {
    const fixture = setup();
    fixture.reservation.close.mockRejectedValueOnce(new Error("close failed"));
    await fixture.service.begin(beginInput());
    await expect(fixture.service.closeAgent("agent-a"))
      .rejects.toThrow("MCP_OAUTH_LOOPBACK_CLOSE_FAILED");
    await expect(fixture.service.closeAgent("agent-a")).resolves.toBeUndefined();
    expect(fixture.reservation.close).toHaveBeenCalledTimes(2);
  });
});

function setup(configured = false) {
  let callback: ((input: { state: string; code: string; signal: AbortSignal }) => Promise<void>) | undefined;
  const reservation = {
    redirectUri: "http://127.0.0.1:50000/oauth/callback",
    activate: vi.fn((input: { onCallback: typeof callback }) => { callback = input.onCallback; }),
    close: vi.fn(async () => undefined)
  };
  const oauth = {
    begin: vi.fn(() => ({
      authorizationUrl: "https://auth.example.test/authorize?opaque=1",
      authorizationOrigin: "https://auth.example.test",
      state: "state-a",
      expiresAt: Date.parse("2026-07-17T00:05:00.000Z")
    })),
    completeCallback: vi.fn(async () => ({
      credentialHandle: handle,
      agentId: "agent-a",
      serverId: "server-a",
      resource: "https://mcp.example.test/mcp",
      subject: "admin"
    })),
    cancel: vi.fn(),
    refresh: vi.fn(async () => ({ credentialHandle: handle, expiresAt: Date.parse("2026-07-17T01:00:00.000Z") })),
    revoke: vi.fn(async () => undefined),
    revokeAgent: vi.fn()
  };
  const repository = {
    ensureLayout: vi.fn(async () => undefined),
    readMcpServerIndex: vi.fn(async () => ({
      schemaVersion: 1,
      revision: "b".repeat(64),
      servers: [{
        id: "server-a", name: "Server A", description: "Test", enabled: true,
        required: false, enabledTools: [], disabledTools: [], approvalMode: "always",
        transport: "streamable_http", url: "https://mcp.example.test/mcp",
        auth: { kind: "oauth", credentialRef: configured ? handle : "pending" }
      }]
    })),
    bindMcpOAuthCredential: vi.fn(async () => ({})),
    disableMcpOAuthCredential: vi.fn(async () => ({}))
  };
  const changed = vi.fn(async () => undefined);
  const service = new McpOAuthAdminService({
    repository: repository as never,
    oauth: oauth as never,
    loopback: { reserve: vi.fn(async () => reservation) } as never,
    agentExists: () => true,
    onAgentChanged: changed
  });
  return { service, repository, oauth, reservation, changed, get callback() { return callback; } };
}

function beginInput() {
  return {
    agentId: "agent-a",
    serverId: "server-a",
    browserSessionId: "session:browser-a",
    authorizationEndpoint: "https://auth.example.test/authorize",
    tokenEndpoint: "https://auth.example.test/token",
    clientId: "client-a",
    scopes: []
  };
}
