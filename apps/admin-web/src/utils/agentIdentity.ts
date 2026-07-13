import type { AgentSummary } from "../types";

export function agentAvatarUrl(agent: Pick<AgentSummary, "id" | "avatarPath"> | undefined) {
  if (!agent?.avatarPath) return "";
  return `/api/agents/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatarPath)}`;
}
