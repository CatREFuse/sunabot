// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { validateBotConfigSection } from "../../src/admin/botConfigValidation.js";
import { mergeManifestBotConfig } from "../../services/agents/agentConfigProjection.js";

describe("AIR model configuration", () => {
  const config = defaultConfig();
  const { adminQq, adminName, replyModel, replyReasoningEffort, imageReader, replyDebounceMs,
    pokeOnNoReply, quoteGroupReplies, quoteGroupReplyExcludedUserIds, contextMessageLimit,
    emojiSendSize, emojiSendSeparately } = config.bot;
  const section = { adminQq, adminName, replyModel, replyReasoningEffort, imageReader,
    replyDebounceMs, pokeOnNoReply, quoteGroupReplies, quoteGroupReplyExcludedUserIds,
    contextMessageLimit, emojiSendSize, emojiSendSeparately };

  it("preserves an omitted field and allows explicit follow-reply and custom models", () => {
    const current = structuredClone(config);
    current.bot.airModel = "existing-model";
    expect(validateBotConfigSection(section, current).airModel).toBe("existing-model");
    expect(validateBotConfigSection({ ...section, airModel: "" }, current).airModel).toBe("");
    expect(validateBotConfigSection({ ...section, airModel: " custom-model " }, current).airModel).toBe("custom-model");
    expect(config.bot.airModel).toBeUndefined();
  });

  it.each([42, {}, "x".repeat(201)])("rejects malformed administrative model settings %s", (airModel) => {
    expect(() => validateBotConfigSection({ ...section, airModel }, config)).toThrow();
  });

  it("keeps AIR model choice local to each Agent including legacy manifests", () => {
    const shared = { ...config.bot, airModel: "shared-air-model" };
    const arona = { ...config.bot, airModel: "arona-air-model" };
    const plana = { ...config.bot, replyModel: "plana-reply-model" };
    expect(mergeManifestBotConfig(shared, arona, false).airModel).toBe("arona-air-model");
    const merged = mergeManifestBotConfig(shared, plana, true);
    expect(merged.airModel).toBeUndefined();
    expect(merged.replyModel).toBe("plana-reply-model");
  });
});
