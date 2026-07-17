import {
  mcpHttpCredentialEnvironmentKey,
  mcpStdioCredentialEnvironmentKey
} from "../../packages/contracts/extensions/agentExtensions.js";
import type { McpCredentialVault } from "./oauth.js";
import type { McpServerSecretResolver } from "./runtimeClientFactory.js";

export const MCP_OAUTH_ADMIN_SUBJECT = "admin";

export class EnvironmentMcpServerSecretResolver implements McpServerSecretResolver {
  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly options: {
      oauthVault?: McpCredentialVault;
      oauthSubject?: string;
    } = {}
  ) {}

  async resolveEnvironment(input: { agentId: string; serverId: string; keys: readonly string[] }) {
    const result: Record<string, string> = {};
    for (const key of input.keys) {
      let physicalKey: string;
      try {
        physicalKey = mcpStdioCredentialEnvironmentKey(input.agentId, input.serverId, key);
      } catch {
        throw stableError("MCP_STDIO_ENV_UNAVAILABLE");
      }
      const value = this.environment[physicalKey];
      if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024) {
        throw stableError("MCP_STDIO_ENV_UNAVAILABLE");
      }
      result[key] = value;
    }
    return result;
  }

  async resolveHttpCredential(input: {
    agentId: string;
    serverId: string;
    credentialRef: string;
    resource: string;
    authKind: "bearer" | "oauth";
  }) {
    if (input.authKind === "oauth") {
      if (!this.options.oauthVault) throw stableError("MCP_OAUTH_VAULT_UNAVAILABLE");
      try {
        const credential = await this.options.oauthVault.resolve(input.credentialRef, {
          agentId: input.agentId,
          serverId: input.serverId,
          subject: this.options.oauthSubject ?? MCP_OAUTH_ADMIN_SUBJECT,
          resource: input.resource
        });
        if (!credential.accessToken || credential.accessToken.includes("\0") ||
            Buffer.byteLength(credential.accessToken, "utf8") > 16 * 1024) {
          throw stableError("MCP_OAUTH_CREDENTIAL_UNAVAILABLE");
        }
        return { accessToken: credential.accessToken };
      } catch {
        throw stableError("MCP_OAUTH_CREDENTIAL_UNAVAILABLE");
      }
    }
    const key = mcpHttpCredentialEnvironmentKey(
      input.agentId,
      input.serverId,
      input.credentialRef,
      input.resource
    );
    const accessToken = this.environment[key];
    if (!accessToken || accessToken.includes("\0") || Buffer.byteLength(accessToken, "utf8") > 16 * 1024) {
      throw stableError("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
    }
    return { accessToken };
  }
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
