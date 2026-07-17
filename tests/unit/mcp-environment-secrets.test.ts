// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  mcpHttpCredentialEnvironmentKey,
  mcpStdioCredentialEnvironmentKey
} from "../../packages/contracts/extensions/agentExtensions.js";
import { EnvironmentMcpServerSecretResolver } from "../../adapters/mcp/environmentSecrets.js";

describe("MCP environment secret resolver", () => {
  it("injects only the exact stdio allowlist", async () => {
    const serverAKey = mcpStdioCredentialEnvironmentKey("agent-a", "server-a", "TOKEN");
    const serverBKey = mcpStdioCredentialEnvironmentKey("agent-a", "server-b", "TOKEN");
    const agentBKey = mcpStdioCredentialEnvironmentKey("agent-b", "server-a", "TOKEN");
    const resolver = new EnvironmentMcpServerSecretResolver({
      TOKEN: "unbound-global-token",
      [serverAKey]: "token-a",
      [serverBKey]: "token-b",
      [agentBKey]: "token-agent-b",
      HTTP_PROXY: "http://proxy.invalid"
    });
    await expect(resolver.resolveEnvironment({
      agentId: "agent-a",
      serverId: "server-a",
      keys: ["TOKEN"]
    })).resolves.toEqual({ TOKEN: "token-a" });
    await expect(resolver.resolveEnvironment({
      agentId: "agent-a",
      serverId: "server-b",
      keys: ["TOKEN"]
    })).resolves.toEqual({ TOKEN: "token-b" });
    await expect(resolver.resolveEnvironment({
      agentId: "agent-b",
      serverId: "server-a",
      keys: ["TOKEN"]
    })).resolves.toEqual({ TOKEN: "token-agent-b" });
    await expect(resolver.resolveEnvironment({
      agentId: "agent-a",
      serverId: "server-a",
      keys: ["MISSING"]
    })).rejects.toThrow("MCP_STDIO_ENV_UNAVAILABLE");
  });

  it("never falls back from an Agent-bound stdio secret to the logical process key", async () => {
    const resolver = new EnvironmentMcpServerSecretResolver({ TOKEN: "unbound-global-token" });
    await expect(resolver.resolveEnvironment({
      agentId: "agent-a",
      serverId: "server-a",
      keys: ["TOKEN"]
    })).rejects.toThrow("MCP_STDIO_ENV_UNAVAILABLE");
  });

  it("binds bearer environment references to Agent and server while OAuth requires a vault", async () => {
    const key = mcpHttpCredentialEnvironmentKey(
      "agent-a", "server-a", "vault/main", "https://mcp.example.test/"
    );
    const resolver = new EnvironmentMcpServerSecretResolver({ [key]: "bearer-token" });
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-a",
      serverId: "server-a",
      credentialRef: "vault/main",
      resource: "https://mcp.example.test/",
      authKind: "bearer"
    })).resolves.toEqual({ accessToken: "bearer-token" });
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-b",
      serverId: "server-a",
      credentialRef: "vault/main",
      resource: "https://mcp.example.test/",
      authKind: "bearer"
    })).rejects.toThrow("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-a",
      serverId: "server-a",
      credentialRef: "vault/main",
      resource: "https://attacker.example.test/",
      authKind: "bearer"
    })).rejects.toThrow("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-a",
      serverId: "server-a",
      credentialRef: "vault/main",
      resource: "https://mcp.example.test/",
      authKind: "oauth"
    })).rejects.toThrow("MCP_OAUTH_VAULT_UNAVAILABLE");
  });

  it("resolves OAuth handles only through the exact Agent, server, subject and resource binding", async () => {
    const vault = {
      store: async () => "unused",
      remove: async () => undefined,
      resolve: async (handle: string, binding: Record<string, string>) => {
        if (handle !== "mcpcred_abcdefghijklmnopqrstuvwx" ||
            binding.agentId !== "agent-a" || binding.serverId !== "server-a" ||
            binding.subject !== "admin" || binding.resource !== "https://mcp.example.test/") {
          throw new Error("MCP_CREDENTIAL_UNAVAILABLE");
        }
        return { accessToken: "oauth-token" };
      }
    };
    const resolver = new EnvironmentMcpServerSecretResolver({}, { oauthVault: vault });
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-a",
      serverId: "server-a",
      credentialRef: "mcpcred_abcdefghijklmnopqrstuvwx",
      resource: "https://mcp.example.test/",
      authKind: "oauth"
    })).resolves.toEqual({ accessToken: "oauth-token" });
    await expect(resolver.resolveHttpCredential({
      agentId: "agent-b",
      serverId: "server-a",
      credentialRef: "mcpcred_abcdefghijklmnopqrstuvwx",
      resource: "https://mcp.example.test/",
      authKind: "oauth"
    })).rejects.toThrow("MCP_OAUTH_CREDENTIAL_UNAVAILABLE");
  });
});
