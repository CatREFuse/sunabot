import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";

export async function resolveDreamAccountId(
  agentId: string,
  gateway: OneBotGateway,
  registry: AgentRegistry
) {
  const connected = new Set((gateway.getStatus().accounts ?? []).map((account) => account.accountId));
  return (await registry.get(agentId)).accounts
    .filter((account) => account.enabled && connected.has(account.id))
    .map((account) => account.id)
    .sort()[0];
}
