import { AGENT_TOOL_NAMES, type AgentToolName } from "../../packages/contracts/admin/public.js";
import { ADD_WORKMEMORY_TOOL_NAME } from "./addWorkMemoryTool.js";

export function normalizeConversationDisabledTools(value: unknown): AgentToolName[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((name) => name === "workspace_bash"
    ? ["native_bash", "docker_bash"]
    : [name]);
  return [...new Set(normalized.filter((name): name is AgentToolName => (
    typeof name === "string"
    && name !== ADD_WORKMEMORY_TOOL_NAME
    && (AGENT_TOOL_NAMES as readonly string[]).includes(name)
  )))];
}

export function isConversationToolEnabled(
  disabledTools: readonly AgentToolName[] | undefined,
  name: AgentToolName
) {
  if (name === ADD_WORKMEMORY_TOOL_NAME) return true;
  return !disabledTools?.includes(name);
}
