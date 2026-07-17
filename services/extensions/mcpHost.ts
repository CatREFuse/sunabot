import { createHash } from "node:crypto";
import type { AgentMcpServerDescriptor } from "../../packages/contracts/extensions/agentExtensions.js";
import type { McpRequestOptions } from "./mcpCatalogSnapshot.js";
import {
  McpHostServerPool,
  mcpHostServerKey,
  type McpRuntimeClientFactory,
  type McpRuntimeClientPort
} from "./mcpHostServerPool.js";
import { assertBoundedMcpToolArguments } from "./mcpJsonLimits.js";
import { assertCanonicalMcpResourceUri } from "./mcpResourceUri.js";
import { isMcpProviderToolAlias, type McpToolAliasDigest } from "./mcpToolCatalog.js";

export type {
  McpRuntimeCapabilities,
  McpRuntimeClientFactory,
  McpRuntimeClientPort
} from "./mcpHostServerPool.js";

interface ReadinessInvalidation {
  generation: number;
  dirty: boolean;
  promise: Promise<void>;
}

interface RequiredReadinessRetry {
  agentId: string;
  generation: number;
  descriptorFingerprint: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class AgentMcpHost {
  private readonly pool: McpHostServerPool;
  private readonly agentGenerations = new Map<string, number>();
  private readonly publishedReadiness = new Map<string, "ready" | "degraded" | "not_ready">();
  private readonly readinessInvalidations = new Map<string, ReadinessInvalidation>();
  private readonly activeReadinessInvalidations = new Map<string, number>();
  private readonly requiredReadinessRetries = new Map<string, RequiredReadinessRetry>();
  private readonly closingAgents = new Map<string, Promise<void>>();
  private closed = false;
  private readinessInvalidationHandler?: (agentId: string) => void | Promise<void>;

  constructor(
    factory: McpRuntimeClientFactory,
    aliasDigest?: McpToolAliasDigest,
    private readonly options: {
      maxConcurrentStarts?: number;
      reconcileTimeoutMs?: number;
      requiredRetryBaseMs?: number;
      requiredRetryMaxMs?: number;
    } = {}
  ) {
    this.pool = new McpHostServerPool(factory, aliasDigest, {
      reconcileTimeoutMs: options.reconcileTimeoutMs,
      isClosed: () => this.closed,
      generationFor: (agentId) => this.agentGenerations.get(agentId) ?? 0,
      onReadinessChanged: (agentId) => this.invalidatePublishedReadinessIfChanged(agentId)
    });
  }

  setReadinessInvalidationHandler(handler: (agentId: string) => void | Promise<void>) {
    this.readinessInvalidationHandler = handler;
    for (const [agentId, status] of this.publishedReadiness) {
      if (status === "not_ready") this.syncRequiredReadinessRetry(agentId, status);
    }
  }

  async reconcileAgent(agentId: string, descriptors: AgentMcpServerDescriptor[]) {
    if (this.closed) throw new Error("MCP_HOST_CLOSED");
    if (this.closingAgents.has(agentId)) throw new Error("MCP_AGENT_CLOSING");
    const generation = this.agentGenerations.get(agentId) ?? 0;
    const activeInvalidationGeneration = this.activeReadinessInvalidations.get(agentId);
    if (activeInvalidationGeneration !== undefined && activeInvalidationGeneration !== generation) {
      throw new Error("MCP_CLIENT_START_ABORTED");
    }
    const enabled = descriptors.filter((server) => server.enabled);
    const requiredDisabled = descriptors.filter((server) => !server.enabled && server.required === true);
    const desired = new Set(enabled.map((server) => mcpHostServerKey(agentId, server.id)));
    await this.pool.pruneAgent(agentId, desired);
    const failures: string[] = [];
    for (const descriptor of requiredDisabled) {
      this.pool.setFailure(agentId, descriptor, "MCP_REQUIRED_SERVER_DISABLED");
      failures.push(descriptor.id);
    }
    const reconcileAbort = new AbortController();
    const timeoutMs = boundedHostOption(this.options.reconcileTimeoutMs, 30_000, 10, 120_000);
    const timer = setTimeout(() => reconcileAbort.abort(new Error("MCP_RECONCILE_TIMEOUT")), timeoutMs);
    timer.unref?.();
    const orderedEnabled = [...enabled].sort((left, right) => compareText(left.id, right.id));
    let cursor = 0;
    const worker = async () => {
      while (!reconcileAbort.signal.aborted) {
        const descriptor = orderedEnabled[cursor++];
        if (!descriptor) return;
        try {
          const state = await this.pool.ensureServer(agentId, descriptor, generation, reconcileAbort.signal);
          this.pool.deleteFailure(agentId, descriptor.id);
          if (descriptor.required === true && state.status !== "ready") failures.push(descriptor.id);
        } catch (error) {
          this.pool.setFailure(agentId, descriptor, stableHostErrorCode(error));
          if (descriptor.required === true) failures.push(descriptor.id);
        }
      }
    };
    const concurrency = Math.min(
      orderedEnabled.length,
      boundedHostOption(this.options.maxConcurrentStarts, 4, 1, 8)
    );
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      clearTimeout(timer);
      if (reconcileAbort.signal.aborted) {
        for (const descriptor of orderedEnabled.slice(cursor)) {
          this.pool.setFailure(agentId, descriptor, "MCP_RECONCILE_TIMEOUT");
          if (descriptor.required === true) failures.push(descriptor.id);
        }
      }
    }
    const toolCatalog = this.pool.buildToolCatalog(agentId);
    for (const descriptor of enabled) {
      if (descriptor.required === true && toolCatalog.degradedServerIds.has(descriptor.id)) failures.push(descriptor.id);
    }
    const result = {
      ready: failures.length === 0,
      requiredFailures: [...new Set(failures)].sort()
    };
    const readinessStatus = this.readinessStatus(agentId, toolCatalog);
    this.publishedReadiness.set(agentId, readinessStatus);
    this.syncRequiredReadinessRetry(agentId, readinessStatus);
    return result;
  }

  toolDefinitions(agentId: string) {
    return this.pool.toolDefinitions(agentId);
  }

  toolAlias(agentId: string, serverId: string, toolName: string) {
    return this.pool.toolAlias(agentId, serverId, toolName);
  }

  describeToolAlias(agentId: string, value: string) {
    return this.pool.describeToolAlias(agentId, value);
  }

  async callTool(input: {
    agentId: string;
    alias: string;
    arguments: Record<string, unknown>;
    approved: boolean;
    signal?: AbortSignal;
  }) {
    assertBoundedMcpToolArguments(input.arguments);
    const { parsed, state } = this.pool.resolveTool(input.agentId, input.alias);
    const approvalMode = state.descriptor.approvalMode ?? "always";
    if (approvalMode !== "never" && !input.approved) throw new Error("MCP_TOOL_APPROVAL_REQUIRED");
    return boundedResult(await state.client.callTool(parsed.toolName, input.arguments, requestOptions(input.signal, 60_000)));
  }

  async readResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    const state = this.pool.requireState(input.agentId, input.serverId, "resources");
    const uri = assertCanonicalMcpResourceUri(input.uri);
    return boundedResult(await state.client.readResource(uri, requestOptions(input.signal, 20_000)));
  }

  async subscribeResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    const state = this.pool.requireState(input.agentId, input.serverId, "resources");
    const uri = assertCanonicalMcpResourceUri(input.uri);
    if (state.client.capabilities.resourceSubscriptions !== true ||
        !state.snapshot?.resources.some((resource) => resource.uri === uri)) {
      throw new Error("MCP_RESOURCE_SUBSCRIPTION_UNAVAILABLE");
    }
    const result = boundedResult(await state.client.subscribeResource(uri, requestOptions(input.signal, 20_000)));
    state.subscribedResources.add(uri);
    return result;
  }

  async unsubscribeResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    const state = this.pool.requireState(input.agentId, input.serverId, "resources");
    const uri = assertCanonicalMcpResourceUri(input.uri);
    if (state.client.capabilities.resourceSubscriptions !== true) {
      throw new Error("MCP_RESOURCE_SUBSCRIPTION_UNAVAILABLE");
    }
    const result = boundedResult(await state.client.unsubscribeResource(uri, requestOptions(input.signal, 20_000)));
    state.subscribedResources.delete(uri);
    return result;
  }

  async getPrompt(input: {
    agentId: string;
    serverId: string;
    name: string;
    arguments: Record<string, string>;
    userExplicit: boolean;
    signal?: AbortSignal;
  }) {
    if (!input.userExplicit) throw new Error("MCP_PROMPT_EXPLICIT_SELECTION_REQUIRED");
    const state = this.pool.requireState(input.agentId, input.serverId, "prompts");
    if (!state.snapshot?.prompts.some((prompt) => prompt.name === input.name)) throw new Error("MCP_PROMPT_UNAVAILABLE");
    return boundedResult(await state.client.getPrompt(input.name, input.arguments, requestOptions(input.signal, 20_000)));
  }

  status(agentId: string) {
    return this.pool.status(agentId);
  }

  catalog(agentId: string, serverId: string) {
    return this.pool.catalog(agentId, serverId);
  }

  async closeAgent(agentId: string) {
    const existing = this.closingAgents.get(agentId);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const operation = pending.finally(() => {
      if (this.closingAgents.get(agentId) === operation) this.closingAgents.delete(agentId);
    });
    this.closingAgents.set(agentId, operation);
    void this.closeAgentNow(agentId).then(resolve, reject);
    return operation;
  }

  private async closeAgentNow(agentId: string) {
    this.agentGenerations.set(agentId, (this.agentGenerations.get(agentId) ?? 0) + 1);
    this.cancelRequiredReadinessRetry(agentId);
    try {
      await this.pool.closeAgent(agentId);
    } finally {
      this.publishedReadiness.delete(agentId);
    }
  }

  async close() {
    this.closed = true;
    for (const agentId of this.requiredReadinessRetries.keys()) this.cancelRequiredReadinessRetry(agentId);
    try {
      await this.pool.close();
    } finally {
      this.publishedReadiness.clear();
    }
  }

  private invalidatePublishedReadinessIfChanged(agentId: string) {
    const previous = this.publishedReadiness.get(agentId);
    if (!previous) return;
    const next = this.readinessStatus(agentId);
    if (next === previous) return;
    this.publishedReadiness.set(agentId, next);
    this.scheduleReadinessInvalidation(agentId);
    this.syncRequiredReadinessRetry(agentId, next);
  }

  private readinessStatus(
    agentId: string,
    toolCatalog = this.pool.buildToolCatalog(agentId)
  ): "ready" | "degraded" | "not_ready" {
    let degraded = false;
    for (const [, state] of this.pool.stateEntries(agentId)) {
      const unavailable = state.status !== "ready" || toolCatalog.degradedServerIds.has(state.descriptor.id);
      if (!unavailable) continue;
      if (state.descriptor.required === true) return "not_ready";
      degraded = true;
    }
    for (const [, failure] of this.pool.failureEntries(agentId)) {
      if (failure.descriptor.required === true) return "not_ready";
      degraded = true;
    }
    return degraded ? "degraded" : "ready";
  }

  private scheduleReadinessInvalidation(agentId: string): Promise<void> {
    if (!this.readinessInvalidationHandler || this.closed) return Promise.resolve();
    const existing = this.readinessInvalidations.get(agentId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const generation = this.agentGenerations.get(agentId) ?? 0;
    const entry = { generation, dirty: false, promise: Promise.resolve() } as ReadinessInvalidation;
    entry.promise = Promise.resolve().then(async () => {
      do {
        entry.dirty = false;
        if (this.closed || (this.agentGenerations.get(agentId) ?? 0) !== entry.generation) return;
        const handler = this.readinessInvalidationHandler;
        if (!handler) return;
        const timeoutMs = boundedHostOption(this.options.reconcileTimeoutMs, 10_000, 10, 120_000);
        this.activeReadinessInvalidations.set(agentId, entry.generation);
        try {
          await hostCleanupDeadline(Promise.resolve().then(() => handler(agentId)), timeoutMs).catch(() => undefined);
        } finally {
          if (this.activeReadinessInvalidations.get(agentId) === entry.generation) {
            this.activeReadinessInvalidations.delete(agentId);
          }
        }
      } while (entry.dirty);
    }).finally(() => {
      if (this.readinessInvalidations.get(agentId) === entry) this.readinessInvalidations.delete(agentId);
    });
    this.readinessInvalidations.set(agentId, entry);
    return entry.promise;
  }

  private syncRequiredReadinessRetry(agentId: string, status: "ready" | "degraded" | "not_ready") {
    if (status !== "not_ready" || !this.readinessInvalidationHandler || this.closed) {
      this.cancelRequiredReadinessRetry(agentId);
      return;
    }
    const generation = this.agentGenerations.get(agentId) ?? 0;
    const descriptorFingerprint = this.requiredDescriptorFingerprint(agentId);
    const existing = this.requiredReadinessRetries.get(agentId);
    if (existing?.generation === generation && existing.descriptorFingerprint === descriptorFingerprint) return;
    this.cancelRequiredReadinessRetry(agentId);
    const retry: RequiredReadinessRetry = {
      agentId,
      generation,
      descriptorFingerprint,
      attempt: 0
    };
    this.requiredReadinessRetries.set(agentId, retry);
    this.armRequiredReadinessRetry(retry);
  }

  private armRequiredReadinessRetry(retry: RequiredReadinessRetry) {
    if (this.requiredReadinessRetries.get(retry.agentId) !== retry || retry.timer) return;
    const base = boundedHostOption(this.options.requiredRetryBaseMs, 1_000, 10, 60_000);
    const maximum = boundedHostOption(this.options.requiredRetryMaxMs, 60_000, base, 120_000);
    const delay = Math.min(maximum, base * (2 ** Math.min(retry.attempt, 10)));
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      void this.runRequiredReadinessRetry(retry);
    }, delay);
    retry.timer.unref?.();
  }

  private async runRequiredReadinessRetry(retry: RequiredReadinessRetry) {
    if (this.requiredReadinessRetries.get(retry.agentId) !== retry || this.closed ||
        (this.agentGenerations.get(retry.agentId) ?? 0) !== retry.generation ||
        this.publishedReadiness.get(retry.agentId) !== "not_ready" ||
        this.requiredDescriptorFingerprint(retry.agentId) !== retry.descriptorFingerprint) {
      this.cancelRequiredReadinessRetry(retry.agentId);
      return;
    }
    await this.scheduleReadinessInvalidation(retry.agentId);
    if (this.requiredReadinessRetries.get(retry.agentId) !== retry ||
        this.publishedReadiness.get(retry.agentId) !== "not_ready") return;
    retry.attempt += 1;
    this.armRequiredReadinessRetry(retry);
  }

  private requiredDescriptorFingerprint(agentId: string) {
    const descriptors = new Map<string, AgentMcpServerDescriptor>();
    for (const [, state] of this.pool.stateEntries(agentId)) {
      if (state.descriptor.required === true) descriptors.set(state.descriptor.id, state.descriptor);
    }
    for (const [, failure] of this.pool.failureEntries(agentId)) {
      if (failure.descriptor.required === true) descriptors.set(failure.descriptor.id, failure.descriptor);
    }
    return createHash("sha256").update(JSON.stringify([...descriptors]
      .sort(([left], [right]) => compareText(left, right)))).digest("hex");
  }

  private cancelRequiredReadinessRetry(agentId: string) {
    const retry = this.requiredReadinessRetries.get(agentId);
    if (!retry) return;
    if (retry.timer) clearTimeout(retry.timer);
    this.requiredReadinessRetries.delete(agentId);
  }
}

function requestOptions(signal: AbortSignal | undefined, timeout: number): McpRequestOptions {
  return { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false };
}

function hostCleanupDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP_CLIENT_CLEANUP_FAILED")), timeoutMs);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function isMcpToolAlias(value: string) {
  return isMcpProviderToolAlias(value);
}

function boundedResult(value: unknown) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, "utf8") > 1024 * 1024) throw new Error("MCP_RESULT_LIMIT");
  return JSON.parse(encoded) as unknown;
}

function stableHostErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  return /^MCP_[A-Z0-9_]+$/u.test(value) ? value : "MCP_SERVER_UNAVAILABLE";
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedHostOption(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error("MCP_HOST_OPTION_INVALID");
  }
  return resolved;
}
