import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  assertSafeMcpHttpEndpoint,
  createControlledMcpFetch,
  type ControlledMcpFetchOptions
} from "./controlledHttp.js";
import type {
  McpOAuthAuthorizationCodeExchangeInput,
  McpOAuthRefreshExchangeInput,
  McpOAuthRefreshExchangeResult,
  McpOAuthTokenExchangePort
} from "./oauthService.js";
import type { McpOAuthTokens } from "./oauth.js";

const DEFAULT_MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_REFRESH_TOKEN_BYTES = 16 * 1024;
const MAX_SCOPE_BYTES = 4 * 1024;

export interface McpOAuthHttpTokenExchangeOptions {
  fetch: FetchLike;
  maxResponseBytes?: number;
  now?: () => number;
}

export interface ControlledMcpOAuthTokenExchangeOptions extends Omit<ControlledMcpFetchOptions, "maxResponseBytes"> {
  maxResponseBytes?: number;
  now?: () => number;
}

/**
 * Builds the production token exchange on the same DNS-pinned, redirect-bounded
 * HTTP transport used by remote MCP sessions.
 */
export function createControlledMcpOAuthTokenExchange(options: ControlledMcpOAuthTokenExchangeOptions) {
  const maxResponseBytes = responseLimit(options.maxResponseBytes);
  return new McpOAuthHttpTokenExchange({
    fetch: createControlledMcpFetch({
      resolve: options.resolve,
      fetchPinned: options.fetchPinned,
      ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      maxResponseBytes
    }),
    maxResponseBytes,
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

/** The injected fetch must already enforce the controlled MCP HTTP boundary. */
export class McpOAuthHttpTokenExchange implements McpOAuthTokenExchangePort {
  private readonly maxResponseBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: McpOAuthHttpTokenExchangeOptions) {
    this.maxResponseBytes = responseLimit(options.maxResponseBytes);
    this.now = options.now ?? Date.now;
  }

  async exchangeAuthorizationCode(input: McpOAuthAuthorizationCodeExchangeInput): Promise<McpOAuthTokens> {
    const response = await this.request(input.tokenEndpoint, authorizationCodeBody(input), input.signal);
    if (!response.ok) {
      await discardResponse(response);
      throw stableError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED");
    }
    return decodeTokens(await readBoundedJson(response, this.maxResponseBytes), this.now());
  }

  async refreshAccessToken(input: McpOAuthRefreshExchangeInput): Promise<McpOAuthRefreshExchangeResult> {
    const response = await this.request(input.tokenEndpoint, refreshTokenBody(input), input.signal);
    if (!response.ok) {
      if (response.status === 400) {
        let body: unknown;
        try {
          body = await readBoundedJson(response, this.maxResponseBytes);
        } catch (error) {
          if (isCleanupFailure(error)) throw error;
          body = undefined;
        }
        if (isInvalidGrant(body)) return { status: "invalid_grant" };
      } else {
        await discardResponse(response);
      }
      throw stableError("MCP_OAUTH_TOKEN_REFRESH_FAILED");
    }
    return {
      status: "ok",
      tokens: decodeTokens(await readBoundedJson(response, this.maxResponseBytes), this.now())
    };
  }

  private async request(tokenEndpoint: string, body: URLSearchParams, signal: AbortSignal | undefined) {
    assertSafeMcpHttpEndpoint(tokenEndpoint);
    abortIfRequested(signal);
    try {
      return await this.options.fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body: body.toString(),
        ...(signal === undefined ? {} : { signal })
      });
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw stableError("MCP_OAUTH_TOKEN_REQUEST_FAILED");
    }
  }
}

function authorizationCodeBody(input: McpOAuthAuthorizationCodeExchangeInput) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", boundedInput(input.clientId, 256));
  body.set("code", boundedInput(input.code, 8 * 1024));
  body.set("code_verifier", codeVerifier(input.codeVerifier));
  body.set("redirect_uri", callbackUrl(input.redirectUri));
  body.set("resource", resourceUrl(input.resource));
  return body;
}

function refreshTokenBody(input: McpOAuthRefreshExchangeInput) {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", boundedInput(input.clientId, 256));
  body.set("refresh_token", boundedInput(input.refreshToken, MAX_REFRESH_TOKEN_BYTES));
  body.set("resource", resourceUrl(input.resource));
  return body;
}

function decodeTokens(value: unknown, now: number): McpOAuthTokens {
  if (!isPlainObject(value)) throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  const allowed = new Set(["access_token", "refresh_token", "expires_in", "token_type", "scope"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  }
  const accessToken = token(value.access_token, MAX_ACCESS_TOKEN_BYTES);
  const refreshToken = value.refresh_token === undefined
    ? undefined
    : token(value.refresh_token, MAX_REFRESH_TOKEN_BYTES);
  if (value.token_type !== undefined
    && (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer")) {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  }
  if (value.scope !== undefined
    && (typeof value.scope !== "string" || !boundedText(value.scope, MAX_SCOPE_BYTES))) {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  }
  let expiresAt: number | undefined;
  if (value.expires_in !== undefined) {
    if (!Number.isSafeInteger(value.expires_in) || (value.expires_in as number) < 0 || !Number.isSafeInteger(now)) {
      throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
    }
    const lifetimeMs = (value.expires_in as number) * 1000;
    expiresAt = now + lifetimeMs;
    if (!Number.isSafeInteger(lifetimeMs) || !Number.isSafeInteger(expiresAt)) {
      throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
    }
  }
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    await discardResponse(response);
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        try {
          await cancelReader(reader, stableError("MCP_OAUTH_TOKEN_RESPONSE_TOO_LARGE"));
        } finally {
          chunk.fill(0);
        }
        throw stableError("MCP_OAUTH_TOKEN_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
    const bytes = chunks.length === 1 ? chunks[0]! : combineChunks(chunks, total);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "McpOAuthTokenExchangeError") throw error;
    try {
      await cancelReader(reader, stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID"));
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function discardResponse(response: Response) {
  if (!response.body) return;
  try {
    await response.body.cancel(stableError("MCP_OAUTH_TOKEN_RESPONSE_DISCARDED"));
  } catch {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_CLEANUP_FAILED");
  }
}

function combineChunks(chunks: Uint8Array[], total: number) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: Error) {
  try {
    await reader.cancel(reason);
  } catch {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_CLEANUP_FAILED");
  }
}

function isCleanupFailure(error: unknown) {
  return error instanceof Error && error.message === "MCP_OAUTH_TOKEN_RESPONSE_CLEANUP_FAILED";
}

function isInvalidGrant(value: unknown) {
  if (!isPlainObject(value) || value.error !== "invalid_grant") return false;
  const allowed = new Set(["error", "error_description", "error_uri"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return [value.error_description, value.error_uri]
    .every((item) => item === undefined || (typeof item === "string" && boundedText(item, 4 * 1024)));
}

function token(value: unknown, maximumBytes: number) {
  if (typeof value !== "string" || !boundedText(value, maximumBytes)) {
    throw stableError("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  }
  return value;
}

function boundedText(value: string, maximumBytes: number) {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= maximumBytes;
}

function boundedInput(value: string, maximumBytes: number) {
  if (typeof value !== "string" || value !== value.trim() || !boundedText(value, maximumBytes)) {
    throw stableError("MCP_OAUTH_TOKEN_INPUT_INVALID");
  }
  return value;
}

function codeVerifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) {
    throw stableError("MCP_OAUTH_TOKEN_INPUT_INVALID");
  }
  return value;
}

function callbackUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw stableError("MCP_OAUTH_TOKEN_INPUT_INVALID");
  }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port);
  if (url.protocol !== "http:"
    || (host !== "localhost" && host !== "127.0.0.1")
    || !Number.isSafeInteger(port)
    || port < 49_152
    || port > 65_535
    || url.username
    || url.password
    || url.hash) {
    throw stableError("MCP_OAUTH_TOKEN_INPUT_INVALID");
  }
  return value;
}

function resourceUrl(value: string) {
  assertSafeMcpHttpEndpoint(value);
  return boundedInput(value, 2 * 1024);
}

function responseLimit(value: number | undefined) {
  const result = value ?? DEFAULT_MAX_TOKEN_RESPONSE_BYTES;
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_TOKEN_RESPONSE_BYTES) {
    throw stableError("MCP_OAUTH_TOKEN_CONFIG_INVALID");
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : stableError("MCP_OAUTH_TOKEN_ABORTED");
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpOAuthTokenExchangeError";
  return error;
}
