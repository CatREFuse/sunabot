export interface AgentRegistryRow {
  id: string;
  name: string;
  enabled: boolean;
  workspace: string;
  avatarPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAccountRegistryRow {
  id: string;
  agentId: string;
  label: string;
  qqId?: string;
  enabled: boolean;
  webuiPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRegistryRepository {
  readAgents(): AgentRegistryRow[];
  readAgent(id: string): AgentRegistryRow | undefined;
  createAgent(record: AgentRegistryRow): void;
  updateAgent(record: Pick<AgentRegistryRow, "id" | "name" | "enabled" | "avatarPath" | "updatedAt">): boolean;
  deleteAgent(id: string): boolean;
  readAgentAccounts(agentId?: string): AgentAccountRegistryRow[];
  readAgentAccount(id: string): AgentAccountRegistryRow | undefined;
  createAgentAccount(record: AgentAccountRegistryRow): void;
  updateAgentAccount(
    record: Pick<AgentAccountRegistryRow, "id" | "label" | "qqId" | "enabled" | "updatedAt">
  ): boolean;
  deleteAgentAccount(id: string): boolean;
  nextAgentAccountWebuiPort(): number;
}
