import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Implementation, ListToolsResult, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { AgentMcpServerDescriptor } from "../../packages/contracts/extensions/agentExtensions.js";
import type {
  McpRequestOptions,
  McpCatalogCommit,
  McpRuntimeCapabilities,
  McpRuntimeClientFactory,
  McpRuntimeClientPort
} from "../../services/extensions/public.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_WORKBENCH_ROOT,
  StrictMcpClientAdapter,
  createStrictMcpClient,
  sanitizeMcpServerInstructions
} from "./clientAdapter.js";
import {
  ClearableMcpHttpAuthorization,
  assertSafeMcpHttpEndpoint,
  createControlledMcpFetch,
  type McpDnsResolver,
  type McpPinnedFetch
} from "./controlledHttp.js";
import { HardenedStdioTransport, type HardenedStdioProcessLauncher } from "./hardenedStdioTransport.js";
import { McpExternalDataSanitizer } from "./externalDataRedaction.js";
import { clearMcpStdioResolvedEnvironment } from "./stdioLaunchPolicy.js";

export interface McpServerSecretResolver {
  resolveEnvironment(input: {
    agentId: string;
    serverId: string;
    keys: readonly string[];
  }): Promise<Record<string, string>>;
  resolveHttpCredential(input: {
    agentId: string;
    serverId: string;
    credentialRef: string;
    resource: string;
    authKind: "bearer" | "oauth";
  }): Promise<{ accessToken: string }>;
}

export interface SdkMcpRuntimeClientFactoryOptions {
  secrets: McpServerSecretResolver;
  stdioLauncher?: HardenedStdioProcessLauncher;
  stdioLauncherFor?: (input: {
    agentId: string;
    server: Extract<AgentMcpServerDescriptor, { transport: "stdio" }>;
    signal: AbortSignal;
  }) => Promise<HardenedStdioProcessLauncher>;
  http?: {
    resolve: McpDnsResolver;
    fetchPinned: McpPinnedFetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxRedirects?: number;
  };
  clientInfo?: Implementation;
}

export class SdkMcpRuntimeClientFactory implements McpRuntimeClientFactory {
  private readonly orphaned = new Map<string, FactoryPreHostOwner>();
  private readonly orphanCleanups = new Map<string, Promise<void>>();
  private readonly scopeTails = new Map<string, Promise<void>>();

  constructor(private readonly options: SdkMcpRuntimeClientFactoryOptions) {}

  async create(input: { agentId: string; server: AgentMcpServerDescriptor; signal: AbortSignal }) {
    const ownerKey = factoryOwnerKey(input.agentId, input.server.id);
    const release = await this.acquireScope(ownerKey);
    try {
      return await this.createWithinScope(input, ownerKey);
    } finally {
      release();
    }
  }

  private async createWithinScope(
    input: { agentId: string; server: AgentMcpServerDescriptor; signal: AbortSignal },
    ownerKey: string
  ) {
    await this.cleanupOrphan(ownerKey);
    if (input.signal.aborted) throw stableError("MCP_CLIENT_CONNECT_ABORTED");
    const prepared = input.server.transport === "stdio"
      ? await this.createStdioTransport(input.agentId, input.server, input.signal)
      : await this.createHttpTransport(input.agentId, input.server);
    const owner = new FactoryPreHostOwner(prepared);
    let sanitizer!: McpExternalDataSanitizer;
    try {
      sanitizer = new McpExternalDataSanitizer(prepared.secrets);
    } catch {
      await this.failBeforeHost(ownerKey, owner, "MCP_CLIENT_SECRET_INVALID");
    } finally {
      prepared.secrets.fill("");
      prepared.secrets.splice(0, prepared.secrets.length);
    }
    owner.setSanitizer(sanitizer);
    let strict: ReturnType<typeof createStrictMcpClient>;
    try {
      strict = createStrictMcpClient(this.options.clientInfo ?? {
        name: "sunabot",
        version: "0.1.0"
      });
    } catch {
      await this.failBeforeHost(ownerKey, owner, "MCP_CLIENT_CONNECT_FAILED");
    }
    const adapter = strict!.adapter;
    owner.setAdapter(adapter);
    try {
      await strict!.connect(prepared.transport, {
        signal: input.signal,
        timeout: 10_000,
        maxTotalTimeout: 30_000,
        resetTimeoutOnProgress: false
      });
    } catch {
      await this.failBeforeHost(ownerKey, owner, "MCP_CLIENT_CONNECT_FAILED");
    }
    const capabilities = strict!.client.getServerCapabilities();
    let instructions;
    try {
      if (prepared.transport instanceof StreamableHTTPClientTransport && prepared.transport.sessionId) {
        sanitizer.addSecrets([prepared.transport.sessionId]);
      }
      const rawInstructions = strict!.client.getInstructions();
      instructions = sanitizeMcpServerInstructions(
        rawInstructions ? sanitizer.sanitizeText(rawInstructions, "output") : undefined
      );
    } catch {
      await this.failBeforeHost(ownerKey, owner, "MCP_CLIENT_INSTRUCTIONS_INVALID");
    }
    return new SdkMcpRuntimeClient({
      adapter,
      capabilities: mapCapabilities(capabilities),
      instructions: instructions?.text,
      sanitizer,
      clearTransportSecrets: prepared.clearSecrets,
      terminateSession: prepared.terminateSession,
      transport: prepared.transport
    });
  }

  private async acquireScope(ownerKey: string) {
    const previous = this.scopeTails.get(ownerKey) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
    this.scopeTails.set(ownerKey, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTail();
      if (this.scopeTails.get(ownerKey) === tail) this.scopeTails.delete(ownerKey);
    };
  }

  async cleanupOrphans(input?: { agentId?: string }) {
    const prefix = input?.agentId === undefined ? undefined : factoryOwnerPrefix(input.agentId);
    const ownerKeys = [...this.orphaned.keys()].filter((ownerKey) => prefix === undefined || ownerKey.startsWith(prefix));
    const settled = await Promise.allSettled(ownerKeys.map((ownerKey) => this.cleanupOrphan(ownerKey)));
    if (settled.some((result) => result.status === "rejected")) {
      throw stableError("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    }
  }

  private async cleanupOrphan(ownerKey: string) {
    const owner = this.orphaned.get(ownerKey);
    if (!owner) return;
    const existing = this.orphanCleanups.get(ownerKey);
    if (existing) return existing;
    const operation = this.disposeOwner(owner).then(() => {
      if (this.orphaned.get(ownerKey) === owner) this.orphaned.delete(ownerKey);
    }).finally(() => {
      if (this.orphanCleanups.get(ownerKey) === operation) this.orphanCleanups.delete(ownerKey);
    });
    this.orphanCleanups.set(ownerKey, operation);
    return operation;
  }

  private async failBeforeHost(ownerKey: string, owner: FactoryPreHostOwner, errorCode: string): Promise<never> {
    try {
      await this.disposeOwner(owner);
    } catch {
      this.orphaned.set(ownerKey, owner);
      throw stableError("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    }
    throw stableError(errorCode);
  }

  private async disposeOwner(owner: FactoryPreHostOwner) {
    const operation = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await owner.dispose();
          return;
        } catch {
          if (attempt === 2) throw stableError("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
        }
      }
    })();
    return factoryCleanupDeadline(operation, FACTORY_CLEANUP_TIMEOUT_MS);
  }

  private async createStdioTransport(
    agentId: string,
    server: Extract<AgentMcpServerDescriptor, { transport: "stdio" }>,
    signal: AbortSignal
  ): Promise<FactoryPreparedTransport> {
    const launcher = this.options.stdioLauncherFor
      ? await this.options.stdioLauncherFor({ agentId, server, signal })
      : this.options.stdioLauncher;
    if (!launcher) throw stableError("MCP_STDIO_LAUNCHER_UNAVAILABLE");
    let env: Record<string, string>;
    try {
      env = await this.options.secrets.resolveEnvironment({
        agentId,
        serverId: server.id,
        keys: [...server.envKeys]
      });
    } catch {
      throw stableError("MCP_STDIO_ENV_UNAVAILABLE");
    }
    try {
      assertExactEnvironment(server.envKeys, env);
      const secrets = Object.values(env);
      return {
        transport: new HardenedStdioTransport({
          command: server.command,
          args: server.args,
          env,
          launcher
        }),
        secrets,
        clearSecrets: undefined
      };
    } finally {
      clearMcpStdioResolvedEnvironment(env);
    }
  }

  private async createHttpTransport(
    agentId: string,
    server: Extract<AgentMcpServerDescriptor, { transport: "streamable_http" }>
  ): Promise<FactoryPreparedTransport> {
    if (!this.options.http) throw stableError("MCP_HTTP_TRANSPORT_UNAVAILABLE");
    const url = assertSafeMcpHttpEndpoint(server.url);
    let accessToken: string | undefined;
    if (server.auth.kind !== "none") {
      let credential: { accessToken: string };
      try {
        credential = await this.options.secrets.resolveHttpCredential({
          agentId,
          serverId: server.id,
          credentialRef: server.auth.credentialRef,
          resource: url.toString(),
          authKind: server.auth.kind
        });
      } catch {
        throw stableError("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
      }
      const resolvedAccessToken = credential.accessToken;
      credential.accessToken = "";
      if (typeof resolvedAccessToken !== "string" || !resolvedAccessToken || resolvedAccessToken.includes("\0") ||
          Buffer.byteLength(resolvedAccessToken) > 16 * 1024) {
        throw stableError("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
      }
      accessToken = resolvedAccessToken;
    }
    const controlledFetch = createControlledMcpFetch({
      resolve: this.options.http.resolve,
      fetchPinned: this.options.http.fetchPinned,
      timeoutMs: this.options.http.timeoutMs,
      maxResponseBytes: this.options.http.maxResponseBytes,
      maxRedirects: this.options.http.maxRedirects
    });
    const authorization = accessToken ? new ClearableMcpHttpAuthorization(accessToken) : undefined;
    const fetch = authorization ? authorization.authorizedFetch(controlledFetch) : controlledFetch;
    const transport = new StreamableHTTPClientTransport(url, { fetch });
    return {
      transport,
      secrets: accessToken ? [accessToken] : [],
      clearSecrets: authorization ? () => authorization.clear() : undefined,
      terminateSession: async () => {
        const sessionId = transport.sessionId;
        if (!sessionId) return;
        const response = await fetch(url, {
          method: "DELETE",
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "mcp-session-id": sessionId
          }
        });
        await response.body?.cancel();
        if (!response.ok && response.status !== 405) throw stableError("MCP_HTTP_SESSION_TERMINATION_FAILED");
      }
    };
  }
}

const FACTORY_CLEANUP_TIMEOUT_MS = 10_000;
const FACTORY_CLEANUP_STEP_TIMEOUT_MS = 2_000;

interface FactoryPreparedTransport {
  transport: HardenedStdioTransport | StreamableHTTPClientTransport;
  secrets: string[];
  clearSecrets?: () => void;
  terminateSession?: () => Promise<void>;
}

class FactoryPreHostOwner {
  private sanitizer?: McpExternalDataSanitizer;
  private adapter?: StrictMcpClientAdapter;
  private cleanupAttempt?: Promise<void>;
  private readonly sessionCleanup = new TrackedCleanupStep();
  private readonly adapterCleanup = new TrackedCleanupStep();
  private readonly transportCleanup = new TrackedCleanupStep();
  private readonly projectionCleanup = new TrackedCleanupStep();
  private readonly secretCleanup = new TrackedCleanupStep();

  constructor(private readonly prepared: FactoryPreparedTransport) {}

  setSanitizer(sanitizer: McpExternalDataSanitizer) {
    this.sanitizer = sanitizer;
  }

  setAdapter(adapter: StrictMcpClientAdapter) {
    this.adapter = adapter;
  }

  async dispose() {
    if (this.cleanupAttempt) return this.cleanupAttempt;
    const operation = this.disposeOnce().finally(() => {
      if (this.cleanupAttempt === operation) this.cleanupAttempt = undefined;
    });
    this.cleanupAttempt = operation;
    return operation;
  }

  private async disposeOnce() {
    const outcomes: PromiseSettledResult<void>[] = [];
    if (this.prepared.terminateSession) {
      outcomes.push(await settleCleanup(this.sessionCleanup.run(this.prepared.terminateSession)));
    } else {
      this.sessionCleanup.markCompleted();
    }
    const adapterOutcome = this.adapter
      ? await settleCleanup(this.adapterCleanup.run(() => this.adapter!.close()))
      : settledCleanup();
    outcomes.push(adapterOutcome);
    if (!this.adapter) this.adapterCleanup.markCompleted();
    if (this.adapter && adapterOutcome.status === "fulfilled") {
      this.transportCleanup.markCompleted();
    } else {
      outcomes.push(await settleCleanup(this.transportCleanup.run(() => this.prepared.transport.close())));
    }
    outcomes.push(await settleCleanup(this.projectionCleanup.run(async () => {
      this.sanitizer?.clear();
    })));
    outcomes.push(await settleCleanup(this.secretCleanup.run(async () => {
      this.prepared.clearSecrets?.();
    })));
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      throw stableError("MCP_CLIENT_FACTORY_CLEANUP_FAILED");
    }
  }
}

class TrackedCleanupStep {
  private completed = false;
  private inFlight?: Promise<void>;

  markCompleted() {
    this.completed = true;
  }

  run(operation: () => Promise<void>) {
    if (this.completed) return Promise.resolve();
    if (!this.inFlight) {
      let tracked!: Promise<void>;
      tracked = Promise.resolve().then(operation).then(() => {
        this.completed = true;
      }).finally(() => {
        if (this.inFlight === tracked) this.inFlight = undefined;
      });
      this.inFlight = tracked;
    }
    return factoryCleanupDeadline(this.inFlight, FACTORY_CLEANUP_STEP_TIMEOUT_MS);
  }
}

async function settleCleanup(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation;
    return settledCleanup();
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function settledCleanup(): PromiseFulfilledResult<void> {
  return { status: "fulfilled", value: undefined };
}

class SdkMcpRuntimeClient implements McpRuntimeClientPort {
  readonly protocolVersion = MCP_PROTOCOL_VERSION;
  readonly capabilities: McpRuntimeCapabilities;
  readonly instructions?: string;
  private removeInvalidationHandler?: () => void;
  private removeResourceUpdatedHandler?: () => void;
  private committedCatalogGeneration = 0;
  private closed = false;
  private closing?: Promise<void>;
  private readonly sessionCleanup = new TrackedCleanupStep();
  private readonly adapterCleanup = new TrackedCleanupStep();
  private readonly transportCleanup = new TrackedCleanupStep();
  private readonly projectionCleanup = new TrackedCleanupStep();
  private readonly secretCleanup = new TrackedCleanupStep();

  constructor(private readonly options: {
    adapter: StrictMcpClientAdapter;
    capabilities: McpRuntimeCapabilities;
    instructions?: string;
    sanitizer: McpExternalDataSanitizer;
    clearTransportSecrets?: () => void;
    terminateSession?: () => Promise<void>;
    transport: FactoryPreparedTransport["transport"];
  }) {
    this.capabilities = options.capabilities;
    this.instructions = options.instructions;
  }

  async listTools(cursor: string | undefined, options: McpRequestOptions) {
    try {
      const result = await this.options.adapter.listTools(
        cursor ? { cursor } : undefined,
        options.signal,
        requestLimits(options)
      );
      const page = this.options.sanitizer.sanitize({
        items: result.tools as Record<string, unknown>[],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
      }, "catalog");
      return page;
    } catch (error) {
      throw externalError(error, "MCP_TOOL_CATALOG_FAILED");
    }
  }

  async listResources(cursor: string | undefined, options: McpRequestOptions) {
    try {
      const result = await this.options.adapter.listResources(
        cursor ? { cursor } : undefined,
        options.signal,
        requestLimits(options)
      );
      const page = this.sanitizeCatalog({
        items: result.resources as Record<string, unknown>[],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
      });
      return page;
    } catch (error) {
      throw error;
    }
  }

  async listResourceTemplates(cursor: string | undefined, options: McpRequestOptions) {
    try {
      const result = await this.options.adapter.listResourceTemplates(
        cursor ? { cursor } : undefined,
        options.signal,
        requestLimits(options)
      );
      const page = this.sanitizeCatalog({
        items: result.resourceTemplates as Record<string, unknown>[],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
      });
      return page;
    } catch (error) {
      throw error;
    }
  }

  async listPrompts(cursor: string | undefined, options: McpRequestOptions) {
    try {
      const result = await this.options.adapter.listPrompts(
        cursor ? { cursor } : undefined,
        options.signal,
        requestLimits(options)
      );
      const page = this.sanitizeCatalog({
        items: result.prompts as Record<string, unknown>[],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
      });
      return page;
    } catch (error) {
      throw error;
    }
  }

  commitCatalog(input: McpCatalogCommit) {
    if (this.closed || this.closing || input.generation !== this.committedCatalogGeneration + 1) {
      throw stableError("MCP_CATALOG_GENERATION_STALE");
    }
    this.options.adapter.publishToolCatalog(input.snapshot.tools as ListToolsResult["tools"]);
    this.committedCatalogGeneration = input.generation;
  }

  async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions) {
    return this.sanitizeOutput(
      await this.safeRequest(
        () => this.options.adapter.callTool({ name, arguments: args }, options.signal, requestLimits(options)),
        "MCP_TOOL_CALL_FAILED"
      )
    );
  }

  async readResource(uri: string, options: McpRequestOptions) {
    return this.sanitizeOutput(await this.safeRequest(
      () => this.options.adapter.readResource({ uri }, options.signal, requestLimits(options)),
      "MCP_RESOURCE_READ_FAILED"
    ));
  }

  async subscribeResource(uri: string, options: McpRequestOptions) {
    return this.sanitizeOutput(await this.safeRequest(
      () => this.options.adapter.subscribeResource({ uri }, options.signal, requestLimits(options)),
      "MCP_RESOURCE_SUBSCRIBE_FAILED"
    ));
  }

  async unsubscribeResource(uri: string, options: McpRequestOptions) {
    return this.sanitizeOutput(await this.safeRequest(
      () => this.options.adapter.unsubscribeResource({ uri }, options.signal, requestLimits(options)),
      "MCP_RESOURCE_UNSUBSCRIBE_FAILED"
    ));
  }

  async getPrompt(name: string, args: Record<string, string>, options: McpRequestOptions) {
    return this.sanitizeOutput(await this.safeRequest(() => this.options.adapter.getPrompt({ name, arguments: args }, {
      explicitUserSelection: true,
      signal: options.signal,
      limits: requestLimits(options)
    }), "MCP_PROMPT_GET_FAILED"));
  }

  setListChangedHandler(handler: () => void) {
    this.removeInvalidationHandler?.();
    this.removeInvalidationHandler = this.options.adapter.onCatalogInvalidated(handler);
  }

  setResourceUpdatedHandler(handler: (uri: string) => void) {
    this.removeResourceUpdatedHandler?.();
    this.removeResourceUpdatedHandler = this.options.adapter.onResourceUpdated(handler);
  }

  setRootsHandler(handler: () => { roots: Array<{ uri: string; name: string }> }) {
    const roots = handler().roots;
    if (roots.length !== 1 || roots[0]?.uri !== MCP_WORKBENCH_ROOT) throw stableError("MCP_ROOTS_INVALID");
  }

  setLifecycleHandler(handler: (event: { unexpected: boolean }) => void) {
    this.options.adapter.onLifecycle(handler);
  }

  async close() {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.removeInvalidationHandler?.();
    this.removeResourceUpdatedHandler?.();
    const operation = (async () => {
      const outcomes: PromiseSettledResult<void>[] = [];
      if (this.options.terminateSession) {
        outcomes.push(await settleCleanup(this.sessionCleanup.run(this.options.terminateSession)));
      } else {
        this.sessionCleanup.markCompleted();
      }
      const adapterOutcome = await settleCleanup(this.adapterCleanup.run(() => this.options.adapter.close()));
      outcomes.push(adapterOutcome);
      if (adapterOutcome.status === "fulfilled") {
        this.transportCleanup.markCompleted();
      } else {
        outcomes.push(await settleCleanup(this.transportCleanup.run(() => this.options.transport.close())));
      }
      outcomes.push(await settleCleanup(this.projectionCleanup.run(async () => {
        this.options.sanitizer.clear();
      })));
      outcomes.push(await settleCleanup(this.secretCleanup.run(async () => {
        this.options.clearTransportSecrets?.();
      })));
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        throw stableError("MCP_CLIENT_CLEANUP_FAILED");
      }
      this.closed = true;
    })().finally(() => {
      if (this.closing === operation) this.closing = undefined;
    });
    this.closing = operation;
    return operation;
  }

  private sanitizeCatalog<T>(value: T): T {
    try {
      return this.options.sanitizer.sanitize(value, "catalog");
    } catch (error) {
      throw externalError(error, "MCP_CATALOG_UNSAFE");
    }
  }

  private sanitizeOutput<T>(value: T): T {
    try {
      return this.options.sanitizer.sanitize(value, "output");
    } catch (error) {
      throw externalError(error, "MCP_RESULT_INVALID");
    }
  }

  private async safeRequest<T>(operation: () => Promise<T>, code: string) {
    if (this.closed || this.closing) throw stableError("MCP_CLIENT_CLOSED");
    try {
      return await operation();
    } catch (error) {
      throw externalError(error, code);
    }
  }

}

function mapCapabilities(capabilities: ServerCapabilities | undefined): McpRuntimeCapabilities {
  const raw = capabilities as (ServerCapabilities & Record<string, unknown>) | undefined;
  const mapped: McpRuntimeCapabilities & { resourceSubscriptions: boolean } = {
    tools: Boolean(capabilities?.tools),
    resources: Boolean(capabilities?.resources),
    resourceSubscriptions: Boolean(capabilities?.resources?.subscribe),
    prompts: Boolean(capabilities?.prompts),
    logging: Boolean(capabilities?.logging),
    experimental: capabilities?.experimental ?? capabilities?.extensions,
    sampling: raw?.sampling,
    elicitation: raw?.elicitation,
    tasks: capabilities?.tasks
  };
  return mapped;
}

function requestLimits(options: McpRequestOptions) {
  if (options.resetTimeoutOnProgress !== false) throw stableError("MCP_REQUEST_OPTIONS_REQUIRED");
  return { timeout: options.timeout, maxTotalTimeout: options.maxTotalTimeout };
}

function assertExactEnvironment(expectedKeys: readonly string[], env: Record<string, string>) {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(env).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw stableError("MCP_STDIO_ENV_UNAVAILABLE");
  }
  for (const value of Object.values(env)) {
    if (typeof value !== "string") throw stableError("MCP_STDIO_ENV_UNAVAILABLE");
  }
}

function factoryOwnerKey(agentId: string, serverId: string) {
  if (!agentId || !serverId || agentId.includes("\0") || serverId.includes("\0")) {
    throw stableError("MCP_CLIENT_SCOPE_INVALID");
  }
  return `${agentId}\0${serverId}`;
}

function factoryOwnerPrefix(agentId: string) {
  if (!agentId || agentId.includes("\0")) throw stableError("MCP_CLIENT_SCOPE_INVALID");
  return `${agentId}\0`;
}

function factoryCleanupDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(stableError("MCP_CLIENT_FACTORY_CLEANUP_FAILED")), timeoutMs);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}

function externalError(error: unknown, fallback: string) {
  return error instanceof Error && error.name === "McpAdapterError" ? error : stableError(fallback);
}
