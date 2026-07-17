export type SkillReviewStatus = "unreviewed" | "approved";
export type SkillApprovalStatus = "unapproved" | "approved";
export type McpTransport = "stdio" | "streamable_http";
export type McpApprovalMode = "always" | "mutating" | "never";

export interface AgentSkillRecord {
  id: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: readonly string[];
  riskEvidence: {
    reviewVersion: 1;
    reviewStatus: SkillReviewStatus;
    reviewedDigestSha256: string | null;
    classification: "instruction-only" | "script-bearing";
    hasScripts: boolean;
    hasExternalUrls: boolean;
    externalOrigins?: readonly string[];
    mcpDependencies: ReadonlyArray<{
      id: string;
      description: string;
      transport: "streamable_http";
      url: string;
    }>;
    declaredFileAccess: ReadonlyArray<"read" | "write" | "shell">;
    allowImplicitInvocation: boolean | null;
  };
  enabled: boolean;
  entry: "SKILL.md";
  digestSha256: string;
  fileCount: number;
  unpackedBytes: number;
  installedAt: string;
  source: { kind: "upload" } | { kind: "copy"; agentId: string; skillId: string };
  approval?: {
    status: SkillApprovalStatus;
    digestSha256: string | null;
    approvedAt: string | null;
  };
}

interface AgentMcpPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  required?: boolean;
  enabledTools?: readonly string[];
  disabledTools?: readonly string[];
  ordinaryUserTools?: readonly string[];
  approvalMode?: McpApprovalMode;
  migrationStatus?: "reauthorization_required";
}

export interface AgentMcpStdioServer extends AgentMcpPolicy {
  transport: "stdio";
  command: string;
  args: readonly string[];
  envKeys: readonly string[];
}

export interface AgentMcpHttpServer extends AgentMcpPolicy {
  transport: "streamable_http";
  url: string;
  auth:
    | { kind: "none" }
    | { kind: "bearer" | "oauth"; credentialRef: string };
}

export type AgentMcpServer = AgentMcpStdioServer | AgentMcpHttpServer;

export interface AgentMcpSecretStatus {
  configuredKeys: readonly string[];
  missingKeys: readonly string[];
}

export interface AgentExtensionOverview {
  schemaVersion: 1;
  agentId: string;
  skills: readonly AgentSkillRecord[];
  mcp: {
    servers: readonly AgentMcpServer[];
    secrets: AgentMcpSecretStatus;
  };
}

export interface McpInstallPreview {
  schemaVersion: 1;
  previewRevision: string;
  server: AgentMcpServer;
  commandApproval: null | {
    required: true;
    command: string;
    args: readonly string[];
    digestSha256: string;
  };
}

export interface McpRuntimeServerStatus {
  serverId: string;
  status: "ready" | "degraded" | "unavailable";
  toolCatalogStatus: "ready" | "degraded" | "unavailable";
  instructions?: string;
  errorCode?: string;
}

export interface McpRuntimeStatus {
  servers: readonly McpRuntimeServerStatus[];
}

export interface McpCatalogSnapshot {
  digestSha256: string;
  tools: ReadonlyArray<Record<string, unknown>>;
  resources: ReadonlyArray<Record<string, unknown>>;
  resourceTemplates: ReadonlyArray<Record<string, unknown>>;
  prompts: ReadonlyArray<Record<string, unknown>>;
  refreshedAt: string;
}

export interface McpApprovalTicket {
  id: string;
  agentId: string;
  accountId: string;
  transport: "onebot" | "web";
  conversationId: string;
  userId: number;
  serverId: string;
  toolName: string;
  snapshotDigest: string;
  catalogGeneration: number;
  argumentsDigest: string;
  arguments: unknown;
  status: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
}

export interface SkillCopyPreview {
  schemaVersion: 1;
  previewRevision: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceSkillRevision: string;
  targetSkillRevision: string;
  sourceMcpRevision: string;
  targetMcpRevision: string;
  skill: {
    record: AgentSkillRecord;
    contentVersion: string;
    files: ReadonlyArray<{ path: string; bytes: number; sha256: string }>;
    conflict: "none" | "same-content" | "different-content";
    declaredMcpDependencies: AgentSkillRecord["riskEvidence"]["mcpDependencies"];
    declaredMcpDependenciesStatus: "none" | "declared" | "missing";
    missingMcpDependencies: readonly string[];
  };
  selectedMcpServers: ReadonlyArray<{
    server: AgentMcpServer;
    descriptorVersion: string;
    conflict: "none" | "same-content" | "different-content";
    sourceSecrets: AgentMcpSecretStatus;
    targetSecrets: AgentMcpSecretStatus;
    targetState: "disabled";
    requiresAuthorization: boolean;
  }>;
}

export interface SkillCopyResult {
  schemaVersion: 1;
  sourceAgentId: string;
  targetAgentId: string;
  skill: AgentSkillRecord | null;
  skipped: boolean;
  mcpServers: readonly AgentMcpServer[];
}
