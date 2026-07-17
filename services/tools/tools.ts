import { listToolMetadata, type ToolMetadata } from "./toolRegistry.js";

export type SunaTool = ToolMetadata;

export const defaultTools: SunaTool[] = listToolMetadata();

export { TOOL_CALL_TIMEOUT_MS } from "./toolConstants.js";
export {
  ACTIVATE_SKILL_TOOL_NAME,
  createActivateSkillTool,
  readActivateSkillInput,
  type ActivateSkillToolPort
} from "./activateSkillTool.js";
export {
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  createReadSkillResourceTool,
  createRunSkillScriptTool,
  readSkillResourceInput,
  readSkillScriptInput,
  type SkillRuntimeToolPort
} from "./skillRuntimeTool.js";
export {
  SYSTEM_CONFIG_TOOL_NAME,
  runSystemConfig,
  systemConfigTool,
  type SystemConfigInput,
  type SystemConfigMutationDescriptor,
  type SystemConfigMutationOperation,
  type SystemConfigRuntimePort,
  type SystemConfigToolPort,
  type SystemConfigTurn,
  type SystemConfigTurnContext
} from "./systemConfigTool.js";
