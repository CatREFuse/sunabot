import { AGENT_TOOL_NAMES, type AgentToolName } from "../../src/types.js";

export function normalizeConversationDisabledTools(value: unknown): AgentToolName[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is AgentToolName => (
    typeof name === "string" && (AGENT_TOOL_NAMES as readonly string[]).includes(name)
  )))];
}

export function isConversationToolEnabled(
  disabledTools: readonly AgentToolName[] | undefined,
  name: AgentToolName
) {
  return !disabledTools?.includes(name);
}
