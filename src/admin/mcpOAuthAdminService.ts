import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type {
  AgentMcpServerDescriptor,
  AgentMcpServerIndex
} from "../../packages/contracts/extensions/agentExtensions.js";
import type {
  McpOAuthLoopbackBroker,
  McpOAuthLoopbackReservation,
  McpOAuthService
} from "../../adapters/mcp/public.js";
import { MCP_OAUTH_ADMIN_SUBJECT } from "../../adapters/mcp/environmentSecrets.js";

export interface McpOAuthAdminRepository {
  ensureLayout(agentId: string): Promise<void>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
  bindMcpOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }): Promise<AgentMcpServerDescriptor>;
  disableMcpOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }): Promise<AgentMcpServerDescriptor>;
}

interface ActiveAuthorization {
  agentId: string;
  reservation: McpOAuthLoopbackReservation;
}

type CredentialRevocation = Parameters<McpOAuthService["revoke"]>[0];

const RESERVATION_CLOSE_TIMEOUT_MS = 2_000;

export class McpOAuthAdminService {
  private readonly active = new Map<string, ActiveAuthorization>();
  private readonly pendingCredentialRevocations = new Map<string, CredentialRevocation>();
  private orphanReservationSequence = 0;

  constructor(private readonly options: {
    repository: McpOAuthAdminRepository;
    oauth: McpOAuthService;
    loopback: McpOAuthLoopbackBroker;
    agentExists(agentId: string): boolean | Promise<boolean>;
    onAgentChanged?(agentId: string): Promise<void>;
  }) {}

  async begin(input: {
    agentId: string;
    serverId: string;
    browserSessionId: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scopes: string[];
    signal?: AbortSignal;
  }) {
    return this.call(async () => {
      const current = await this.server(input.agentId, input.serverId);
      const reservation = await this.options.loopback.reserve({ signal: input.signal });
      let begun: ReturnType<McpOAuthService["begin"]> | undefined;
      try {
        begun = this.options.oauth.begin({
          agentId: input.agentId,
          serverId: input.serverId,
          browserSessionId: input.browserSessionId,
          authorizationEndpoint: input.authorizationEndpoint,
          tokenEndpoint: input.tokenEndpoint,
          clientId: input.clientId,
          redirectUri: reservation.redirectUri,
          resource: current.server.url,
          scopes: input.scopes
        });
        const state = begun.state;
        this.active.set(state, { agentId: input.agentId, reservation });
        reservation.activate({
          state,
          expiresAt: begun.expiresAt,
          signal: input.signal,
          onCallback: async (callback) => {
            let completed: Awaited<ReturnType<McpOAuthService["completeCallback"]>> | undefined;
            let bound = false;
            try {
              completed = await this.options.oauth.completeCallback({
                state: callback.state,
                code: callback.code,
                browserSessionId: input.browserSessionId,
                subject: MCP_OAUTH_ADMIN_SUBJECT,
                signal: callback.signal
              });
              await this.options.repository.bindMcpOAuthCredential({
                agentId: completed.agentId,
                serverId: completed.serverId,
                expectedRevision: current.index.revision,
                expectedUrl: completed.resource,
                credentialRef: completed.credentialHandle
              });
              bound = true;
              try {
                await this.notifyAgentChanged(completed.agentId);
              } catch (error) {
                const disabled = await this.disableBoundCredential(completed);
                if (disabled) {
                  await this.reloadAndRevoke(completed.agentId, {
                    agentId: completed.agentId,
                    serverId: completed.serverId,
                    subject: completed.subject,
                    resource: completed.resource,
                    credentialHandle: completed.credentialHandle
                  });
                }
                throw error;
              }
            } catch (error) {
              if (completed && !bound) {
                await this.revokeCredential({
                  agentId: completed.agentId,
                  serverId: completed.serverId,
                  subject: completed.subject,
                  resource: completed.resource,
                  credentialHandle: completed.credentialHandle
                });
              }
              throw error;
            } finally {
              this.active.delete(state);
            }
          }
        });
        return {
          authorizationUrl: begun.authorizationUrl,
          authorizationOrigin: begun.authorizationOrigin,
          expiresAt: new Date(begun.expiresAt).toISOString()
        };
      } catch (error) {
        if (begun) {
          this.options.oauth.cancel(begun.state);
        }
        const key = begun?.state ?? `orphan:${input.agentId}:${input.serverId}:${++this.orphanReservationSequence}`;
        if (!this.active.has(key)) this.active.set(key, { agentId: input.agentId, reservation });
        try {
          await this.closeReservations([[key, this.active.get(key)!]]);
        } catch (closeError) {
          throw closeError;
        }
        throw error;
      }
    });
  }

  async refresh(input: { agentId: string; serverId: string; signal?: AbortSignal }) {
    return this.call(async () => {
      const current = await this.server(input.agentId, input.serverId, true);
      let refreshed: Awaited<ReturnType<McpOAuthService["refresh"]>>;
      try {
        refreshed = await this.options.oauth.refresh({
          ...binding(input.agentId, input.serverId, current.server),
          credentialHandle: current.server.auth.credentialRef,
          signal: input.signal
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "MCP_OAUTH_INVALID_GRANT") throw error;
        await this.options.repository.disableMcpOAuthCredential({
          agentId: input.agentId,
          serverId: input.serverId,
          expectedRevision: current.index.revision,
          expectedUrl: current.server.url,
          credentialRef: current.server.auth.credentialRef
        });
        await this.reloadAndRevoke(input.agentId, {
          ...binding(input.agentId, input.serverId, current.server),
          credentialHandle: current.server.auth.credentialRef
        });
        throw new Error("MCP_OAUTH_CREDENTIAL_INVALIDATED");
      }
      await this.notifyAgentChanged(input.agentId);
      return {
        ok: true as const,
        ...(refreshed.expiresAt === undefined ? {} : { expiresAt: new Date(refreshed.expiresAt).toISOString() })
      };
    });
  }

  async revoke(input: { agentId: string; serverId: string }) {
    return this.call(async () => {
      const current = await this.server(input.agentId, input.serverId, true);
      const credentialHandle = current.server.auth.credentialRef;
      await this.options.repository.disableMcpOAuthCredential({
        agentId: input.agentId,
        serverId: input.serverId,
        expectedRevision: current.index.revision,
        expectedUrl: current.server.url,
        credentialRef: credentialHandle
      });
      await this.reloadAndRevoke(input.agentId, {
        ...binding(input.agentId, input.serverId, current.server),
        credentialHandle
      });
      return { ok: true as const };
    });
  }

  async closeAgent(agentId: string) {
    this.options.oauth.revokeAgent(agentId);
    const reservations = [...this.active.entries()].filter(([, active]) => active.agentId === agentId);
    await this.lifecycleCleanup(reservations, agentId);
  }

  async close() {
    await this.lifecycleCleanup([...this.active.entries()]);
  }

  private async server(agentId: string, serverId: string, requireCredential = false) {
    if (!await this.options.agentExists(agentId)) {
      throw new ServiceError(404, "AGENT_NOT_FOUND", "Agent 不存在。");
    }
    await this.options.repository.ensureLayout(agentId);
    const index = await this.options.repository.readMcpServerIndex(agentId);
    const server = index.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new ServiceError(404, "MCP_SERVER_NOT_FOUND", "MCP 服务不存在。");
    if (server.transport !== "streamable_http" || server.auth.kind !== "oauth" ||
        (requireCredential && !/^mcpcred_[A-Za-z0-9_-]{24,120}$/u.test(server.auth.credentialRef))) {
      throw new ServiceError(409, "MCP_OAUTH_SERVER_NOT_CONFIGURED", "MCP OAuth 尚未配置。");
    }
    return {
      index,
      server: server as Extract<AgentMcpServerDescriptor, { transport: "streamable_http" }> & {
        auth: { kind: "oauth"; credentialRef: string };
      }
    };
  }

  private async notifyAgentChanged(agentId: string) {
    if (!this.options.onAgentChanged) return;
    try {
      await this.options.onAgentChanged(agentId);
    } catch {
      throw new Error("MCP_OAUTH_RUNTIME_RELOAD_FAILED");
    }
  }

  private async reloadAndRevoke(agentId: string, credential: CredentialRevocation) {
    let reloadError: unknown;
    try {
      await this.notifyAgentChanged(agentId);
    } catch (error) {
      reloadError = error;
    }
    try {
      await this.revokeCredential(credential);
    } catch (error) {
      throw error;
    }
    if (reloadError) throw reloadError;
  }

  private async revokeCredential(credential: CredentialRevocation) {
    this.pendingCredentialRevocations.set(credential.credentialHandle, credential);
    await this.options.oauth.revoke(credential);
    this.pendingCredentialRevocations.delete(credential.credentialHandle);
  }

  private async lifecycleCleanup(
    reservations: Array<[string, ActiveAuthorization]>,
    agentId?: string
  ) {
    let reservationError: unknown;
    let credentialError: unknown;
    try {
      await this.closeReservations(reservations);
    } catch (error) {
      reservationError = error;
    }
    const credentials = [...this.pendingCredentialRevocations.values()]
      .filter((credential) => agentId === undefined || credential.agentId === agentId);
    for (const credential of credentials) {
      try {
        await this.revokeCredential(credential);
      } catch (error) {
        credentialError ??= error;
      }
    }
    if (credentialError) throw credentialError;
    if (reservationError) throw reservationError;
  }

  private async closeReservations(reservations: Array<[string, ActiveAuthorization]>) {
    let closeFailed = false;
    await Promise.all(reservations.map(async ([state, active]) => {
      try {
        await withDeadline(active.reservation.close(), RESERVATION_CLOSE_TIMEOUT_MS);
        if (this.active.get(state) === active) this.active.delete(state);
      } catch {
        closeFailed = true;
      }
    }));
    if (closeFailed) throw new Error("MCP_OAUTH_LOOPBACK_CLOSE_FAILED");
  }

  private async disableBoundCredential(completed: {
    agentId: string;
    serverId: string;
    resource: string;
    credentialHandle: string;
  }) {
    const index = await this.options.repository.readMcpServerIndex(completed.agentId);
    const server = index.servers.find((candidate) => candidate.id === completed.serverId);
    if (!server || server.transport !== "streamable_http" || server.url !== completed.resource ||
        server.auth.kind !== "oauth" || server.auth.credentialRef !== completed.credentialHandle) return false;
    await this.options.repository.disableMcpOAuthCredential({
      agentId: completed.agentId,
      serverId: completed.serverId,
      expectedRevision: index.revision,
      expectedUrl: completed.resource,
      credentialRef: completed.credentialHandle
    });
    return true;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const code = stableCode(error);
      const status = code.includes("CONFLICT") ? 409 : code.includes("UNAVAILABLE") ? 503 : 400;
      throw new ServiceError(status, code, "MCP OAuth 操作失败。");
    }
  }
}

function binding(
  agentId: string,
  serverId: string,
  server: Extract<AgentMcpServerDescriptor, { transport: "streamable_http" }>
) {
  return { agentId, serverId, subject: MCP_OAUTH_ADMIN_SUBJECT, resource: server.url };
}

function stableCode(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  return /^MCP_[A-Z0-9_]+$/u.test(value) ? value : "MCP_OAUTH_REQUEST_FAILED";
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP_OAUTH_LOOPBACK_CLOSE_FAILED")), timeoutMs);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
