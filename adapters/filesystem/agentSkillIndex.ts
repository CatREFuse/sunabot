import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  compareBinaryText,
  parseAgentSkillIndex,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import { storeError } from "./agentExtensionSecureFs.js";
import { extensionRevision } from "./agentSkillPersistence.js";

export function withSkillRevision(skills: AgentSkillRecord[]): AgentSkillIndex {
  const ordered = [...skills].sort((left, right) => compareBinaryText(left.id, right.id));
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision: extensionRevision(ordered), skills: ordered };
}

export function validateSkillIndex(value: unknown) {
  const index = parseAgentSkillIndex(value);
  const ordered = [...index.skills].sort((left, right) => compareBinaryText(left.id, right.id));
  if (index.revision !== extensionRevision(ordered)) {
    throw storeError(409, "SKILL_INDEX_REVISION_MISMATCH", "Skill 索引 revision 无效。");
  }
}
