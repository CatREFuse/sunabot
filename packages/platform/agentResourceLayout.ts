import path from "node:path";

export const AGENT_RESOURCE_LAYOUT = {
  workbench: "workbench",
  dockerWorkbench: "docker-workbench",
  dockerWorkbenchProjection: "docker-workbench/native-workbench",
  selfie: "workbench/selfie",
  emoji: "workbench/emoji",
  skills: "workbench/skills",
  knowledge: "workbench/knowledge",
  dockerSelfie: "docker-workbench/selfie",
  dockerEmoji: "docker-workbench/emoji",
  dockerSkills: "docker-workbench/skills",
  dockerKnowledge: "docker-workbench/knowledge",
  mcp: "extensions/mcp"
} as const;

export type AgentResourceKind = "selfie" | "emoji" | "skills" | "knowledge";
export type AgentWorkbenchBackend = "native" | "docker";

export function agentResourcePath(
  agentWorkspace: string,
  kind: AgentResourceKind,
  backend: AgentWorkbenchBackend = "native"
) {
  const relativePath = backend === "native"
    ? AGENT_RESOURCE_LAYOUT[kind]
    : AGENT_RESOURCE_LAYOUT[dockerResourceLayoutKey(kind)];
  return path.join(agentWorkspace, relativePath);
}

function dockerResourceLayoutKey(kind: AgentResourceKind) {
  const key = `docker${kind[0]!.toUpperCase()}${kind.slice(1)}` as
    | "dockerSelfie"
    | "dockerEmoji"
    | "dockerSkills"
    | "dockerKnowledge";
  return key;
}
