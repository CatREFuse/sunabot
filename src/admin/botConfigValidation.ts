import type {
  AppConfig,
  BotConfig,
  BotImageReaderSettings
} from "../types.js";
import {
  MAX_REPLY_DEBOUNCE_MS,
  MIN_REPLY_DEBOUNCE_MS
} from "../types.js";
import { badRequest } from "./errors.js";
import {
  boolean,
  exactKeys,
  integer,
  object,
  optionalReasoningEffort,
  requiredString,
  stringArray,
  uniqueStrings,
  validateCatalogEffort
} from "./configValidation.js";

export type BotConfigSection = Pick<
  BotConfig,
  "adminQq" | "adminName" | "replyModel" | "replyReasoningEffort" | "imageReader"
  | "replyDebounceMs" | "pokeOnNoReply" | "quoteGroupReplies"
  | "quoteGroupReplyExcludedUserIds" | "contextMessageLimit"
  | "emojiSendSize" | "emojiSendSeparately"
>;

export function validateBotConfigSection(input: unknown, current?: AppConfig): BotConfigSection {
  const value = object(input, "bot");
  exactKeys(value, [
    "adminQq", "adminName", "replyModel", "replyReasoningEffort", "imageReader",
    "replyDebounceMs", "pokeOnNoReply", "quoteGroupReplies",
    "quoteGroupReplyExcludedUserIds", "contextMessageLimit", "emojiSendSize",
    "emojiSendSeparately"
  ], "bot");
  const adminQq = requiredString(value.adminQq, "bot.adminQq", {
    trim: true,
    min: 0,
    max: 32,
    allowEmpty: true
  });
  if (adminQq && !/^\d+$/.test(adminQq)) {
    badRequest("CONFIG_INVALID", "管理员 QQ 必须是数字。", "bot.adminQq");
  }
  const excludedUserIds = stringArray(
    value.quoteGroupReplyExcludedUserIds,
    "bot.quoteGroupReplyExcludedUserIds",
    100,
    32
  );
  const invalidIndex = excludedUserIds.findIndex((userId) => !/^\d+$/.test(userId));
  if (invalidIndex >= 0) {
    badRequest(
      "CONFIG_INVALID",
      "过滤名单中的 QQ 必须是数字。",
      `bot.quoteGroupReplyExcludedUserIds.${invalidIndex}`
    );
  }
  const replyModel = requiredString(value.replyModel, "bot.replyModel", {
    trim: true,
    min: 1,
    max: 200
  });
  const replyReasoningEffort = optionalReasoningEffort(
    value.replyReasoningEffort,
    "bot.replyReasoningEffort"
  );
  validateCatalogEffort(replyModel, replyReasoningEffort, "bot.replyReasoningEffort");
  return {
    adminQq,
    adminName: requiredString(value.adminName, "bot.adminName", {
      trim: true,
      min: 1,
      max: 80
    }),
    replyModel,
    ...(replyReasoningEffort ? { replyReasoningEffort } : {}),
    imageReader: validateImageReader(value.imageReader, current?.providers),
    replyDebounceMs: integer(
      value.replyDebounceMs,
      "bot.replyDebounceMs",
      MIN_REPLY_DEBOUNCE_MS,
      MAX_REPLY_DEBOUNCE_MS
    ),
    pokeOnNoReply: boolean(value.pokeOnNoReply, "bot.pokeOnNoReply"),
    quoteGroupReplies: boolean(value.quoteGroupReplies, "bot.quoteGroupReplies"),
    quoteGroupReplyExcludedUserIds: uniqueStrings(excludedUserIds),
    contextMessageLimit: integer(value.contextMessageLimit, "bot.contextMessageLimit", 1, 120),
    emojiSendSize: emojiSendSize(value.emojiSendSize, current?.bot.emojiSendSize ?? 512),
    emojiSendSeparately: boolean(value.emojiSendSeparately, "bot.emojiSendSeparately")
  };
}

function validateImageReader(
  input: unknown,
  providers?: AppConfig["providers"]
): BotImageReaderSettings {
  const value = object(input, "bot.imageReader");
  exactKeys(value, ["enabled", "providerId", "model", "reasoningEffort"], "bot.imageReader");
  const providerId = requiredString(value.providerId, "bot.imageReader.providerId", {
    trim: true,
    min: 0,
    max: 64,
    allowEmpty: true
  });
  if (providerId && !providers?.items.some((provider) => provider.id === providerId && provider.enabled)) {
    badRequest("CONFIG_INVALID", "读图 Provider 不存在或未启用。", "bot.imageReader.providerId");
  }
  const model = requiredString(value.model, "bot.imageReader.model", {
    trim: true,
    min: 1,
    max: 200
  });
  const reasoningEffort = optionalReasoningEffort(
    value.reasoningEffort,
    "bot.imageReader.reasoningEffort"
  );
  validateCatalogEffort(model, reasoningEffort, "bot.imageReader.reasoningEffort");
  return {
    enabled: boolean(value.enabled, "bot.imageReader.enabled"),
    providerId,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function emojiSendSize(value: unknown, fallback: BotConfig["emojiSendSize"]) {
  const candidate = value == null ? fallback : value;
  if (candidate === 64 || candidate === 128 || candidate === 256 || candidate === 512 || candidate === 1024) {
    return candidate;
  }
  badRequest("CONFIG_INVALID", "表情发送尺寸无效。", "bot.emojiSendSize");
}
