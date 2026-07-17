import type { AgentMcpServerDescriptor } from "../../packages/contracts/extensions/agentExtensions.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_VIRTUAL_WORKBENCH_ROOT
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import {
  refreshMcpCatalog,
  McpCatalogClientPort,
  McpCatalogCommit,
  McpCatalogSnapshot,
  McpRequestOptions
} from "./mcpCatalogSnapshot.js";
import { McpHostCatalogView } from "./mcpHostCatalogView.js";
import type { McpToolAliasDigest } from "./mcpToolCatalog.js";

export { externalMcpDescription } from "./mcpHostCatalogView.js";

export interface McpRuntimeCapabilities {
  tools?: boolean;
  resources?: boolean;
  resourceSubscriptions?: boolean;
  prompts?: boolean;
  logging?: boolean;
  experimental?: Record<string, unknown>;
  sampling?: unknown;
  elicitation?: unknown;
  tasks?: unknown;
}

export interface McpRuntimeClientPort extends McpCatalogClientPort {
  protocolVersion: string;
  capabilities: McpRuntimeCapabilities;
  instructions?: string;
  commitCatalog(input: McpCatalogCommit): void;
  callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<unknown>;
  readResource(uri: string, options: McpRequestOptions): Promise<unknown>;
  subscribeResource(uri: string, options: McpRequestOptions): Promise<unknown>;
  unsubscribeResource(uri: string, options: McpRequestOptions): Promise<unknown>;
  getPrompt(name: string, args: Record<string, string>, options: McpRequestOptions): Promise<unknown>;
  setListChangedHandler(handler: () => void): void;
  setResourceUpdatedHandler(handler: (uri: string) => void): void;
  setRootsHandler(handler: () => { roots: Array<{ uri: string; name: string }> }): void;
  setLifecycleHandler?(handler: (event: { unexpected: boolean }) => void): void;
  close(): Promise<void>;
}

export interface McpRuntimeClientFactory {
  create(input: { agentId: string; server: AgentMcpServerDescriptor; signal: AbortSignal }): Promise<McpRuntimeClientPort>;
  cleanupOrphans?(input?: { agentId?: string }): Promise<void>;
}

export interface McpHostServerState {
  agentId: string;
  stateKey: string;
  generation: number;
  descriptor: AgentMcpServerDescriptor;
  client: McpRuntimeClientPort;
  snapshot: McpCatalogSnapshot | null;
  catalogGeneration: number;
  status: "ready" | "degraded";
  abort: AbortController;
  refresh?: Promise<void>;
  refreshDirty: boolean;
  subscribedResources: Set<string>;
}

interface ServerStart {
  descriptorJson: string;
  promise: Promise<McpHostServerState>;
  abort: AbortController;
}

interface ClientCreationLifecycle {
  promise: Promise<void>;
  status: "pending" | "fulfilled" | "rejected";
}

export interface McpHostServerFailure {
  descriptor: AgentMcpServerDescriptor;
  errorCode: string;
}

export interface McpHostServerPoolOptions {
  reconcileTimeoutMs?: number;
  isClosed(): boolean;
  generationFor(agentId: string): number;
  onReadinessChanged(agentId: string): void;
}

export class McpHostServerPool {
  private readonly states = new Map<string, McpHostServerState>();
  private readonly starts = new Map<string, ServerStart>();
  private readonly failures = new Map<string, McpHostServerFailure>();
  private readonly orphanedClients = new Map<string, McpRuntimeClientPort>();
  private readonly orphanCleanups = new Map<string, Promise<void>>();
  private readonly creationLifecycles = new Map<string, Set<ClientCreationLifecycle>>();
  private readonly disconnectedClients = new WeakSet<McpRuntimeClientPort>();
  private readonly catalogView: McpHostCatalogView<McpHostServerState, McpHostServerFailure>;
  private orphanSequence = 0;

  constructor(
    private readonly factory: McpRuntimeClientFactory,
    private readonly aliasDigest: McpToolAliasDigest | undefined,
    private readonly options: McpHostServerPoolOptions
  ) {
    this.catalogView = new McpHostCatalogView(
      this.states,
      this.starts,
      this.failures,
      this.aliasDigest,
      mcpHostServerKey
    );
  }

  stateEntries(agentId: string) {
    return this.catalogView.stateEntries(agentId);
  }

  failureEntries(agentId: string) {
    return this.catalogView.failureEntries(agentId);
  }

  async pruneAgent(agentId: string, desired: Set<string>) {
    const obsoleteStarts = [...this.starts.entries()]
      .filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`) && !desired.has(stateKey));
    for (const [, start] of obsoleteStarts) start.abort.abort();
    await Promise.all(obsoleteStarts.map(([, start]) => start.promise.catch(() => undefined)));
    const obsoleteLifecycleKeys = [...this.creationLifecycles.keys()]
      .filter((stateKey) => stateKey.startsWith(`${agentId}\0`) && !desired.has(stateKey));
    const obsoleteOrphanKeys = [...new Set([...this.orphanedClients.keys()].map(orphanStateKey))]
      .filter((stateKey) => stateKey.startsWith(`${agentId}\0`) && !desired.has(stateKey));
    const cleanupKeys = [...new Set([
      ...obsoleteStarts.map(([stateKey]) => stateKey),
      ...obsoleteLifecycleKeys,
      ...obsoleteOrphanKeys
    ])];
    const creationCleanup = await Promise.allSettled(
      cleanupKeys.map((stateKey) => this.drainCreationLifecycles({ stateKey }))
    );
    const orphanCleanup = await Promise.allSettled(
      cleanupKeys.map((stateKey) => this.cleanupOrphans(stateKey))
    );
    for (const [stateKey, state] of this.states) {
      if (stateKey.startsWith(`${agentId}\0`) && !desired.has(stateKey)) {
        await this.disposeState(stateKey, state);
      }
    }
    for (const stateKey of [...this.failures.keys()]) {
      if (stateKey.startsWith(`${agentId}\0`) && !desired.has(stateKey)) this.failures.delete(stateKey);
    }
    if ([...creationCleanup, ...orphanCleanup].some((result) => result.status === "rejected")) {
      throw new Error("MCP_CLIENT_CLEANUP_FAILED");
    }
  }

  setFailure(agentId: string, descriptor: AgentMcpServerDescriptor, errorCode: string) {
    this.failures.set(mcpHostServerKey(agentId, descriptor.id), { descriptor, errorCode });
  }

  deleteFailure(agentId: string, serverId: string) {
    this.failures.delete(mcpHostServerKey(agentId, serverId));
  }

  async ensureServer(
    agentId: string,
    descriptor: AgentMcpServerDescriptor,
    generation: number,
    reconcileSignal?: AbortSignal
  ): Promise<McpHostServerState> {
    if (this.options.isClosed() || this.options.generationFor(agentId) !== generation) {
      throw new Error("MCP_CLIENT_START_ABORTED");
    }
    const stateKey = mcpHostServerKey(agentId, descriptor.id);
    const descriptorJson = JSON.stringify(descriptor);
    let starting = this.starts.get(stateKey);
    if (starting) {
      await raceWithAbort(starting.promise.catch(() => undefined), reconcileSignal);
      return this.ensureServer(agentId, descriptor, generation, reconcileSignal);
    }
    await this.drainCreationLifecycles({ stateKey });
    await this.cleanupOrphans(stateKey);
    starting = this.starts.get(stateKey);
    if (starting) {
      await raceWithAbort(starting.promise.catch(() => undefined), reconcileSignal);
      return this.ensureServer(agentId, descriptor, generation, reconcileSignal);
    }
    const previous = this.states.get(stateKey);
    if (previous && JSON.stringify(previous.descriptor) === descriptorJson) {
      if (previous.status === "degraded") await this.requestRefresh(previous);
      else if (previous.refresh) await previous.refresh;
      return previous;
    }
    const abort = new AbortController();
    const removeReconcileAbort = relayAbort(reconcileSignal, abort);
    const promise = this.createServer(agentId, descriptor, stateKey, abort, generation);
    const entry = { descriptorJson, promise, abort };
    this.starts.set(stateKey, entry);
    try {
      return await promise;
    } finally {
      removeReconcileAbort();
      if (this.starts.get(stateKey) === entry) this.starts.delete(stateKey);
    }
  }

  buildToolCatalog(agentId: string) {
    return this.catalogView.buildToolCatalog(agentId);
  }

  toolDefinitions(agentId: string) {
    return this.catalogView.toolDefinitions(agentId);
  }

  toolAlias(agentId: string, serverId: string, toolName: string) {
    return this.catalogView.toolAlias(agentId, serverId, toolName);
  }

  resolveTool(agentId: string, value: string) {
    return this.catalogView.resolveTool(agentId, value);
  }

  describeToolAlias(agentId: string, value: string) {
    return this.catalogView.describeToolAlias(agentId, value);
  }

  requireState(agentId: string, serverId: string, capability: "resources" | "prompts") {
    return this.catalogView.requireState(agentId, serverId, capability);
  }

  status(agentId: string) {
    return this.catalogView.status(agentId);
  }

  catalog(agentId: string, serverId: string) {
    return this.catalogView.catalog(agentId, serverId);
  }

  async closeAgent(agentId: string) {
    const starts = [...this.starts.entries()].filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`));
    for (const [, start] of starts) start.abort.abort();
    await Promise.all(starts.map(([, start]) => start.promise.catch(() => undefined)));
    const creationCleanup = await Promise.allSettled([this.drainCreationLifecycles({ agentId })]);
    await Promise.all([...this.orphanCleanups.entries()]
      .filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`))
      .map(([, cleanup]) => cleanup.catch(() => undefined)));
    const states = this.stateEntries(agentId);
    for (const [stateKey, state] of states) {
      if (this.states.get(stateKey) === state) this.states.delete(stateKey);
      state.abort.abort();
      state.subscribedResources.clear();
    }
    const clients = new Map<string, McpRuntimeClientPort>([
      ...states.map(([stateKey, state]) => [stateKey, state.client] as const),
      ...[...this.orphanedClients].filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`))
    ]);
    const clientCleanup = await Promise.allSettled([...clients].map(([, client]) => this.closeClient(client)));
    [...clients.keys()].forEach((stateKey, index) => {
      if (clientCleanup[index]?.status === "fulfilled") this.orphanedClients.delete(stateKey);
      else this.orphanedClients.set(stateKey, clients.get(stateKey)!);
    });
    const factoryCleanup = await Promise.allSettled([this.closeFactoryOrphans({ agentId })]);
    for (const stateKey of [...this.failures.keys()]) {
      if (stateKey.startsWith(`${agentId}\0`)) this.failures.delete(stateKey);
    }
    if ([...creationCleanup, ...clientCleanup, ...factoryCleanup]
      .some((result) => result.status === "rejected")) {
      throw new Error("MCP_CLIENT_CLEANUP_FAILED");
    }
  }

  async close() {
    for (const start of this.starts.values()) start.abort.abort();
    await Promise.all([...this.starts.values()].map((start) => start.promise.catch(() => undefined)));
    const creationCleanup = await Promise.allSettled([this.drainCreationLifecycles()]);
    await Promise.all([...this.orphanCleanups.values()].map((cleanup) => cleanup.catch(() => undefined)));
    const current = [...this.states];
    const states = current.map(([, state]) => state);
    this.states.clear();
    for (const state of states) {
      state.abort.abort();
      state.subscribedResources.clear();
    }
    const clients = new Map<string, McpRuntimeClientPort>([
      ...current.map(([stateKey, state]) => [stateKey, state.client] as const),
      ...this.orphanedClients
    ]);
    const clientCleanup = await Promise.allSettled([...clients].map(([, client]) => this.closeClient(client)));
    [...clients.keys()].forEach((stateKey, index) => {
      if (clientCleanup[index]?.status === "fulfilled") this.orphanedClients.delete(stateKey);
      else this.orphanedClients.set(stateKey, clients.get(stateKey)!);
    });
    const factoryCleanup = await Promise.allSettled([this.closeFactoryOrphans()]);
    this.failures.clear();
    if ([...creationCleanup, ...clientCleanup, ...factoryCleanup]
      .some((result) => result.status === "rejected")) {
      throw new Error("MCP_CLIENT_CLEANUP_FAILED");
    }
  }

  private async createServer(
    agentId: string,
    descriptor: AgentMcpServerDescriptor,
    stateKey: string,
    abort: AbortController,
    generation: number
  ): Promise<McpHostServerState> {
    const previous = this.states.get(stateKey);
    let client: McpRuntimeClientPort | undefined;
    try {
      const creating = this.factory.create({ agentId, server: descriptor, signal: abort.signal });
      const abortable = abortableClientCreate(creating, abort.signal, async (lateClient) => {
        try {
          await this.closeClient(lateClient);
          this.forgetOrphan(lateClient);
        } catch {
          this.rememberOrphan(stateKey, lateClient);
          throw new Error("MCP_CLIENT_CLEANUP_FAILED");
        }
      });
      this.trackCreationLifecycle(stateKey, abortable.lifecycle);
      client = await abortable.result;
      if (abort.signal.aborted || this.options.isClosed() || this.options.generationFor(agentId) !== generation) {
        throw new Error("MCP_CLIENT_START_ABORTED");
      }
      if (client.protocolVersion !== MCP_PROTOCOL_VERSION || hasForbiddenCapabilities(client.capabilities)) {
        throw new Error("MCP_CAPABILITY_NEGOTIATION_FAILED");
      }
      client.setRootsHandler(() => ({
        roots: [{ uri: MCP_VIRTUAL_WORKBENCH_ROOT, name: "Agent workbench" }]
      }));
      const state: McpHostServerState = {
        agentId,
        stateKey,
        generation,
        descriptor,
        client,
        snapshot: null,
        catalogGeneration: 0,
        status: "degraded",
        abort,
        refreshDirty: false,
        subscribedResources: new Set()
      };
      client.setListChangedHandler(() => {
        if (this.isStateCurrent(state)) void this.requestRefresh(state).catch(() => undefined);
      });
      client.setResourceUpdatedHandler((uri) => {
        if (this.isStateCurrent(state) && state.subscribedResources.has(uri)) {
          void this.requestRefresh(state).catch(() => undefined);
        }
      });
      client.setLifecycleHandler?.((event) => {
        if (event.unexpected) this.invalidateDisconnectedState(state);
      });
      await this.requestRefresh(state);
      if (abort.signal.aborted || this.options.isClosed() || this.options.generationFor(agentId) !== generation) {
        throw new Error("MCP_CLIENT_START_ABORTED");
      }
      if (previous && previous !== state) {
        if (this.states.get(stateKey) === previous) this.states.delete(stateKey);
        try {
          await this.closeState(previous);
          this.forgetOrphan(previous.client);
        } catch {
          this.rememberOrphan(stateKey, previous.client);
          throw new Error("MCP_CLIENT_CLEANUP_FAILED");
        }
      }
      this.states.set(stateKey, state);
      return state;
    } catch (error) {
      abort.abort();
      if (client) {
        try {
          if (this.disconnectedClients.has(client)) await this.cleanupOrphans(stateKey);
          else await this.closeClient(client);
          this.forgetOrphan(client);
        } catch {
          this.rememberOrphan(stateKey, client);
          throw new Error("MCP_CLIENT_CLEANUP_FAILED");
        }
      }
      if (this.states.get(stateKey) === previous) this.states.delete(stateKey);
      throw error;
    }
  }

  private requestRefresh(state: McpHostServerState) {
    if (!this.isStateCurrent(state)) return Promise.resolve();
    state.refreshDirty = true;
    if (state.refresh) return state.refresh;
    state.refresh = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        state.refreshDirty = false;
        await this.refresh(state);
        if (!state.refreshDirty || state.abort.signal.aborted) return;
      }
      state.refreshDirty = false;
      this.updatePublishedStateStatus(state, "degraded");
    }).finally(() => {
      state.refresh = undefined;
    });
    return state.refresh;
  }

  private async refresh(state: McpHostServerState) {
    if (!this.isStateCurrent(state)) return;
    const refreshed = await refreshMcpCatalog({
      client: state.client,
      capabilities: state.client.capabilities,
      previous: state.snapshot,
      signal: state.abort.signal
    });
    if (!this.isStateCurrent(state)) return;
    if (refreshed.status !== "ready" || !refreshed.snapshot) {
      state.status = "degraded";
      this.options.onReadinessChanged(state.agentId);
      return;
    }
    const nextGeneration = state.catalogGeneration + 1;
    try {
      state.client.commitCatalog({ snapshot: refreshed.snapshot, generation: nextGeneration });
    } catch {
      state.status = "degraded";
      this.options.onReadinessChanged(state.agentId);
      return;
    }
    state.snapshot = refreshed.snapshot;
    state.status = "ready";
    state.catalogGeneration = nextGeneration;
    this.options.onReadinessChanged(state.agentId);
  }

  private async disposeState(stateKey: string, state: McpHostServerState) {
    if (this.states.get(stateKey) !== state) return;
    this.states.delete(stateKey);
    try {
      await this.closeState(state);
      this.forgetOrphan(state.client);
    } catch {
      this.rememberOrphan(stateKey, state.client);
      throw new Error("MCP_CLIENT_CLEANUP_FAILED");
    }
  }

  private async closeState(state: McpHostServerState) {
    state.abort.abort();
    state.subscribedResources.clear();
    await this.closeClient(state.client);
  }

  private isStateCurrent(state: McpHostServerState) {
    if (this.options.isClosed() || state.abort.signal.aborted ||
        this.options.generationFor(state.agentId) !== state.generation) return false;
    if (this.states.get(state.stateKey) === state) return true;
    return this.starts.get(state.stateKey)?.abort === state.abort;
  }

  private invalidateDisconnectedState(state: McpHostServerState) {
    if (!this.isStateCurrent(state)) return;
    if (this.states.get(state.stateKey) === state) this.states.delete(state.stateKey);
    state.abort.abort(new Error("MCP_CLIENT_DISCONNECTED"));
    state.snapshot = null;
    state.status = "degraded";
    state.subscribedResources.clear();
    this.disconnectedClients.add(state.client);
    this.rememberOrphan(state.stateKey, state.client);
    this.failures.set(state.stateKey, {
      descriptor: state.descriptor,
      errorCode: "MCP_CLIENT_DISCONNECTED"
    });
    this.options.onReadinessChanged(state.agentId);
    void this.cleanupOrphans(state.stateKey).catch(() => undefined);
  }

  private updatePublishedStateStatus(state: McpHostServerState, status: McpHostServerState["status"]) {
    state.status = status;
    if (this.states.get(state.stateKey) === state) this.options.onReadinessChanged(state.agentId);
  }

  private rememberOrphan(stateKey: string, client: McpRuntimeClientPort) {
    if ([...this.orphanedClients.values()].includes(client)) return;
    const orphanKey = this.orphanedClients.has(stateKey)
      ? `${stateKey}\0orphan:${++this.orphanSequence}`
      : stateKey;
    this.orphanedClients.set(orphanKey, client);
  }

  private trackCreationLifecycle(stateKey: string, lifecycle: Promise<void>) {
    const entry = { promise: Promise.resolve(), status: "pending" } as ClientCreationLifecycle;
    entry.promise = lifecycle.then(() => {
      entry.status = "fulfilled";
      this.creationLifecycles.get(stateKey)?.delete(entry);
      if (this.creationLifecycles.get(stateKey)?.size === 0) this.creationLifecycles.delete(stateKey);
    }, (error) => {
      entry.status = "rejected";
      throw error;
    });
    const entries = this.creationLifecycles.get(stateKey) ?? new Set<ClientCreationLifecycle>();
    entries.add(entry);
    this.creationLifecycles.set(stateKey, entries);
    void entry.promise.catch(() => undefined);
  }

  private async drainCreationLifecycles(input?: { agentId?: string; stateKey?: string }) {
    const prefix = input?.agentId === undefined ? undefined : `${input.agentId}\0`;
    const selected = [...this.creationLifecycles.entries()].flatMap(([stateKey, entries]) => {
      if (input?.stateKey !== undefined && stateKey !== input.stateKey) return [];
      if (prefix !== undefined && !stateKey.startsWith(prefix)) return [];
      return [...entries].map((entry) => ({ stateKey, entry }));
    });
    if (!selected.length) return;
    const timeoutMs = boundedHostOption(this.options.reconcileTimeoutMs, 10_000, 10, 120_000);
    const settled = await Promise.allSettled(
      selected.map(({ entry }) => hostCleanupDeadline(entry.promise, timeoutMs))
    );
    selected.forEach(({ stateKey, entry }) => {
      if (entry.status === "pending") return;
      this.creationLifecycles.get(stateKey)?.delete(entry);
      if (this.creationLifecycles.get(stateKey)?.size === 0) this.creationLifecycles.delete(stateKey);
    });
    if (settled.some((result) => result.status === "rejected")) {
      throw new Error("MCP_CLIENT_CLEANUP_FAILED");
    }
  }

  private forgetOrphan(client: McpRuntimeClientPort) {
    for (const [orphanKey, candidate] of this.orphanedClients) {
      if (candidate === client) this.orphanedClients.delete(orphanKey);
    }
  }

  private async cleanupOrphans(stateKey: string) {
    const existing = this.orphanCleanups.get(stateKey);
    if (existing) return existing;
    const operation = this.cleanupOrphansNow(stateKey).finally(() => {
      if (this.orphanCleanups.get(stateKey) === operation) this.orphanCleanups.delete(stateKey);
    });
    this.orphanCleanups.set(stateKey, operation);
    return operation;
  }

  private async cleanupOrphansNow(stateKey: string) {
    const entries = [...this.orphanedClients].filter(([orphanKey]) =>
      orphanKey === stateKey || orphanKey.startsWith(`${stateKey}\0orphan:`));
    if (!entries.length) return;
    const settled = await Promise.allSettled(entries.map(([, client]) => this.closeClient(client)));
    entries.forEach(([orphanKey], index) => {
      if (settled[index]?.status === "fulfilled") this.orphanedClients.delete(orphanKey);
    });
    if (settled.some((result) => result.status === "rejected")) throw new Error("MCP_CLIENT_CLEANUP_FAILED");
  }

  private closeClient(client: McpRuntimeClientPort) {
    const timeoutMs = boundedHostOption(this.options.reconcileTimeoutMs, 10_000, 10, 120_000);
    return hostCleanupDeadline(client.close(), timeoutMs);
  }

  private closeFactoryOrphans(input?: { agentId?: string }) {
    if (!this.factory.cleanupOrphans) return Promise.resolve();
    const timeoutMs = boundedHostOption(this.options.reconcileTimeoutMs, 10_000, 10, 120_000);
    return hostCleanupDeadline(Promise.resolve().then(() => this.factory.cleanupOrphans!(input)), timeoutMs);
  }
}

export function mcpHostServerKey(agentId: string, serverId: string) {
  if (!agentId || !serverId || agentId.includes("\0") || serverId.includes("\0")) throw new Error("MCP_ID_INVALID");
  return `${agentId}\0${serverId}`;
}

function hasForbiddenCapabilities(capabilities: McpRuntimeCapabilities) {
  return Boolean(capabilities.experimental || capabilities.sampling || capabilities.elicitation || capabilities.tasks);
}

function boundedHostOption(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error("MCP_HOST_OPTION_INVALID");
  }
  return resolved;
}

function hostCleanupDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP_CLIENT_CLEANUP_FAILED")), timeoutMs);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function relayAbort(source: AbortSignal | undefined, target: AbortController) {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason ?? new Error("MCP_RECONCILE_ABORTED"));
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("MCP_RECONCILE_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("MCP_RECONCILE_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function abortableClientCreate(
  promise: Promise<McpRuntimeClientPort>,
  signal: AbortSignal,
  onLateClient: (client: McpRuntimeClientPort) => Promise<void>
) {
  let resolveLifecycle!: () => void;
  let rejectLifecycle!: (error: unknown) => void;
  const lifecycle = new Promise<void>((resolve, reject) => {
    resolveLifecycle = resolve;
    rejectLifecycle = reject;
  });
  const finishLateClient = (client: McpRuntimeClientPort) => {
    void Promise.resolve().then(() => onLateClient(client)).then(resolveLifecycle, rejectLifecycle);
  };
  if (signal.aborted) {
    void promise.then(finishLateClient, resolveLifecycle);
    return {
      result: Promise.reject<McpRuntimeClientPort>(signal.reason ?? new Error("MCP_CLIENT_START_ABORTED")),
      lifecycle
    };
  }
  const result = new Promise<McpRuntimeClientPort>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error("MCP_CLIENT_START_ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((client) => {
      signal.removeEventListener("abort", abort);
      if (settled) finishLateClient(client);
      else {
        settled = true;
        resolveLifecycle();
        resolve(client);
      }
    }, (error) => {
      signal.removeEventListener("abort", abort);
      resolveLifecycle();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
  return { result, lifecycle };
}

function orphanStateKey(orphanKey: string) {
  const suffix = orphanKey.indexOf("\0orphan:");
  return suffix < 0 ? orphanKey : orphanKey.slice(0, suffix);
}
