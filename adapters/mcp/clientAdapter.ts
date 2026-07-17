import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  MCP_PROTOCOL_VERSION as CONTRACT_MCP_PROTOCOL_VERSION,
  MCP_VIRTUAL_WORKBENCH_ROOT
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import {
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  CallToolResultSchema,
  type GetPromptRequest,
  type GetPromptResult,
  type Implementation,
  type JSONRPCMessage,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ServerCapabilities,
  type SubscribeRequest,
  type UnsubscribeRequest
} from "@modelcontextprotocol/sdk/types.js";

export const MCP_PROTOCOL_VERSION = CONTRACT_MCP_PROTOCOL_VERSION;
export const MCP_WORKBENCH_ROOT = MCP_VIRTUAL_WORKBENCH_ROOT;

export interface McpSdkClientPort {
  onclose?: () => void;
  listTools(params?: { cursor?: string }, options?: RequestOptions): Promise<ListToolsResult>;
  listResources(params?: { cursor?: string }, options?: RequestOptions): Promise<ListResourcesResult>;
  listResourceTemplates(params?: { cursor?: string }, options?: RequestOptions): Promise<ListResourceTemplatesResult>;
  listPrompts(params?: { cursor?: string }, options?: RequestOptions): Promise<ListPromptsResult>;
  readResource(params: ReadResourceRequest["params"], options?: RequestOptions): Promise<ReadResourceResult>;
  subscribeResource(params: SubscribeRequest["params"], options?: RequestOptions): Promise<unknown>;
  unsubscribeResource(params: UnsubscribeRequest["params"], options?: RequestOptions): Promise<unknown>;
  getPrompt(params: GetPromptRequest["params"], options?: RequestOptions): Promise<GetPromptResult>;
  callTool(params: CallToolRequest["params"], resultSchema: undefined, options?: RequestOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpCatalogLimits {
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  maxJsonDepth?: number;
}

export interface McpCatalogSnapshot {
  tools: ListToolsResult["tools"];
  resources: ListResourcesResult["resources"];
  resourceTemplates: ListResourceTemplatesResult["resourceTemplates"];
  prompts: ListPromptsResult["prompts"];
}

export interface StrictMcpClientAdapterOptions {
  requestTimeoutMs?: number;
  maxTotalTimeoutMs?: number;
  catalogLimits?: Partial<McpCatalogLimits>;
  callToolRequest?: (
    params: CallToolRequest["params"],
    options: RequestOptions
  ) => Promise<unknown>;
}

export interface McpRequestLimits {
  timeout: number;
  maxTotalTimeout: number;
}

export interface SanitizedMcpInstructions {
  text: string;
  trust: "external";
  truncated: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_LIMITS: McpCatalogLimits = {
  maxPages: 16,
  maxItems: 1_000,
  maxBytes: 1024 * 1024,
  maxJsonDepth: 20
};

export function createStrictMcpClient(clientInfo: Implementation) {
  const client = new Client(clientInfo, {
    enforceStrictCapabilities: true,
    capabilities: { roots: {} }
  });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: MCP_WORKBENCH_ROOT, name: "workbench" }]
  }));
  const adapter = new StrictMcpClientAdapter(client, {
    callToolRequest: (params, options) => client.request(
      { method: "tools/call", params },
      CallToolResultSchema,
      options
    )
  });
  client.onclose = () => adapter.notifyConnectionClosed();
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => adapter.notifyListChanged("tools"));
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => adapter.notifyListChanged("resources"));
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    adapter.notifyResourceUpdated(notification.params.uri);
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => adapter.notifyListChanged("prompts"));
  return {
    client,
    adapter,
    async connect(transport: Transport, options: RequestOptions) {
      assertExplicitRequestOptions(options);
      const pinned = new ProtocolPinnedTransport(transport);
      await client.connect(pinned, options);
      adapter.setNegotiatedCapabilities(client.getServerCapabilities());
      return adapter;
    }
  };
}

export class StrictMcpClientAdapter {
  private readonly requestTimeoutMs: number;
  private readonly maxTotalTimeoutMs: number;
  private readonly callToolRequest: (params: CallToolRequest["params"], options: RequestOptions) => Promise<unknown>;
  private readonly catalogLimits: McpCatalogLimits;
  private lifecycle = new AbortController();
  private generation = 0;
  private snapshot?: McpCatalogSnapshot;
  private stale = false;
  private closed = false;
  private closing?: Promise<void>;
  private closeRequested = false;
  private connectionClosed = false;
  private toolCatalogReady = false;
  private resourceSubscriptions = false;
  private readonly negotiatedCatalog = { tools: false, resources: false, prompts: false };
  private readonly negotiatedListChanged = { tools: false, resources: false, prompts: false };
  private readonly invalidationHandlers = new Set<() => void>();
  private readonly resourceUpdatedHandlers = new Set<(uri: string) => void>();
  private readonly lifecycleHandlers = new Set<(event: { unexpected: boolean }) => void>();
  private readonly schemaValidator = new AjvJsonSchemaValidator();
  private toolInputValidators = new Map<string, JsonSchemaValidator<unknown>>();
  private toolOutputValidators = new Map<string, JsonSchemaValidator<unknown>>();

  constructor(private readonly client: McpSdkClientPort, options: StrictMcpClientAdapterOptions = {}) {
    this.requestTimeoutMs = boundedPositiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 5 * 60_000);
    this.maxTotalTimeoutMs = boundedPositiveInteger(options.maxTotalTimeoutMs, DEFAULT_MAX_TOTAL_TIMEOUT_MS, 15 * 60_000);
    this.callToolRequest = options.callToolRequest ?? ((params, requestOptions) =>
      this.client.callTool(params, undefined, requestOptions));
    if (this.maxTotalTimeoutMs < this.requestTimeoutMs) throw stableError("MCP_CLIENT_CONFIG_INVALID");
    this.catalogLimits = {
      maxPages: boundedPositiveInteger(options.catalogLimits?.maxPages, DEFAULT_CATALOG_LIMITS.maxPages, 128),
      maxItems: boundedPositiveInteger(options.catalogLimits?.maxItems, DEFAULT_CATALOG_LIMITS.maxItems, 10_000),
      maxBytes: boundedPositiveInteger(options.catalogLimits?.maxBytes, DEFAULT_CATALOG_LIMITS.maxBytes, 16 * 1024 * 1024),
      maxJsonDepth: boundedPositiveInteger(options.catalogLimits?.maxJsonDepth, DEFAULT_CATALOG_LIMITS.maxJsonDepth ?? 20, 64)
    };
  }

  listTools(params?: { cursor?: string }, signal?: AbortSignal, limits?: McpRequestLimits) {
    return this.request((options) => this.client.listTools(params, options), signal, limits);
  }

  listResources(params?: { cursor?: string }, signal?: AbortSignal, limits?: McpRequestLimits) {
    return this.request((options) => this.client.listResources(params, options), signal, limits);
  }

  listResourceTemplates(params?: { cursor?: string }, signal?: AbortSignal, limits?: McpRequestLimits) {
    return this.request((options) => this.client.listResourceTemplates(params, options), signal, limits);
  }

  listPrompts(params?: { cursor?: string }, signal?: AbortSignal, limits?: McpRequestLimits) {
    return this.request((options) => this.client.listPrompts(params, options), signal, limits);
  }

  async readResource(params: ReadResourceRequest["params"], signal?: AbortSignal, limits?: McpRequestLimits) {
    assertSafeResourceUri(params.uri);
    return this.request((options) => this.client.readResource(params, options), signal, limits);
  }

  async subscribeResource(params: SubscribeRequest["params"], signal?: AbortSignal, limits?: McpRequestLimits) {
    if (!this.resourceSubscriptions) throw stableError("MCP_RESOURCE_SUBSCRIPTIONS_UNAVAILABLE");
    assertSafeResourceUri(params.uri);
    return this.request((options) => this.client.subscribeResource(params, options), signal, limits);
  }

  async unsubscribeResource(params: UnsubscribeRequest["params"], signal?: AbortSignal, limits?: McpRequestLimits) {
    if (!this.resourceSubscriptions) throw stableError("MCP_RESOURCE_SUBSCRIPTIONS_UNAVAILABLE");
    assertSafeResourceUri(params.uri);
    return this.request((options) => this.client.unsubscribeResource(params, options), signal, limits);
  }

  callTool(params: CallToolRequest["params"], signal?: AbortSignal, limits?: McpRequestLimits) {
    return this.callValidatedTool(params, signal, limits);
  }

  async getPrompt(
    params: GetPromptRequest["params"],
    options: { explicitUserSelection: boolean; signal?: AbortSignal; limits?: McpRequestLimits }
  ) {
    if (!options.explicitUserSelection) throw stableError("MCP_PROMPT_EXPLICIT_SELECTION_REQUIRED");
    return this.request((requestOptions) => this.client.getPrompt(params, requestOptions), options.signal, options.limits);
  }

  async refreshCatalog(signal?: AbortSignal) {
    const next: McpCatalogSnapshot = {
      tools: this.negotiatedCatalog.tools
        ? await this.paginate("tools", (cursor) => this.listTools(cursor ? { cursor } : undefined, signal))
        : [],
      resources: this.negotiatedCatalog.resources
        ? await this.paginate("resources", (cursor) => this.listResources(cursor ? { cursor } : undefined, signal))
        : [],
      resourceTemplates: this.negotiatedCatalog.resources
        ? await this.paginate("resourceTemplates", (cursor) => this.listResourceTemplates(cursor ? { cursor } : undefined, signal))
        : [],
      prompts: this.negotiatedCatalog.prompts
        ? await this.paginate("prompts", (cursor) => this.listPrompts(cursor ? { cursor } : undefined, signal))
        : []
    };
    const validators = this.compileToolValidators(next.tools);
    this.snapshot = next;
    this.toolInputValidators = validators.input;
    this.toolOutputValidators = validators.output;
    this.toolCatalogReady = true;
    this.stale = false;
    return cloneSnapshot(next);
  }

  async refreshResources(signal?: AbortSignal) {
    const resources = this.negotiatedCatalog.resources
      ? await this.paginate("resources", (cursor) => this.listResources(cursor ? { cursor } : undefined, signal))
      : [];
    if (this.snapshot) this.snapshot = { ...this.snapshot, resources };
    return structuredClone(resources);
  }

  catalogSnapshot() {
    return this.snapshot ? cloneSnapshot(this.snapshot) : undefined;
  }

  catalogStale() {
    return this.stale;
  }

  invalidateCatalog() {
    this.stale = true;
    this.toolCatalogReady = false;
    for (const handler of this.invalidationHandlers) {
      try { handler(); } catch { /* notification input cannot escape the adapter */ }
    }
  }

  notifyListChanged(kind: "tools" | "resources" | "prompts") {
    if (!this.negotiatedListChanged[kind]) return;
    this.invalidateCatalog();
  }

  onCatalogInvalidated(handler: () => void) {
    this.invalidationHandlers.add(handler);
    return () => this.invalidationHandlers.delete(handler);
  }

  onResourceUpdated(handler: (uri: string) => void) {
    this.resourceUpdatedHandlers.add(handler);
    return () => this.resourceUpdatedHandlers.delete(handler);
  }

  onLifecycle(handler: (event: { unexpected: boolean }) => void) {
    this.lifecycleHandlers.add(handler);
    return () => this.lifecycleHandlers.delete(handler);
  }

  notifyConnectionClosed() {
    if (this.connectionClosed) return;
    this.connectionClosed = true;
    const unexpected = !this.closeRequested;
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort(stableError("MCP_CLIENT_CLOSED"));
    this.generation += 1;
    this.snapshot = undefined;
    this.toolInputValidators.clear();
    this.toolOutputValidators.clear();
    this.toolCatalogReady = false;
    this.stale = true;
    for (const handler of this.lifecycleHandlers) {
      try { handler({ unexpected }); } catch { /* lifecycle invalidation remains fail closed */ }
    }
  }

  notifyResourceUpdated(uri: string) {
    if (!this.resourceSubscriptions) return;
    assertSafeResourceUri(uri);
    if (Buffer.byteLength(uri, "utf8") > 8_192) throw stableError("MCP_RESOURCE_URI_FORBIDDEN");
    for (const handler of this.resourceUpdatedHandlers) {
      try { handler(uri); } catch { /* notification input cannot escape the adapter */ }
    }
  }

  publishToolCatalog(tools: ListToolsResult["tools"]) {
    const validators = this.compileToolValidators(tools);
    this.toolInputValidators = validators.input;
    this.toolOutputValidators = validators.output;
    this.toolCatalogReady = true;
    this.stale = false;
  }

  setNegotiatedCapabilities(capabilities: ServerCapabilities | undefined) {
    this.negotiatedCatalog.tools = capabilities?.tools !== undefined;
    this.negotiatedCatalog.resources = capabilities?.resources !== undefined;
    this.negotiatedCatalog.prompts = capabilities?.prompts !== undefined;
    this.resourceSubscriptions = capabilities?.resources?.subscribe === true;
    this.negotiatedListChanged.tools = capabilities?.tools?.listChanged === true;
    this.negotiatedListChanged.resources = capabilities?.resources?.listChanged === true;
    this.negotiatedListChanged.prompts = capabilities?.prompts?.listChanged === true;
  }

  async close() {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closeRequested = true;
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort(stableError("MCP_CLIENT_CLOSED"));
    this.generation += 1;
    this.snapshot = undefined;
    this.toolInputValidators.clear();
    this.toolOutputValidators.clear();
    this.toolCatalogReady = false;
    this.invalidationHandlers.clear();
    this.resourceUpdatedHandlers.clear();
    this.lifecycleHandlers.clear();
    this.stale = true;
    const operation = this.client.close().then(() => {
      this.closed = true;
    }).catch(() => {
      throw stableError("MCP_CLIENT_CLEANUP_FAILED");
    }).finally(() => {
      if (this.closing === operation) this.closing = undefined;
    });
    this.closing = operation;
    return operation;
  }

  private async request<T>(
    operation: (options: RequestOptions) => Promise<T>,
    callerSignal?: AbortSignal,
    limits?: McpRequestLimits
  ) {
    if (this.closed || this.closing || this.lifecycle.signal.aborted) throw stableError("MCP_CLIENT_CLOSED");
    const requestGeneration = this.generation;
    const merged = mergeSignals(this.lifecycle.signal, callerSignal);
    const requestLimits = resolveRequestLimits(limits, this.requestTimeoutMs, this.maxTotalTimeoutMs);
    try {
      const result = await operation({
        signal: merged.signal,
        timeout: requestLimits.timeout,
        maxTotalTimeout: requestLimits.maxTotalTimeout,
        resetTimeoutOnProgress: false
      });
      if (requestGeneration !== this.generation || this.lifecycle.signal.aborted) {
        throw stableError("MCP_REQUEST_STALE");
      }
      if (callerSignal?.aborted) throw abortReason(callerSignal);
      return result;
    } finally {
      merged.dispose();
    }
  }

  private async callValidatedTool(params: CallToolRequest["params"], signal?: AbortSignal, limits?: McpRequestLimits) {
    if (!this.toolCatalogReady || this.stale) throw stableError("MCP_TOOL_CATALOG_REQUIRED");
    const inputValidator = this.toolInputValidators.get(params.name);
    if (!inputValidator) throw stableError("MCP_TOOL_UNAVAILABLE");
    const inputResult = inputValidator(params.arguments ?? {});
    if (!inputResult.valid) throw stableError("MCP_TOOL_INPUT_INVALID");
    const result = await this.request((options) => this.callToolRequest(params, options), signal, limits);
    assertBoundedResult(result, this.catalogLimits.maxBytes, this.catalogLimits.maxJsonDepth ?? 20);
    const outputValidator = this.toolOutputValidators.get(params.name);
    if (!outputValidator) return result;
    const record = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
    if (record?.isError === true) return result;
    if (!("structuredContent" in (record ?? {}))) throw stableError("MCP_TOOL_OUTPUT_INVALID");
    const outputResult = outputValidator(record?.structuredContent);
    if (!outputResult.valid) throw stableError("MCP_TOOL_OUTPUT_INVALID");
    return result;
  }

  private compileToolValidators(tools: ListToolsResult["tools"]) {
    const input = new Map<string, JsonSchemaValidator<unknown>>();
    const output = new Map<string, JsonSchemaValidator<unknown>>();
    try {
      for (const tool of tools) {
        input.set(tool.name, this.schemaValidator.getValidator(tool.inputSchema));
        if (tool.outputSchema) output.set(tool.name, this.schemaValidator.getValidator(tool.outputSchema));
      }
    } catch {
      throw stableError("MCP_TOOL_SCHEMA_INVALID");
    }
    return { input, output };
  }

  private async paginate<K extends keyof McpCatalogSnapshot>(
    kind: K,
    loadPage: (cursor?: string) => Promise<PageFor<K>>
  ): Promise<McpCatalogSnapshot[K]> {
    const items: unknown[] = [];
    const keys = new Set<string>();
    const cursors = new Set<string>();
    let totalBytes = 0;
    let cursor: string | undefined;
    for (let page = 0; page < this.catalogLimits.maxPages; page += 1) {
      const result = await loadPage(cursor);
      const pageItems = extractItems(kind, result);
      for (const item of pageItems) {
        assertJsonDepth(item, this.catalogLimits.maxJsonDepth ?? 20);
        const key = itemKey(kind, item);
        if (keys.has(key)) throw stableError("MCP_CATALOG_DUPLICATE_ITEM");
        keys.add(key);
        items.push(item);
        totalBytes += Buffer.byteLength(JSON.stringify(item));
        if (items.length > this.catalogLimits.maxItems || totalBytes > this.catalogLimits.maxBytes) {
          throw stableError("MCP_CATALOG_LIMIT_EXCEEDED");
        }
      }
      const nextCursor = result.nextCursor;
      if (!nextCursor) return items as McpCatalogSnapshot[K];
      if (cursors.has(nextCursor)) throw stableError("MCP_CATALOG_CURSOR_LOOP");
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw stableError("MCP_CATALOG_LIMIT_EXCEEDED");
  }
}

type PageFor<K extends keyof McpCatalogSnapshot> = K extends "tools" ? ListToolsResult
  : K extends "resources" ? ListResourcesResult
    : K extends "resourceTemplates" ? ListResourceTemplatesResult
      : ListPromptsResult;

class ProtocolPinnedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private initializeId?: string | number;

  constructor(private readonly inner: Transport) {}

  async start() {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => this.receive(message);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    let outgoing = message;
    if ("method" in message && message.method === "initialize" && "id" in message) {
      this.initializeId = message.id;
      const params = typeof message.params === "object" && message.params ? message.params : {};
      outgoing = {
        ...message,
        params: { ...params, protocolVersion: MCP_PROTOCOL_VERSION }
      } as JSONRPCMessage;
    }
    await this.inner.send(outgoing, options);
  }

  async close() {
    await this.inner.close();
  }

  setProtocolVersion(version: string) {
    if (version !== MCP_PROTOCOL_VERSION) throw stableError("MCP_PROTOCOL_VERSION_UNSUPPORTED");
    this.inner.setProtocolVersion?.(version);
  }

  private receive(message: JSONRPCMessage) {
    if (this.initializeId !== undefined && "id" in message && message.id === this.initializeId) {
      this.initializeId = undefined;
      if (!("result" in message)) {
        this.onmessage?.(message);
        return;
      }
      const result = message.result;
      const version = typeof result === "object" && result && "protocolVersion" in result
        ? (result as { protocolVersion?: unknown }).protocolVersion
        : undefined;
      if (version !== MCP_PROTOCOL_VERSION) {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "MCP_PROTOCOL_VERSION_UNSUPPORTED" }
        });
        return;
      }
    }
    this.onmessage?.(message);
  }
}

function extractItems<K extends keyof McpCatalogSnapshot>(kind: K, result: PageFor<K>): unknown[] {
  if (kind === "tools") return (result as ListToolsResult).tools;
  if (kind === "resources") return (result as ListResourcesResult).resources;
  if (kind === "resourceTemplates") return (result as ListResourceTemplatesResult).resourceTemplates;
  return (result as ListPromptsResult).prompts;
}

function itemKey(kind: keyof McpCatalogSnapshot, item: unknown) {
  if (!item || typeof item !== "object") throw stableError("MCP_CATALOG_ITEM_INVALID");
  const record = item as Record<string, unknown>;
  const key = kind === "resources" ? record.uri : kind === "resourceTemplates" ? record.uriTemplate : record.name;
  if (typeof key !== "string" || !key || Buffer.byteLength(key) > 2_048) throw stableError("MCP_CATALOG_ITEM_INVALID");
  return key;
}

function assertJsonDepth(value: unknown, maximum: number, depth = 0): void {
  if (depth > maximum) throw stableError("MCP_CATALOG_SCHEMA_TOO_DEEP");
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonDepth(entry, maximum, depth + 1);
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) assertJsonDepth(entry, maximum, depth + 1);
}

function assertBoundedResult(value: unknown, maxBytes: number, maxDepth: number) {
  assertJsonDepth(value, maxDepth);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw stableError("MCP_RESULT_INVALID");
  }
  if (bytes > maxBytes) throw stableError("MCP_RESULT_TOO_LARGE");
}

export function sanitizeMcpServerInstructions(value: string | undefined): SanitizedMcpInstructions | undefined {
  const text = value?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (!text) return undefined;
  const characters = [...text];
  return {
    text: characters.slice(0, 512).join(""),
    trust: "external",
    truncated: characters.length > 512
  };
}

function mergeSignals(lifecycle: AbortSignal, caller?: AbortSignal) {
  const controller = new AbortController();
  const relayLifecycle = () => controller.abort(abortReason(lifecycle));
  const relayCaller = () => caller && controller.abort(abortReason(caller));
  if (lifecycle.aborted) relayLifecycle();
  else lifecycle.addEventListener("abort", relayLifecycle, { once: true });
  if (caller?.aborted) relayCaller();
  else caller?.addEventListener("abort", relayCaller, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      lifecycle.removeEventListener("abort", relayLifecycle);
      caller?.removeEventListener("abort", relayCaller);
    }
  };
}

function assertExplicitRequestOptions(options: RequestOptions) {
  if (!Number.isSafeInteger(options.timeout) || (options.timeout ?? 0) <= 0
    || !Number.isSafeInteger(options.maxTotalTimeout) || (options.maxTotalTimeout ?? 0) <= 0
    || (options.maxTotalTimeout ?? 0) < (options.timeout ?? 0)) {
    throw stableError("MCP_REQUEST_OPTIONS_REQUIRED");
  }
}

function resolveRequestLimits(limits: McpRequestLimits | undefined, timeout: number, maxTotalTimeout: number) {
  if (!limits) return { timeout, maxTotalTimeout };
  if (!Number.isSafeInteger(limits.timeout) || limits.timeout <= 0 || limits.timeout > 5 * 60_000
    || !Number.isSafeInteger(limits.maxTotalTimeout) || limits.maxTotalTimeout < limits.timeout
    || limits.maxTotalTimeout > 15 * 60_000) {
    throw stableError("MCP_REQUEST_OPTIONS_REQUIRED");
  }
  return limits;
}

function assertSafeResourceUri(raw: string) {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    throw stableError("MCP_RESOURCE_URI_INVALID");
  }
  if (uri.protocol !== "file:") return;
  if (uri.hostname || /%(?:2f|5c|00)/iu.test(raw)) throw stableError("MCP_RESOURCE_URI_FORBIDDEN");
  let pathname: string;
  try {
    pathname = decodeURIComponent(uri.pathname);
  } catch {
    throw stableError("MCP_RESOURCE_URI_INVALID");
  }
  if (pathname !== "/workbench" && !pathname.startsWith("/workbench/")) {
    throw stableError("MCP_RESOURCE_URI_FORBIDDEN");
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw stableError("MCP_CLIENT_CONFIG_INVALID");
  return value;
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : stableError("MCP_REQUEST_ABORTED");
}

function cloneSnapshot(snapshot: McpCatalogSnapshot) {
  return structuredClone(snapshot);
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
