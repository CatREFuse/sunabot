import type { PromptVariableDefinition } from "../types";

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|@\{\s*([A-Za-z_][\w.-]*)\s*\}/g;

export function usedPromptVariableNames(
  content: string,
  variables: readonly PromptVariableDefinition[]
) {
  const available = new Set(variables.map((variable) => variable.name));
  const used = new Set<string>();
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name && available.has(name)) used.add(name);
  }
  return [...used];
}

export function promptVariableUsageCounts(
  content: string,
  variables: readonly PromptVariableDefinition[]
) {
  const available = new Set(variables.map((variable) => variable.name));
  const counts: Record<string, number> = {};
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name && available.has(name)) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}
