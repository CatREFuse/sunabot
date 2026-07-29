import type { BotMemorySettings } from "../types.js";
import { badRequest } from "./errors.js";
import {
  exactKeys,
  integer,
  object,
  optionalReasoningEffort,
  pathString,
  requiredString,
  validateCatalogEffort
} from "./configValidation.js";

export function validateMemoryConfig(input: unknown): BotMemorySettings {
  const value = object(input, "memory");
  exactKeys(value, [
    "memoryModel", "reasoningEffort", "messageThreshold", "workingMemoryMaxEntries",
    "dreamRecentWindowHours", "dreamRecentMemoryLimit", "dreamOlderMemoryLimit",
    "workMemoryCompressInPrompt", "workMemoryCompressOutPrompt", "userProfilePrompt"
  ], "memory");
  const memoryModel = requiredString(value.memoryModel, "memory.memoryModel", { trim: true, min: 1, max: 200 });
  const reasoningEffort = optionalReasoningEffort(value.reasoningEffort, "memory.reasoningEffort");
  validateCatalogEffort(memoryModel, reasoningEffort, "memory.reasoningEffort");
  const dreamRecentMemoryLimit = integer(value.dreamRecentMemoryLimit, "memory.dreamRecentMemoryLimit", 0, 48);
  const dreamOlderMemoryLimit = integer(value.dreamOlderMemoryLimit, "memory.dreamOlderMemoryLimit", 0, 48);
  if (dreamRecentMemoryLimit + dreamOlderMemoryLimit < 1) {
    badRequest("CONFIG_INVALID", "Dream 至少需要抽取一条记忆。", "memory.dreamRecentMemoryLimit");
  }
  if (dreamRecentMemoryLimit + dreamOlderMemoryLimit > 48) {
    badRequest("CONFIG_INVALID", "Dream 每次最多抽取 48 条记忆。", "memory.dreamRecentMemoryLimit");
  }
  return {
    memoryModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messageThreshold: integer(value.messageThreshold, "memory.messageThreshold", 1, 200),
    workingMemoryMaxEntries: integer(value.workingMemoryMaxEntries, "memory.workingMemoryMaxEntries", 1, 1_000),
    dreamRecentWindowHours: integer(value.dreamRecentWindowHours, "memory.dreamRecentWindowHours", 1, 720),
    dreamRecentMemoryLimit,
    dreamOlderMemoryLimit,
    workMemoryCompressInPrompt: pathString(value.workMemoryCompressInPrompt, "memory.workMemoryCompressInPrompt", true),
    workMemoryCompressOutPrompt: pathString(value.workMemoryCompressOutPrompt, "memory.workMemoryCompressOutPrompt", true),
    userProfilePrompt: pathString(value.userProfilePrompt, "memory.userProfilePrompt", true)
  };
}
