import type { BroadcastStormConfig } from "../types.js";
import { badRequest } from "./errors.js";
import {
  boolean,
  exactKeys,
  integer,
  object,
  stringArray,
  uniqueStrings
} from "./configValidation.js";

export function validateBroadcastStormConfig(input: unknown): BroadcastStormConfig {
  const value = object(input, "broadcastStorm");
  exactKeys(value, ["enabled", "windowMinutes", "replyThreshold", "cooldownMinutes", "additionalQqIds"], "broadcastStorm");
  const additionalQqIds = stringArray(
    value.additionalQqIds,
    "broadcastStorm.additionalQqIds",
    100,
    32
  );
  const invalidIndex = additionalQqIds.findIndex((qqId) => !/^\d+$/.test(qqId));
  if (invalidIndex >= 0) {
    badRequest(
      "CONFIG_INVALID",
      "嗅探账号中的 QQ 必须是数字。",
      `broadcastStorm.additionalQqIds.${invalidIndex}`
    );
  }
  return {
    enabled: boolean(value.enabled, "broadcastStorm.enabled"),
    windowMinutes: integer(value.windowMinutes, "broadcastStorm.windowMinutes", 1, 1_440),
    replyThreshold: integer(value.replyThreshold, "broadcastStorm.replyThreshold", 1, 100),
    cooldownMinutes: integer(value.cooldownMinutes, "broadcastStorm.cooldownMinutes", 1, 1_440),
    additionalQqIds: uniqueStrings(additionalQqIds)
  };
}
