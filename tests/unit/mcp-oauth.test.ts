// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMcpCredentialVault,
  McpOAuthCoordinator
} from "../../adapters/mcp/oauth.js";

describe("MCP OAuth coordinator", () => {
  it("binds PKCE and one-time state to agent, server, browser, redirect, and resource", async () => {
    const vault = new InMemoryMcpCredentialVault();
    const oauth = new McpOAuthCoordinator({ vault, stateTtlMs: 60_000 });
    const started = oauth.begin({
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "browser-a",
      authorizationEndpoint: "https://auth.example.test/authorize",
      clientId: "sunabot",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      resource: "https://mcp.example.test/mcp",
      scopes: ["mcp:tools"]
    });
    const authorizationUrl = new URL(started.authorizationUrl);

    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.example.test/mcp");
    expect(started.authorizationOrigin).toBe("https://auth.example.test");
    expect(started).not.toHaveProperty("codeVerifier");

    const exchange = vi.fn().mockResolvedValue({
      accessToken: "access-super-secret",
      refreshToken: "refresh-super-secret",
      expiresAt: 123456
    });
    const completed = await oauth.complete({
      state: started.state,
      code: "authorization-code",
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "browser-a",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      resource: "https://mcp.example.test/mcp",
      subject: "admin",
      exchange
    });

    expect(completed.credentialHandle).toMatch(/^mcpcred_[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(completed)).not.toContain("secret");
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({
      code: "authorization-code",
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/),
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      resource: "https://mcp.example.test/mcp"
    }));
    expect(await vault.resolve(completed.credentialHandle, {
      agentId: "agent-a",
      serverId: "server-a",
      subject: "admin",
      resource: "https://mcp.example.test/mcp"
    })).toMatchObject({ accessToken: "access-super-secret" });
    await expect(vault.resolve(completed.credentialHandle, {
      agentId: "agent-a",
      serverId: "server-a",
      subject: "admin",
      resource: "https://other.example.test/mcp"
    })).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
    await expect(oauth.complete({
      state: started.state,
      code: "again",
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "browser-a",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      resource: "https://mcp.example.test/mcp",
      subject: "admin",
      exchange
    })).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
  });

  it("rejects state consumption across agents, servers, browser sessions, resources, and redirects", async () => {
    const oauth = new McpOAuthCoordinator({ vault: new InMemoryMcpCredentialVault() });
    const base = {
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "browser-a",
      authorizationEndpoint: "https://auth.example.test/authorize",
      clientId: "sunabot",
      redirectUri: "http://localhost:43123/callback",
      resource: "https://mcp.example.test/mcp",
      scopes: []
    };
    const attempts = [
      { agentId: "agent-b" },
      { serverId: "server-b" },
      { browserSessionId: "browser-b" },
      { redirectUri: "http://localhost:43124/callback" },
      { resource: "https://other.example.test/mcp" }
    ];

    for (const mismatch of attempts) {
      const started = oauth.begin(base);
      await expect(oauth.complete({
        ...base,
        ...mismatch,
        state: started.state,
        code: "code",
        subject: "admin",
        exchange: vi.fn()
      })).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
    }
  });

  it.each([
    "https://127.0.0.1:43123/callback",
    "http://0.0.0.0:43123/callback",
    "http://mcp.example.test:43123/callback",
    "http://localhost/callback"
  ])("rejects unsafe callback %s", (redirectUri) => {
    const oauth = new McpOAuthCoordinator({ vault: new InMemoryMcpCredentialVault() });
    expect(() => oauth.begin({
      agentId: "agent-a",
      serverId: "server-a",
      browserSessionId: "browser-a",
      authorizationEndpoint: "https://auth.example.test/authorize",
      clientId: "sunabot",
      redirectUri,
      resource: "https://mcp.example.test/mcp",
      scopes: []
    })).toThrow("MCP_OAUTH_CALLBACK_INVALID");
  });

  it("does not expose token text through vault binding failures", async () => {
    const vault = new InMemoryMcpCredentialVault();
    const handle = await vault.store({
      agentId: "agent-a", serverId: "server-a", subject: "admin", resource: "https://mcp.example.test/mcp"
    }, {
      accessToken: "do-not-leak-me"
    });
    await expect(vault.resolve(handle, {
      agentId: "agent-b",
      serverId: "server-a",
      subject: "admin",
      resource: "https://mcp.example.test/mcp"
    })).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
    try {
      await vault.resolve(handle, {
        agentId: "agent-b", serverId: "server-a", subject: "admin", resource: "https://mcp.example.test/mcp"
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("do-not-leak-me");
    }
  });
});
