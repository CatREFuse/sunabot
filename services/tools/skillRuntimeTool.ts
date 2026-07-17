import type { ActivateSkillToolPort } from "./activateSkillTool.js";

export const READ_SKILL_RESOURCE_TOOL_NAME = "read_skill_resource" as const;
export const RUN_SKILL_SCRIPT_TOOL_NAME = "run_skill_script" as const;

export interface SkillRuntimeToolPort extends ActivateSkillToolPort {
  readResource(input: { skillId: string; path: string }): Promise<unknown>;
  runScript?: (input: { skillId: string; path: string; args: string[] }) => Promise<unknown>;
}

export function createReadSkillResourceTool(skillIds: string[]) {
  return skillTool(
    READ_SKILL_RESOURCE_TOOL_NAME,
    "Read one bounded resource from a Skill already activated in the current conversation.",
    skillIds,
    false
  );
}

export function createRunSkillScriptTool(skillIds: string[]) {
  return skillTool(
    RUN_SKILL_SCRIPT_TOOL_NAME,
    "Run one approved script from a Skill already activated in the current conversation through the audited isolated Skill runner.",
    skillIds,
    true
  );
}

export function readSkillResourceInput(value: unknown, allowed: readonly string[]) {
  const object = exactObject(value, ["skillId", "path"]);
  return {
    skillId: skillId(object.skillId, allowed),
    path: resourcePath(object.path)
  };
}

export function readSkillScriptInput(value: unknown, allowed: readonly string[]) {
  const object = exactObject(value, ["skillId", "path", "args"]);
  if (!Array.isArray(object.args) || object.args.length > 32) invalid();
  const args = object.args.map((value) => {
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 512) invalid();
    return value;
  });
  return {
    skillId: skillId(object.skillId, allowed),
    path: resourcePath(object.path),
    args
  };
}

function skillTool(name: string, description: string, skillIds: string[], script: boolean) {
  const values = [...new Set(skillIds)].sort();
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: script ? ["skillId", "path", "args"] : ["skillId", "path"],
      properties: {
        skillId: { type: "string", enum: values },
        path: {
          type: "string",
          maxLength: 1_024,
          description: script
            ? "Relative path below the activated Skill's scripts directory."
            : "Relative path from the activated Skill resource listing."
        },
        ...(script ? {
          args: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 512 }
          }
        } : {})
      }
    },
    strict: true
  } as const;
}

function exactObject(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return object;
}

function skillId(value: unknown, allowed: readonly string[]) {
  if (typeof value !== "string" || !allowed.includes(value)) invalid();
  return value;
}

function resourcePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\0") ||
      value.includes("\\") || value.startsWith("/")) invalid();
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) invalid();
  return value;
}

function invalid(): never {
  throw new Error("SKILL_RUNTIME_ARGUMENTS_INVALID");
}
