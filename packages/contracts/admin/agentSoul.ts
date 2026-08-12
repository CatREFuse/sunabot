export const AGENT_SOUL_SCHEMA = "sunabot.soul" as const;
export const AGENT_SOUL_VERSION = 1 as const;
export const AGENT_SOUL_FILE_EXTENSION = ".sunabot-soul.json" as const;

export interface AgentSoulSource {
  agentId: string;
  name: string;
}

export interface AgentSoulFile {
  id: string;
  fileName: string;
  kind: "fragment" | "final";
  content: string;
  sha256: string;
}

export interface AgentSoulDocument {
  schema: typeof AGENT_SOUL_SCHEMA;
  version: typeof AGENT_SOUL_VERSION;
  source: AgentSoulSource;
  files: AgentSoulFile[];
}

export interface AgentSoulUpload {
  fileName: string;
  dataBase64: string;
}

export interface AgentSoulPreviewFile {
  id: string;
  fileName: string;
  kind: "fragment" | "final";
  change: "unchanged" | "replace";
}

export interface AgentSoulPreview {
  schema: typeof AGENT_SOUL_SCHEMA;
  version: typeof AGENT_SOUL_VERSION;
  source: AgentSoulSource;
  targetAgentId: string;
  packageSha256: string;
  targetRevision: string;
  files: AgentSoulPreviewFile[];
}

export interface AgentSoulImportRequest extends AgentSoulUpload {
  packageSha256: string;
  targetRevision: string;
}
