const VOICE_SETTINGS_VARIABLE = "conversation.voice.settings";
const VOICE_TRIGGER_POLICY_VARIABLE = "conversation.voice.trigger_policy";

const LEGACY_VOICE_TOOL_DESCRIPTIONS = [
  "Create a cloned-voice reading of the same visible assistant message and send it immediately after that text. Use it at most once, only for a meaningful greeting, intimate or loving expression, intense emotion, shyness, or an important milestone. Never use it for routine facts, progress, errors, code, URLs, or long content. The text must exactly match the accompanying human-readable assistant text, excluding emoji markers.",
  "Create a cloned-voice reading as a companion to the same visible assistant message. Use it at most once, only for a meaningful greeting, intimate or loving expression, intense emotion, shyness, or an important milestone. Never use it for routine facts, progress, errors, code, URLs, or long content. The text must exactly match the accompanying human-readable assistant text, excluding emoji markers. If matching text was sent through assistant_text earlier in the current turn, the next model response may contain only send_voice_message."
] as const;

export function isLegacyVoiceToolDescription(description: string) {
  const variableSuffix = [
    `Current settings: @{${VOICE_SETTINGS_VARIABLE}}`,
    `Trigger policy: @{${VOICE_TRIGGER_POLICY_VARIABLE}}`
  ].join("\n\n");
  const normalized = description.trim();
  return LEGACY_VOICE_TOOL_DESCRIPTIONS.some((legacy) => (
    normalized === legacy || normalized === `${legacy}\n\n${variableSuffix}`
  ));
}
