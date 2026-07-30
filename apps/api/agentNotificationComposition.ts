import type { AgentRegistry } from "../../services/agents/agentRegistry.js";

export async function resolveEnabledAgentAccountId(
  agentId: string,
  registry: Pick<AgentRegistry, "get">,
  connectedAccountIds: readonly string[] = []
) {
  const enabledAccountIds = (await registry.get(agentId)).accounts
    .filter((account) => account.enabled)
    .map((account) => account.id)
    .sort();
  const connected = new Set(connectedAccountIds);
  return enabledAccountIds.find((accountId) => connected.has(accountId))
    ?? enabledAccountIds[0];
}
