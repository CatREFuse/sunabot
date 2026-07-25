import path from "node:path";

export const AGENT_RESOURCE_LAYOUT = {
  workbench: "workbench",
  dockerWorkbench: "docker-workbench",
  dockerWorkbenchProjection: "docker-workbench/native-workbench",
  selfie: "workbench/selfie",
  emoji: "workbench/emoji",
  skills: "workbench/skills",
  knowledge: "workbench/knowledge",
  mcp: "extensions/mcp"
} as const;

export type AgentResourceKind = "selfie" | "emoji" | "skills" | "knowledge";

export function agentResourcePath(agentWorkspace: string, kind: AgentResourceKind) {
  return path.join(agentWorkspace, AGENT_RESOURCE_LAYOUT[kind]);
}
