import { badRequest } from "../../src/admin/errors.js";

export function requestAgentId(query: unknown, options: { allowAll?: boolean } = {}) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  if (typeof value !== "string" || !value.trim()) {
    badRequest("AGENT_ID_REQUIRED", "请选择 Agent。", "agentId");
  }
  const agentId = value.trim();
  if (options.allowAll && agentId === "all") return agentId;
  if (agentId === "all" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)) {
    badRequest("AGENT_ID_INVALID", "Agent 无效。", "agentId");
  }
  return agentId;
}
