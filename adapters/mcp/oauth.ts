import { createHash, randomBytes } from "node:crypto";
import { assertSafeMcpBrowserAuthorizationEndpoint } from "./controlledHttp.js";

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface McpCredentialBinding {
  agentId: string;
  serverId: string;
  subject: string;
  resource: string;
}

export interface McpCredentialVault {
  store(binding: McpCredentialBinding, tokens: McpOAuthTokens): Promise<string>;
  resolve(handle: string, binding: McpCredentialBinding): Promise<McpOAuthTokens>;
  remove(handle: string, binding: McpCredentialBinding): Promise<void>;
}

interface StoredCredential {
  binding: McpCredentialBinding;
  tokens: McpOAuthTokens;
}

/** Test/development vault. Production composition must inject an encrypted OS-backed vault. */
export class InMemoryMcpCredentialVault implements McpCredentialVault {
  private readonly credentials = new Map<string, StoredCredential>();

  async store(binding: McpCredentialBinding, tokens: McpOAuthTokens) {
    validateTokens(tokens);
    const handle = `mcpcred_${randomToken(24)}`;
    this.credentials.set(handle, {
      binding: { ...binding },
      tokens: { ...tokens }
    });
    return handle;
  }

  async resolve(handle: string, binding: McpCredentialBinding) {
    const stored = this.credentials.get(handle);
    if (!stored || !sameBinding(stored.binding, binding)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
    return { ...stored.tokens };
  }

  async remove(handle: string, binding: McpCredentialBinding) {
    const stored = this.credentials.get(handle);
    if (!stored || !sameBinding(stored.binding, binding)) throw stableError("MCP_CREDENTIAL_UNAVAILABLE");
    this.credentials.delete(handle);
  }
}

export interface McpOAuthBeginInput {
  agentId: string;
  serverId: string;
  browserSessionId: string;
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
}

export interface McpOAuthCompleteInput {
  state: string;
  code: string;
  agentId: string;
  serverId: string;
  browserSessionId: string;
  redirectUri: string;
  resource: string;
  subject: string;
  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  }): Promise<McpOAuthTokens>;
}

interface PendingOAuthState {
  state: string;
  agentId: string;
  serverId: string;
  browserSessionId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
  expiresAt: number;
}

export class McpOAuthCoordinator {
  private readonly pending = new Map<string, PendingOAuthState>();
  private readonly stateTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: {
    vault: McpCredentialVault;
    stateTtlMs?: number;
    now?: () => number;
  }) {
    this.stateTtlMs = boundedTtl(options.stateTtlMs ?? 5 * 60_000);
    this.now = options.now ?? Date.now;
  }

  begin(input: McpOAuthBeginInput) {
    this.pruneExpiredStates();
    if (this.pending.size >= 256) throw stableError("MCP_OAUTH_STATE_LIMIT");
    validateIdentifier(input.agentId);
    validateIdentifier(input.serverId);
    validateIdentifier(input.browserSessionId);
    const authorizationEndpoint = validateAuthorizationEndpoint(input.authorizationEndpoint);
    const redirectUri = validateCallback(input.redirectUri);
    const resource = validateResource(input.resource);
    if (!input.clientId.trim() || Buffer.byteLength(input.clientId) > 256) throw stableError("MCP_OAUTH_INPUT_INVALID");
    if (input.scopes.length > 32 || input.scopes.some((scope) => !scope.trim() || Buffer.byteLength(scope) > 256)) {
      throw stableError("MCP_OAUTH_INPUT_INVALID");
    }
    const state = randomToken(32);
    const codeVerifier = randomToken(32);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.pending.set(state, {
      state,
      agentId: input.agentId,
      serverId: input.serverId,
      browserSessionId: input.browserSessionId,
      redirectUri,
      resource,
      codeVerifier,
      expiresAt: this.now() + this.stateTtlMs
    });
    authorizationEndpoint.searchParams.set("response_type", "code");
    authorizationEndpoint.searchParams.set("client_id", input.clientId);
    authorizationEndpoint.searchParams.set("redirect_uri", redirectUri);
    authorizationEndpoint.searchParams.set("state", state);
    authorizationEndpoint.searchParams.set("code_challenge", codeChallenge);
    authorizationEndpoint.searchParams.set("code_challenge_method", "S256");
    authorizationEndpoint.searchParams.set("resource", resource);
    if (input.scopes.length > 0) authorizationEndpoint.searchParams.set("scope", input.scopes.join(" "));
    return {
      authorizationUrl: authorizationEndpoint.toString(),
      authorizationOrigin: authorizationEndpoint.origin,
      state,
      expiresAt: this.now() + this.stateTtlMs
    };
  }

  async complete(input: McpOAuthCompleteInput) {
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    const redirectUri = safeValidation(() => validateCallback(input.redirectUri));
    const resource = safeValidation(() => validateResource(input.resource));
    if (!pending
      || pending.expiresAt <= this.now()
      || !redirectUri
      || !resource
      || pending.agentId !== input.agentId
      || pending.serverId !== input.serverId
      || pending.browserSessionId !== input.browserSessionId
      || pending.redirectUri !== redirectUri
      || pending.resource !== resource
      || !input.code
      || input.code.includes("\0")
      || Buffer.byteLength(input.code) > 8 * 1024) {
      throw stableError("MCP_OAUTH_STATE_INVALID");
    }
    validateIdentifier(input.subject);
    let tokens: McpOAuthTokens;
    try {
      tokens = await input.exchange({
        code: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri,
        resource
      });
      validateTokens(tokens);
    } catch {
      throw stableError("MCP_OAUTH_EXCHANGE_FAILED");
    }
    let credentialHandle: string;
    try {
      credentialHandle = await this.options.vault.store({
        agentId: input.agentId,
        serverId: input.serverId,
        subject: input.subject,
        resource
      }, tokens);
    } catch {
      throw stableError("MCP_CREDENTIAL_STORE_FAILED");
    }
    return { credentialHandle };
  }

  revokeAgent(agentId: string) {
    for (const [state, pending] of this.pending) {
      if (pending.agentId === agentId) this.pending.delete(state);
    }
  }

  private pruneExpiredStates() {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

function validateAuthorizationEndpoint(raw: string) {
  try {
    return assertSafeMcpBrowserAuthorizationEndpoint(raw);
  } catch {
    throw stableError("MCP_OAUTH_AUTHORIZATION_ENDPOINT_INVALID");
  }
}

function validateCallback(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError("MCP_OAUTH_CALLBACK_INVALID");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:"
    || (host !== "localhost" && host !== "127.0.0.1")
    || !url.port
    || Number(url.port) < 1024
    || Number(url.port) > 65_535
    || url.username
    || url.password
    || url.hash) {
    throw stableError("MCP_OAUTH_CALLBACK_INVALID");
  }
  return url.toString();
}

function validateResource(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError("MCP_OAUTH_RESOURCE_INVALID");
  }
  const localhost = url.hostname.toLowerCase() === "localhost";
  if ((url.protocol !== "https:" && !(localhost && url.protocol === "http:"))
    || url.username
    || url.password
    || url.hash) {
    throw stableError("MCP_OAUTH_RESOURCE_INVALID");
  }
  return url.toString();
}

function validateIdentifier(value: string) {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > 256) throw stableError("MCP_OAUTH_INPUT_INVALID");
}

function validateTokens(tokens: McpOAuthTokens) {
  if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken || tokens.accessToken.includes("\0")
    || Buffer.byteLength(tokens.accessToken) > 16 * 1024
    || (tokens.refreshToken !== undefined && (!tokens.refreshToken || tokens.refreshToken.includes("\0") || Buffer.byteLength(tokens.refreshToken) > 16 * 1024))
    || (tokens.expiresAt !== undefined && (!Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt < 0))) {
    throw stableError("MCP_CREDENTIAL_INVALID");
  }
}

function sameBinding(left: McpCredentialBinding, right: McpCredentialBinding) {
  return left.agentId === right.agentId
    && left.serverId === right.serverId
    && left.subject === right.subject
    && left.resource === right.resource;
}

function randomToken(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function boundedTtl(value: number) {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 15 * 60_000) throw stableError("MCP_OAUTH_CONFIG_INVALID");
  return value;
}

function safeValidation(validate: () => string) {
  try {
    return validate();
  } catch {
    return undefined;
  }
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
