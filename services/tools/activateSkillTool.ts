export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill" as const;

export interface ActivateSkillToolPort {
  skillIds: string[];
  activate(input: { skillId: string }): Promise<unknown>;
}

export function createActivateSkillTool(skillIds: string[]) {
  const values = [...new Set(skillIds)].sort();
  return {
    type: "function",
    name: ACTIVATE_SKILL_TOOL_NAME,
    description: "Activate one approved Skill for the current conversation and load its protected instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skillId"],
      properties: {
        skillId: { type: "string", enum: values }
      }
    },
    strict: true
  } as const;
}

export function readActivateSkillInput(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL_ACTIVATION_ARGUMENTS_INVALID");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || typeof object.skillId !== "string" || !allowed.includes(object.skillId)) {
    throw new Error("SKILL_ACTIVATION_ARGUMENTS_INVALID");
  }
  return { skillId: object.skillId };
}
