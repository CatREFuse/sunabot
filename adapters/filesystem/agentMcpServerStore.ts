import path from "node:path";
import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  compareBinaryText,
  mcpDescriptorEnvKeys,
  parseAgentMcpServerDescriptor,
  parseAgentMcpServerIndex,
  type AgentMcpSecretStatus,
  type AgentMcpServerDescriptor,
  type AgentMcpServerIndex
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  acquireFileLock,
  atomicJson,
  exists,
  readJson,
  storeError,
  type AgentExtensionBeforeFileOpen
} from "./agentExtensionSecureFs.js";
import { extensionRevision } from "./agentSkillPersistence.js";
import {
  AgentExtensionPathGuard,
  type AgentExtensionStorePaths
} from "./agentExtensionPaths.js";

interface AgentMcpServerStoreOptions {
  pathGuard: AgentExtensionPathGuard;
  ensureLayout: (agentId: string) => Promise<void>;
  beforeFileOpen?: AgentExtensionBeforeFileOpen;
}

export class AgentMcpServerStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: AgentMcpServerStoreOptions) {}

  async readServerIndex(agentId: string) {
    const paths = await this.options.pathGuard.paths(agentId);
    await this.options.pathGuard.guard(paths, "read-mcp-index");
    if (!(await exists(paths.mcpIndex))) return withMcpRevision([]);
    return validateMcpIndex(await readJson(paths.mcpIndex, this.options.beforeFileOpen));
  }

  async putServer(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
    replace: boolean;
    expectedIndexRevision?: string;
  }) {
    await this.options.ensureLayout(input.agentId);
    return this.serialized(input.agentId, async () => {
      const server = parseAgentMcpServerDescriptor(input.server);
      const paths = await this.options.pathGuard.paths(input.agentId);
      await this.options.pathGuard.guard(paths, "put-mcp-server");
      return this.withFileLock(paths, async () => {
        const index = await this.readServerIndex(input.agentId);
        if (input.expectedIndexRevision && index.revision !== input.expectedIndexRevision) {
          throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 MCP 索引已变化。");
        }
        const existing = index.servers.find((candidate) => candidate.id === server.id);
        if (existing && !input.replace) throw storeError(409, "MCP_SERVER_CONFLICT", "MCP 服务已存在。");
        const servers = [...index.servers.filter((candidate) => candidate.id !== server.id), server]
          .sort((left, right) => compareBinaryText(left.id, right.id));
        await this.options.pathGuard.guard(paths, "put-mcp-server-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(servers));
        return server;
      });
    });
  }

  async setServerEnabled(input: {
    agentId: string;
    serverId: string;
    enabled: boolean;
    credentialStatus: (query: {
      agentId: string;
      serverId: string;
      envKeys: string[];
    }) => Promise<AgentMcpSecretStatus>;
  }) {
    await this.options.ensureLayout(input.agentId);
    return this.serialized(input.agentId, async () => {
      const paths = await this.options.pathGuard.paths(input.agentId);
      await this.options.pathGuard.guard(paths, "set-mcp-server-enabled");
      return this.withFileLock(paths, async () => {
        const index = await this.readServerIndex(input.agentId);
        const server = index.servers.find((candidate) => candidate.id === input.serverId);
        if (!server) throw storeError(404, "MCP_SERVER_NOT_FOUND", "MCP 服务不存在。");
        if (input.enabled && server.migrationStatus === "reauthorization_required") {
          throw storeError(409, "MCP_REAUTHORIZATION_REQUIRED", "MCP 服务需要重新授权后才能启用。");
        }
        if (input.enabled) {
          const envKeys = mcpDescriptorEnvKeys(server, input.agentId);
          const status = await input.credentialStatus({
            agentId: input.agentId,
            serverId: input.serverId,
            envKeys
          });
          if (status.missingKeys.length > 0) {
            throw storeError(409, "MCP_CREDENTIALS_REQUIRED", "MCP 服务缺少所需凭据。");
          }
        }
        if (server.enabled === input.enabled) return server;
        const updated = { ...server, enabled: input.enabled };
        await this.options.pathGuard.guard(paths, "set-mcp-server-enabled-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(index.servers.map((candidate) =>
          candidate.id === input.serverId ? updated : candidate
        )));
        return updated;
      });
    });
  }

  async removeServer(input: { agentId: string; serverId: string; expectedIndexRevision?: string }) {
    await this.options.ensureLayout(input.agentId);
    return this.serialized(input.agentId, async () => {
      const paths = await this.options.pathGuard.paths(input.agentId);
      await this.options.pathGuard.guard(paths, "remove-mcp-server");
      return this.withFileLock(paths, async () => {
        const index = await this.readServerIndex(input.agentId);
        if (input.expectedIndexRevision && index.revision !== input.expectedIndexRevision) {
          throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 MCP 索引已变化。");
        }
        const server = index.servers.find((candidate) => candidate.id === input.serverId);
        if (!server) throw storeError(404, "MCP_SERVER_NOT_FOUND", "MCP 服务不存在。");
        await this.options.pathGuard.guard(paths, "remove-mcp-server-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(index.servers.filter((candidate) =>
          candidate.id !== input.serverId
        )));
        return server;
      });
    });
  }

  async bindOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }) {
    return this.updateOAuthServer(input, "bind");
  }

  async disableOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }) {
    return this.updateOAuthServer(input, "disable");
  }

  private async updateOAuthServer(
    input: {
      agentId: string;
      serverId: string;
      expectedRevision: string;
      expectedUrl: string;
      credentialRef: string;
    },
    operation: "bind" | "disable"
  ) {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedRevision) ||
        !/^mcpcred_[A-Za-z0-9_-]{24,120}$/u.test(input.credentialRef)) {
      throw storeError(400, "MCP_OAUTH_BINDING_INVALID", "MCP OAuth 绑定无效。");
    }
    await this.options.ensureLayout(input.agentId);
    return this.serialized(input.agentId, async () => {
      const paths = await this.options.pathGuard.paths(input.agentId);
      await this.options.pathGuard.guard(paths, "update-mcp-oauth");
      return this.withFileLock(paths, async () => {
        const index = await this.readServerIndex(input.agentId);
        if (index.revision !== input.expectedRevision) {
          throw storeError(409, "MCP_INDEX_REVISION_CONFLICT", "MCP 服务配置已变化。");
        }
        const server = index.servers.find((candidate) => candidate.id === input.serverId);
        if (!server || server.transport !== "streamable_http" || server.url !== input.expectedUrl ||
            server.auth.kind !== "oauth" ||
            (operation === "disable" && server.auth.credentialRef !== input.credentialRef)) {
          throw storeError(409, "MCP_OAUTH_BINDING_CONFLICT", "MCP OAuth 服务配置已变化。");
        }
        const { migrationStatus: _migrationStatus, ...serverWithoutMigration } = server;
        const updated = parseAgentMcpServerDescriptor(operation === "bind"
          ? { ...serverWithoutMigration, auth: { kind: "oauth", credentialRef: input.credentialRef } }
          : { ...server, enabled: false });
        await this.options.pathGuard.guard(paths, "update-mcp-oauth-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(index.servers.map((candidate) =>
          candidate.id === input.serverId ? updated : candidate
        )));
        return updated;
      });
    });
  }

  private async withFileLock<T>(paths: AgentExtensionStorePaths, operation: () => Promise<T>) {
    const lockPath = path.join(paths.mcp, ".index.lock");
    await this.options.pathGuard.guard(paths, "acquire-extension-lock");
    const handle = await acquireFileLock(lockPath);
    await this.options.pathGuard.refresh(paths, { allowChanged: [paths.mcp] });
    try {
      return await operation();
    } finally {
      await handle.close();
      await this.options.pathGuard.refresh(paths, { allowChanged: [paths.mcp] });
      await this.options.pathGuard.guard(paths, "release-extension-lock");
    }
  }

  private serialized<T>(agentId: string, operation: () => Promise<T>) {
    const key = `mcp:${agentId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }
}

export function withMcpRevision(servers: AgentMcpServerDescriptor[]): AgentMcpServerIndex {
  const ordered = [...servers].sort((left, right) => compareBinaryText(left.id, right.id));
  return {
    schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
    revision: extensionRevision(ordered),
    servers: ordered
  };
}

export function validateMcpIndex(value: unknown) {
  const index = parseAgentMcpServerIndex(value);
  const ordered = [...index.servers].sort((left, right) => compareBinaryText(left.id, right.id));
  if (index.revision !== extensionRevision(ordered)) {
    throw storeError(409, "MCP_INDEX_REVISION_MISMATCH", "MCP 服务索引 revision 无效。");
  }
  return index;
}
