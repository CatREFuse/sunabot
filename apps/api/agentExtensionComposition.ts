import path from "node:path";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { AgentSkillRuntimeReader } from "../../adapters/filesystem/agentSkillRuntimeReader.js";
import {
  BubblewrapMcpStdioLauncher,
  DockerMcpStdioLauncher,
  EncryptedFileMcpCredentialVault,
  EnvironmentMcpServerSecretResolver,
  MCP_OAUTH_ADMIN_SUBJECT,
  McpOAuthLoopbackBroker,
  McpOAuthService,
  McpSandboxProjectionBuilder,
  SdkMcpRuntimeClientFactory,
  createControlledMcpOAuthTokenExchange,
  fetchPinnedMcpAddress,
  resolveMcpHostname,
  type McpOAuthCredentialVault,
  type McpOAuthLoopbackBrokerOptions,
  type McpOAuthTokenExchangePort
} from "../../adapters/mcp/public.js";
import {
  AgentExtensionService,
  AgentMcpHost,
  McpToolApprovalTransactions,
  SkillActivationService,
  buildSkillCatalog,
  type McpRuntimeClientFactory
} from "../../services/extensions/public.js";
import {
  BUILTIN_SKILL_TOOL_CAPABILITIES,
  UNAVAILABLE_SKILL_TOOL_CAPABILITIES,
  type SkillToolCapabilitySnapshot
} from "../../services/tools/public.js";
import { McpRuntimeService } from "../../src/admin/mcpRuntimeService.js";
import { McpOAuthAdminService } from "../../src/admin/mcpOAuthAdminService.js";
import {
  RuntimeAgentExtensions,
  type RuntimeAgentExtensionsPort
} from "../../src/runtime/agentExtensions.js";
import { BundledAgentSkillInstaller } from "./bundledAgentSkills.js";

export interface AgentExtensionCompositionOptions {
  workspaceRoot: string;
  agentExists(agentId: string): boolean | Promise<boolean>;
  mcpClientFactory?: McpRuntimeClientFactory;
  runtime?: RuntimeAgentExtensionsPort;
  skillToolCapabilities?: Pick<SkillToolCapabilitySnapshot, "activate" | "readResource" | "runScript">;
  oauth?: false | {
    vaultKey?: Uint8Array;
    vaultFilePath?: string;
    exchange?: McpOAuthTokenExchangePort;
    loopbackOptions?: McpOAuthLoopbackBrokerOptions;
  };
  mcpStdio?: false | {
    backend: "bubblewrap";
    executableManifestPath: string;
  } | {
    backend: "docker";
    dockerExecutable?: string;
    dockerImage: string;
    executableManifestSha256: string;
  };
}

export const MCP_OAUTH_VAULT_KEY_ENV = "SUNABOT_MCP_CREDENTIAL_VAULT_KEY";

export function buildAgentExtensionComposition(options: AgentExtensionCompositionOptions) {
  const store = new AgentExtensionStore({ workspaceRoot: options.workspaceRoot });
  const bundledSkills = new BundledAgentSkillInstaller(store);
  const oauth = buildOAuth(options);
  const factory = options.mcpClientFactory ?? defaultMcpClientFactory(
    options.workspaceRoot,
    store,
    oauth?.vault,
    options.mcpStdio
  );
  const host = new AgentMcpHost(factory);
  const approvals = new McpToolApprovalTransactions();
  const runtime = options.runtime ?? defaultRuntimeAgentExtensions(
    options.workspaceRoot,
    store,
    host,
    approvals
  );
  const skillToolCapabilities = options.skillToolCapabilities
    ?? (options.runtime ? UNAVAILABLE_SKILL_TOOL_CAPABILITIES : BUILTIN_SKILL_TOOL_CAPABILITIES);
  const closeRuntimeAgent = (agentId: string) => strictCleanup([
    () => runtime.closeAgent(agentId),
    () => host.closeAgent(agentId)
  ]);
  const closeRuntime = () => strictCleanup([
    () => runtime.close(),
    () => host.close()
  ]);
  let afterAgentChanged: ((agentId: string) => Promise<void>) | undefined;
  const notifyAgentChanged = async (agentId: string) => {
    const failures: unknown[] = [];
    try {
      await closeRuntimeAgent(agentId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await afterAgentChanged?.(agentId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw stableAgentChangeError();
  };
  const service = new AgentExtensionService(
    store,
    async ({ envKeys }) => ({
      configuredKeys: envKeys.filter((key) => Boolean(process.env[key]?.trim())),
      missingKeys: envKeys.filter((key) => !process.env[key]?.trim())
    }),
    options.agentExists,
    undefined,
    oauth ? {
      async invalidateOAuthCredential(input) {
        await closeRuntimeAgent(input.agentId);
        await oauth.service.revoke({
          ...input,
          subject: MCP_OAUTH_ADMIN_SUBJECT
        });
      }
    } : undefined
  );
  const mcpRuntimeService = new McpRuntimeService(store, host, options.agentExists, approvals);
  const mcpOAuthService = oauth ? new McpOAuthAdminService({
    repository: store,
    oauth: oauth.service,
    loopback: new McpOAuthLoopbackBroker(options.oauth === false ? undefined : options.oauth?.loopbackOptions),
    agentExists: options.agentExists,
    onAgentChanged: notifyAgentChanged
  }) : undefined;
  return {
    service,
    runtime,
    mcpRuntimeService,
    mcpOAuthService,
    ensureBundledSkills(agentId: string) {
      return bundledSkills.ensure(agentId);
    },
    async skillToolCapabilities(agentId: string) {
      const index = await store.readSkillIndex(agentId);
      return {
        ...skillToolCapabilities,
        skillIds: buildSkillCatalog({ skills: index.skills }).explicitSkillIds
      };
    },
    setAgentChangedHandler(handler: (agentId: string) => Promise<void>) {
      afterAgentChanged = handler;
    },
    notifyAgentChanged,
    async closeAgent(agentId: string) {
      await strictCleanup([
        ...(mcpOAuthService ? [() => mcpOAuthService.closeAgent(agentId)] : []),
        () => closeRuntimeAgent(agentId)
      ]);
    },
    async close() {
      await strictCleanup([
        ...(mcpOAuthService ? [() => mcpOAuthService.close()] : []),
        closeRuntime
      ]);
    }
  };
}

function defaultRuntimeAgentExtensions(
  workspaceRoot: string,
  store: AgentExtensionStore,
  host: AgentMcpHost,
  approvals: McpToolApprovalTransactions
) {
  const reader = new AgentSkillRuntimeReader({ workspaceRoot });
  return new RuntimeAgentExtensions(
    store,
    new SkillActivationService(reader),
    host,
    (request) => approvals.resolve(request),
    approvals,
    false
  );
}

async function strictCleanup(operations: Array<() => Promise<void>>) {
  const settled = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

function stableAgentChangeError() {
  const error = new Error("AGENT_EXTENSION_CHANGE_RECONCILE_FAILED");
  error.name = "AgentExtensionChangeError";
  return error;
}

function defaultMcpClientFactory(
  workspaceRoot: string,
  store: AgentExtensionStore,
  oauthVault?: McpOAuthCredentialVault,
  stdioOptions?: AgentExtensionCompositionOptions["mcpStdio"]
) {
  const projectionBuilder = stdioOptions ? new McpSandboxProjectionBuilder({
    workspaceRoot,
    repository: store,
    ...(stdioOptions.backend === "bubblewrap" ? {
      executableManifestPath: stdioOptions.executableManifestPath,
      nodeExecutable: mcpBubblewrapNodeExecutable()
    } : {
      executableManifestSha256: stdioOptions.executableManifestSha256
    })
  }) : undefined;
  return new SdkMcpRuntimeClientFactory({
    secrets: new EnvironmentMcpServerSecretResolver(process.env, { oauthVault }),
    stdioLauncherFor: async ({ agentId, server, signal }) => {
      if (!stdioOptions) throw new Error("MCP_STDIO_ISOLATION_UNAVAILABLE");
      return {
        async launch(spec, handlers) {
          if (!projectionBuilder || (stdioOptions.backend !== "docker" && stdioOptions.backend !== "bubblewrap")) {
            throw new Error("MCP_STDIO_ISOLATION_UNAVAILABLE");
          }
          const projection = await projectionBuilder.build({ agentId, server });
          if (stdioOptions.backend === "docker") {
            return new DockerMcpStdioLauncher(projection, {
              abortSignal: signal,
              dockerExecutable: stdioOptions.dockerExecutable,
              dockerImage: stdioOptions.dockerImage,
              dockerEnvironment: process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}
            }).launch(spec, handlers);
          }
          return new BubblewrapMcpStdioLauncher(projection).launch(spec, handlers);
        }
      };
    },
    http: {
      resolve: resolveMcpHostname,
      fetchPinned: fetchPinnedMcpAddress
    }
  });
}

function mcpBubblewrapNodeExecutable(): "/usr/bin/node" | "/usr/local/bin/node" {
  if (process.execPath === "/usr/bin/node" || process.execPath === "/usr/local/bin/node") {
    return process.execPath;
  }
  throw new Error("MCP_STDIO_ISOLATION_UNAVAILABLE");
}

function buildOAuth(options: AgentExtensionCompositionOptions) {
  if (options.oauth === false) return undefined;
  const key = options.oauth?.vaultKey ? Buffer.from(options.oauth.vaultKey) : environmentVaultKey();
  if (!key) return undefined;
  const vault = new EncryptedFileMcpCredentialVault({
    filePath: options.oauth?.vaultFilePath ?? path.join(options.workspaceRoot, "secrets", "mcp-oauth-vault.json"),
    key
  });
  key.fill(0);
  const exchange = options.oauth?.exchange ?? createControlledMcpOAuthTokenExchange({
    resolve: resolveMcpHostname,
    fetchPinned: fetchPinnedMcpAddress
  });
  return { vault, service: new McpOAuthService({ vault, exchange }) };
}

function environmentVaultKey() {
  const raw = process.env[MCP_OAUTH_VAULT_KEY_ENV]?.trim();
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(raw)) throw new Error("MCP_OAUTH_VAULT_KEY_INVALID");
  const key = Buffer.from(raw, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== raw) throw new Error("MCP_OAUTH_VAULT_KEY_INVALID");
  return key;
}

export type { McpRuntimeClientFactory, RuntimeAgentExtensionsPort };
