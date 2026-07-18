import type { AppConfig } from "../types.js";
import {
  EMOJI_MARKER_SYNTAX,
  emojiPlanContainsMarkers,
  emojiPlanContainsOnlyMarkers,
  guardEmojiToneRewrite,
  prepareEmojiReply,
  replanEmojiMarkers,
  restoreEmojiToneRewrite,
  type EmojiMarkerPlan
} from "../../services/emojis/emojiCatalog.js";
import {
  assertPlannedEmojiAssetsIntegrity,
  availableEmojiKeys,
  planAgentEmojiMarkers
} from "../emojis/emojiAssets.js";
import { normalizeOutgoingReplyText } from "./messagingAttachmentHelpers.js";

export async function prepareRuntimeEmojiText(
  text: string,
  config: AppConfig,
  rewriteTone: (value: string) => Promise<string>
) {
  const plan = planAgentEmojiMarkers(text, config);
  const rewritten = await rewritePlannedEmojiText(text, plan, rewriteTone);
  const normalizedText = normalizeOutgoingReplyText(rewritten.text).trim();
  const finalPlan = replanEmojiMarkers(normalizedText, rewritten.plan);
  const prepared = prepareEmojiReply(normalizedText, finalPlan);
  await assertPlannedEmojiAssetsIntegrity(config, plan);
  return prepared;
}

export async function rewritePlannedEmojiText(
  text: string,
  plan: EmojiMarkerPlan,
  rewriteTone: (value: string) => Promise<string>
) {
  const currentPlan = replanEmojiMarkers(text, plan);
  if (emojiPlanContainsOnlyMarkers(currentPlan)) return { text, plan: currentPlan };
  if (!emojiPlanContainsMarkers(currentPlan)) {
    const rewritten = await rewriteTone(text);
    return { text: rewritten, plan: replanEmojiMarkers(rewritten, currentPlan) };
  }
  const guard = guardEmojiToneRewrite(text, currentPlan);
  return restoreEmojiToneRewrite(await rewriteTone(guard.input), guard);
}

export function emojiPromptVariables(config: AppConfig) {
  return {
    "conversation.emoji.keys": availableEmojiKeys(config),
    "conversation.emoji.syntax": EMOJI_MARKER_SYNTAX
  };
}
