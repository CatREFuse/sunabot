import { createHash, randomBytes } from "node:crypto";
import { assertSafeMcpBrowserAuthorizationEndpoint } from "./controlledHttp.js";
import type { McpCredentialBinding, McpOAuthTokens } from "./oauth.js";
import type { McpOAuthCredentialVault } from "./encryptedCredentialVault.js";

const DEFAULT_STATE_TTL_MS = 5 * 60_000;
const MAX_PENDING_STATES = 256;
const MIN_EPHEMERAL_CALLBACK_PORT = 49_152;

export interface McpOAuthAuthorizationCodeExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  signal?: AbortSignal;
}

export interface McpOAuthRefreshExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string;
  signal?: AbortSignal;
}

export type McpOAuthRefreshExchangeResult =
  | { status: "ok"; tokens: McpOAuthTokens }
  | { status: "invalid_grant" };

/** Implementations must use the controlled HTTP client and bounded response parsing. */
export interface McpOAuthTokenExchangePort {
  exchangeAuthorizationCode(input: McpOAuthAuthorizationCodeExchangeInput): Promise<McpOAuthTokens>;
  refreshAccessToken(input: McpOAuthRefreshExchangeInput): Promise<McpOAuthRefreshExchangeResult>;
}

export interface McpOAuthServiceBeginInput {
  agentId: string;
  serverId: string;
  browserSessionId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
}

export interface McpOAuthServiceCompleteInput {
  state: string;
  code: string;
  agentId: string;
  serverId: string;
  browserSessionId: string;
  redirectUri: string;
  resource: string;
  subject: string;
  signal?: AbortSignal;
}

export interface McpOAuthServiceCallbackInput {
  state: string;
  code: string;
  browserSessionId: string;
  subject: string;
  signal?: AbortSignal;
}

export interface McpOAuthServiceRefreshInput extends McpCredentialBinding {
  credentialHandle: string;
  signal?: AbortSignal;
}

interface PendingAuthorization {
  agentId: string;
  serverId: string;
  browserSessionId: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
  expiresAt: number;
}

export class McpOAuthService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly refreshes = new Map<string, Promise<{ credentialHandle: string; expiresAt?: number }>>();
  private readonly stateTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: {
    vault: McpOAuthCredentialVault;
    exchange: McpOAuthTokenExchangePort;
    stateTtlMs?: number;
    now?: () => number;
  }) {
    this.stateTtlMs = boundedTtl(options.stateTtlMs ?? DEFAULT_STATE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  begin(input: McpOAuthServiceBeginInput) {
    this.pruneExpired();
    if (this.pending.size >= MAX_PENDING_STATES) throw stableError("MCP_OAUTH_STATE_LIMIT");
    const agentId = identifier(input.agentId);
    const serverId = identifier(input.serverId);
    const browserSessionId = identifier(input.browserSessionId);
    const authorizationEndpoint = authorizationEndpointUrl(input.authorizationEndpoint);
    const tokenEndpoint = endpoint(input.tokenEndpoint, "MCP_OAUTH_TOKEN_ENDPOINT_INVALID");
    const clientId = identifier(input.clientId);
    const redirectUri = callback(input.redirectUri);
    const resource = resourceUrl(input.resource);
    const scopes = validateScopes(input.scopes);
    const state = randomToken(32);
    const codeVerifier = randomToken(32);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const expiresAt = this.now() + this.stateTtlMs;
    this.pending.set(state, {
      agentId,
      serverId,
      browserSessionId,
      tokenEndpoint: tokenEndpoint.toString(),
      clientId,
      redirectUri,
      resource,
      codeVerifier,
      expiresAt
    });
    authorizationEndpoint.searchParams.set("response_type", "code");
    authorizationEndpoint.searchParams.set("client_id", clientId);
    authorizationEndpoint.searchParams.set("redirect_uri", redirectUri);
    authorizationEndpoint.searchParams.set("state", state);
    authorizationEndpoint.searchParams.set("code_challenge", codeChallenge);
    authorizationEndpoint.searchParams.set("code_challenge_method", "S256");
    authorizationEndpoint.searchParams.set("resource", resource);
    if (scopes.length > 0) authorizationEndpoint.searchParams.set("scope", scopes.join(" "));
    return {
      authorizationUrl: authorizationEndpoint.toString(),
      authorizationOrigin: authorizationEndpoint.origin,
      state,
      expiresAt
    };
  }

  async complete(input: McpOAuthServiceCompleteInput) {
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    const actual = safeCompleteBinding(input);
    if (!pending
      || pending.expiresAt <= this.now()
      || !actual
      || pending.agentId !== actual.agentId
      || pending.serverId !== actual.serverId
      || pending.browserSessionId !== actual.browserSessionId
      || pending.redirectUri !== actual.redirectUri
      || pending.resource !== actual.resource
      || !validAuthorizationCode(input.code)) {
      throw stableError("MCP_OAUTH_STATE_INVALID");
    }
    abortIfRequested(input.signal);
    let tokens: McpOAuthTokens;
    try {
      tokens = await this.options.exchange.exchangeAuthorizationCode({
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        code: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: pending.resource,
        signal: input.signal
      });
      tokens = validateTokens(tokens);
    } catch (error) {
      if (input.signal?.aborted) throw abortError();
      throw stableError("MCP_OAUTH_EXCHANGE_FAILED");
    }
    let credentialHandle: string;
    try {
      credentialHandle = await this.options.vault.storeOAuth({
        agentId: pending.agentId,
        serverId: pending.serverId,
        subject: actual.subject,
        resource: pending.resource
      }, tokens, {
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId
      });
    } catch {
      throw stableError("MCP_CREDENTIAL_STORE_FAILED");
    }
    return {
      credentialHandle,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt })
    };
  }

  async completeCallback(input: McpOAuthServiceCallbackInput) {
    const pending = this.pending.get(input.state);
    if (!pending) {
      this.pending.delete(input.state);
      throw stableError("MCP_OAUTH_STATE_INVALID");
    }
    const completed = await this.complete({
      state: input.state,
      code: input.code,
      agentId: pending.agentId,
      serverId: pending.serverId,
      browserSessionId: input.browserSessionId,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      subject: input.subject,
      signal: input.signal
    });
    return {
      ...completed,
      agentId: pending.agentId,
      serverId: pending.serverId,
      resource: pending.resource,
      subject: input.subject
    };
  }

  cancel(state: string) {
    this.pending.delete(state);
  }

  refresh(input: McpOAuthServiceRefreshInput) {
    const binding = validateBinding(input);
    validateHandle(input.credentialHandle);
    const key = refreshKey(input.credentialHandle, binding);
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const operation = this.refreshCredential(input.credentialHandle, binding, input.signal)
      .finally(() => {
        if (this.refreshes.get(key) === operation) this.refreshes.delete(key);
      });
    this.refreshes.set(key, operation);
    return operation;
  }

  async revoke(input: McpOAuthServiceRefreshInput) {
    const binding = validateBinding(input);
    validateHandle(input.credentialHandle);
    try {
      await this.options.vault.remove(input.credentialHandle, binding);
    } catch {
      throw stableError("MCP_OAUTH_CREDENTIAL_INVALIDATION_FAILED");
    }
  }

  revokeAgent(agentId: string) {
    for (const [state, pending] of this.pending) {
      if (pending.agentId === agentId) this.pending.delete(state);
    }
  }

  private async refreshCredential(
    credentialHandle: string,
    binding: McpCredentialBinding,
    signal: AbortSignal | undefined
  ) {
    abortIfRequested(signal);
    let credential;
    try {
      credential = await this.options.vault.resolveForRefresh(credentialHandle, binding);
    } catch {
      throw stableError("MCP_OAUTH_REFRESH_UNAVAILABLE");
    }
    const refreshToken = credential.tokens.refreshToken;
    if (!refreshToken) throw stableError("MCP_OAUTH_REFRESH_UNAVAILABLE");
    let exchanged: McpOAuthRefreshExchangeResult;
    try {
      exchanged = await this.options.exchange.refreshAccessToken({
        tokenEndpoint: credential.oauth.tokenEndpoint,
        clientId: credential.oauth.clientId,
        refreshToken,
        resource: binding.resource,
        signal
      });
    } catch {
      if (signal?.aborted) throw abortError();
      throw stableError("MCP_OAUTH_REFRESH_FAILED");
    }
    if (exchanged.status === "invalid_grant") {
      throw stableError("MCP_OAUTH_INVALID_GRANT");
    }
    const next = validateTokens({
      ...exchanged.tokens,
      refreshToken: exchanged.tokens.refreshToken ?? refreshToken
    });
    try {
      await this.options.vault.rotateOAuth(credentialHandle, binding, credential.revision, next);
    } catch {
      throw stableError("MCP_OAUTH_REFRESH_FAILED");
    }
    return {
      credentialHandle,
      ...(next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt })
    };
  }

  private pruneExpired() {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

function safeCompleteBinding(input: McpOAuthServiceCompleteInput) {
  try {
    return {
      agentId: identifier(input.agentId),
      serverId: identifier(input.serverId),
      browserSessionId: identifier(input.browserSessionId),
      redirectUri: callback(input.redirectUri),
      resource: resourceUrl(input.resource),
      subject: identifier(input.subject)
    };
  } catch {
    return undefined;
  }
}

function validateBinding(input: McpCredentialBinding): McpCredentialBinding {
  return {
    agentId: identifier(input.agentId),
    serverId: identifier(input.serverId),
    subject: identifier(input.subject),
    resource: resourceUrl(input.resource)
  };
}

function endpoint(raw: string, code: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError(code);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw stableError(code);
  return url;
}

function authorizationEndpointUrl(raw: string) {
  try {
    return assertSafeMcpBrowserAuthorizationEndpoint(raw);
  } catch {
    throw stableError("MCP_OAUTH_AUTHORIZATION_ENDPOINT_INVALID");
  }
}

function callback(raw: string) {
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
    || Number(url.port) < MIN_EPHEMERAL_CALLBACK_PORT
    || Number(url.port) > 65_535
    || url.username
    || url.password
    || url.hash) {
    throw stableError("MCP_OAUTH_CALLBACK_INVALID");
  }
  return url.toString();
}

function resourceUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw stableError("MCP_OAUTH_RESOURCE_INVALID");
  }
  const localhost = url.hostname.toLowerCase() === "localhost";
  if ((url.protocol !== "https:" && !(localhost && url.protocol === "http:"))
    || url.username || url.password || url.hash) {
    throw stableError("MCP_OAUTH_RESOURCE_INVALID");
  }
  return url.toString();
}

function validateScopes(scopes: string[]) {
  if (!Array.isArray(scopes) || scopes.length > 32) throw stableError("MCP_OAUTH_INPUT_INVALID");
  const normalized = scopes.map((scope) => identifier(scope));
  if (new Set(normalized).size !== normalized.length) throw stableError("MCP_OAUTH_INPUT_INVALID");
  return normalized;
}

function validateTokens(tokens: McpOAuthTokens): McpOAuthTokens {
  if (!tokens
    || typeof tokens !== "object"
    || typeof tokens.accessToken !== "string"
    || !validSecret(tokens.accessToken)
    || (tokens.refreshToken !== undefined && (typeof tokens.refreshToken !== "string" || !validSecret(tokens.refreshToken)))
    || (tokens.expiresAt !== undefined && (!Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt < 0))) {
    throw stableError("MCP_CREDENTIAL_INVALID");
  }
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt })
  };
}

function identifier(value: string) {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\0")
    || Buffer.byteLength(value) > 256) {
    throw stableError("MCP_OAUTH_INPUT_INVALID");
  }
  return value;
}

function validSecret(value: string) {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024;
}

function validAuthorizationCode(value: string) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 8 * 1024;
}

function validateHandle(handle: string) {
  if (!/^mcpcred_[A-Za-z0-9_-]{24,128}$/u.test(handle)) throw stableError("MCP_OAUTH_REFRESH_UNAVAILABLE");
}

function refreshKey(handle: string, binding: McpCredentialBinding) {
  return `${handle}\0${binding.agentId}\0${binding.serverId}\0${binding.subject}\0${binding.resource}`;
}

function boundedTtl(value: number) {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 15 * 60_000) {
    throw stableError("MCP_OAUTH_CONFIG_INVALID");
  }
  return value;
}

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return stableError("MCP_OAUTH_ABORTED");
}

function randomToken(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpOAuthServiceError";
  return error;
}
