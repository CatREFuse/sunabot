// @vitest-environment node
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedFileMcpCredentialVault } from "../../adapters/mcp/encryptedCredentialVault.js";
import {
  McpOAuthService,
  type McpOAuthTokenExchangePort
} from "../../adapters/mcp/oauthService.js";

const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/oauth-service";

describe("MCP OAuth service", () => {
  let root = "";
  let now = 1_000_000;
  let vault: EncryptedFileMcpCredentialVault;
  let exchange: {
    exchangeAuthorizationCode: ReturnType<typeof vi.fn<McpOAuthTokenExchangePort["exchangeAuthorizationCode"]>>;
    refreshAccessToken: ReturnType<typeof vi.fn<McpOAuthTokenExchangePort["refreshAccessToken"]>>;
  };
  const binding = {
    agentId: "agent-a",
    serverId: "server-a",
    subject: "account-a",
    resource: "https://mcp.example.test/mcp"
  };
  const beginInput = {
    agentId: "agent-a",
    serverId: "server-a",
    browserSessionId: "browser-a",
    authorizationEndpoint: "https://auth.example.test/authorize",
    tokenEndpoint: "https://auth.example.test/token",
    clientId: "sunabot-client",
    redirectUri: "http://127.0.0.1:53123/oauth/callback",
    resource: "https://mcp.example.test/mcp",
    scopes: ["mcp:tools", "mcp:resources"]
  };

  beforeEach(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
    await fs.chmod(TEST_ROOT, 0o700);
    root = await fs.mkdtemp(path.join(TEST_ROOT, "run-"));
    await fs.chmod(root, 0o700);
    now = 1_000_000;
    vault = new EncryptedFileMcpCredentialVault({
      filePath: path.join(root, "credentials.json"),
      key: Buffer.alloc(32, 0x37),
      now: () => now
    });
    exchange = {
      exchangeAuthorizationCode: vi.fn().mockResolvedValue({
        accessToken: "access-one",
        refreshToken: "refresh-one",
        expiresAt: now + 60_000
      }),
      refreshAccessToken: vi.fn().mockResolvedValue({
        status: "ok",
        tokens: { accessToken: "access-two", refreshToken: "refresh-two", expiresAt: now + 120_000 }
      })
    };
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("binds one-time state, PKCE, localhost callback, and resource audience through completion", async () => {
    const service = createService();
    const started = service.begin(beginInput);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorization.searchParams.get("state")).toBe(started.state);
    expect(authorization.searchParams.get("redirect_uri")).toBe(beginInput.redirectUri);
    expect(authorization.searchParams.get("resource")).toBe(beginInput.resource);
    expect(started.authorizationOrigin).toBe("https://auth.example.test");
    expect(started).not.toHaveProperty("codeVerifier");

    const completed = await service.complete(completeInput(started.state));
    expect(completed).toEqual({ credentialHandle: expect.stringMatching(/^mcpcred_/u), expiresAt: now + 60_000 });
    expect(exchange.exchangeAuthorizationCode).toHaveBeenCalledWith({
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "sunabot-client",
      code: "authorization-code",
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      redirectUri: beginInput.redirectUri,
      resource: beginInput.resource,
      signal: undefined
    });
    await expect(vault.resolve(completed.credentialHandle, binding)).resolves.toMatchObject({ accessToken: "access-one" });
    await expect(service.complete(completeInput(started.state))).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
    expect(exchange.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    { agentId: "agent-b" },
    { serverId: "server-b" },
    { browserSessionId: "browser-b" },
    { redirectUri: "http://127.0.0.1:53124/oauth/callback" },
    { resource: "https://other.example.test/mcp" }
  ])("consumes and rejects state across a mismatched boundary %#", async (mismatch) => {
    const service = createService();
    const started = service.begin(beginInput);
    await expect(service.complete({ ...completeInput(started.state), ...mismatch }))
      .rejects.toThrow("MCP_OAUTH_STATE_INVALID");
    await expect(service.complete(completeInput(started.state))).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
    expect(exchange.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("expires state and never exchanges an expired authorization code", async () => {
    const service = createService();
    const started = service.begin(beginInput);
    now += 10_000;
    await expect(service.complete(completeInput(started.state))).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
    expect(exchange.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:53123/oauth/callback",
    "http://0.0.0.0:53123/oauth/callback",
    "http://mcp.example.test:53123/oauth/callback",
    "http://localhost:43123/oauth/callback",
    "http://localhost/oauth/callback"
  ])("rejects non-local or non-ephemeral callback %s", (redirectUri) => {
    expect(() => createService().begin({ ...beginInput, redirectUri })).toThrow("MCP_OAUTH_CALLBACK_INVALID");
  });

  it.each([
    "https://localhost/authorize",
    "https://auth.local/authorize",
    "https://127.0.0.1/authorize",
    "https://0.0.0.0/authorize",
    "https://10.0.0.1/authorize",
    "https://169.254.169.254/latest",
    "https://192.168.1.1/authorize",
    "https://[::1]/authorize",
    "https://[fc00::1]/authorize",
    "https://[fe80::1]/authorize",
    "https://[2001:db8::1]/authorize"
  ])("rejects a literal private or special browser authorization endpoint %s", (authorizationEndpoint) => {
    expect(() => createService().begin({ ...beginInput, authorizationEndpoint }))
      .toThrow("MCP_OAUTH_AUTHORIZATION_ENDPOINT_INVALID");
  });

  it("returns the exact public authorization origin for explicit admin confirmation", () => {
    const started = createService().begin({
      ...beginInput,
      authorizationEndpoint: "https://93.184.216.34:8443/oauth/authorize?tenant=agent-a"
    });
    expect(started.authorizationOrigin).toBe("https://93.184.216.34:8443");
    expect(new URL(started.authorizationUrl).origin).toBe(started.authorizationOrigin);
  });

  it("consumes state on exchange failure and never exposes exchange error text", async () => {
    const service = createService();
    exchange.exchangeAuthorizationCode.mockRejectedValue(new Error("access-secret /Users/private/token"));
    const started = service.begin(beginInput);
    const failure = service.complete(completeInput(started.state));
    await expect(failure).rejects.toThrow("MCP_OAUTH_EXCHANGE_FAILED");
    await expect(failure).rejects.not.toThrow("access-secret");
    await expect(service.complete(completeInput(started.state))).rejects.toThrow("MCP_OAUTH_STATE_INVALID");
  });

  it("rotates refresh and access tokens atomically while retaining the credential handle", async () => {
    const service = createService();
    const handle = await authorize(service);
    now += 60_000;
    await expect(vault.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_EXPIRED");
    const refreshed = await service.refresh({ credentialHandle: handle, ...binding });
    expect(refreshed).toEqual({ credentialHandle: handle, expiresAt: 1_120_000 });
    expect(exchange.refreshAccessToken).toHaveBeenCalledWith({
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "sunabot-client",
      refreshToken: "refresh-one",
      resource: beginInput.resource,
      signal: undefined
    });
    await expect(vault.resolve(handle, binding)).resolves.toEqual({
      accessToken: "access-two",
      refreshToken: "refresh-two",
      expiresAt: 1_120_000
    });
  });

  it("retains the prior refresh token when the provider rotates only the access token", async () => {
    const service = createService();
    const handle = await authorize(service);
    exchange.refreshAccessToken.mockResolvedValue({
      status: "ok",
      tokens: { accessToken: "access-only", expiresAt: now + 120_000 }
    });
    await service.refresh({ credentialHandle: handle, ...binding });
    await expect(vault.resolve(handle, binding)).resolves.toMatchObject({
      accessToken: "access-only",
      refreshToken: "refresh-one"
    });
  });

  it("single-flights refresh for one exact credential partition", async () => {
    const service = createService();
    const handle = await authorize(service);
    let release!: (value: { status: "ok"; tokens: { accessToken: string } }) => void;
    exchange.refreshAccessToken.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const first = service.refresh({ credentialHandle: handle, ...binding });
    const second = service.refresh({ credentialHandle: handle, ...binding });
    await vi.waitFor(() => expect(exchange.refreshAccessToken).toHaveBeenCalledTimes(1));
    release({ status: "ok", tokens: { accessToken: "single-flight" } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { credentialHandle: handle },
      { credentialHandle: handle }
    ]);
  });

  it.each([
    { agentId: "agent-b" },
    { serverId: "server-b" },
    { subject: "account-b" },
    { resource: "https://other.example.test/mcp" }
  ])("never exchanges a refresh token across partition %#", async (mismatch) => {
    const service = createService();
    const handle = await authorize(service);
    exchange.refreshAccessToken.mockClear();
    await expect(service.refresh({ credentialHandle: handle, ...binding, ...mismatch }))
      .rejects.toThrow("MCP_OAUTH_REFRESH_UNAVAILABLE");
    expect(exchange.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("reports invalid_grant without deleting the credential before the admin binding is disabled", async () => {
    const service = createService();
    const handle = await authorize(service);
    exchange.refreshAccessToken.mockResolvedValue({ status: "invalid_grant" });
    await expect(service.refresh({ credentialHandle: handle, ...binding }))
      .rejects.toThrow("MCP_OAUTH_INVALID_GRANT");
    await expect(vault.resolveForRefresh(handle, binding)).resolves.toMatchObject({
      tokens: { refreshToken: "refresh-one" }
    });
  });

  it("revokes an exactly bound credential and aborts before exchange", async () => {
    const service = createService();
    const handle = await authorize(service);
    const controller = new AbortController();
    controller.abort();
    exchange.refreshAccessToken.mockClear();
    await expect(service.refresh({ credentialHandle: handle, ...binding, signal: controller.signal }))
      .rejects.toThrow("MCP_OAUTH_ABORTED");
    expect(exchange.refreshAccessToken).not.toHaveBeenCalled();
    await service.revoke({ credentialHandle: handle, ...binding });
    await expect(vault.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
  });

  function createService() {
    return new McpOAuthService({ vault, exchange, now: () => now, stateTtlMs: 10_000 });
  }

  function completeInput(state: string) {
    return {
      state,
      code: "authorization-code",
      agentId: beginInput.agentId,
      serverId: beginInput.serverId,
      browserSessionId: beginInput.browserSessionId,
      redirectUri: beginInput.redirectUri,
      resource: beginInput.resource,
      subject: "account-a"
    };
  }

  async function authorize(service: McpOAuthService) {
    const started = service.begin(beginInput);
    return (await service.complete(completeInput(started.state))).credentialHandle;
  }
});
