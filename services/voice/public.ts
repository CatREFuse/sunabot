export {
  DEFAULT_VOICE_LANGUAGE,
  MAX_VOICE_REFERENCE_BYTES,
  MAX_VOICE_REFERENCE_TEXT_CHARS,
  MAX_VOICE_OUTPUT_BYTES,
  MAX_VOICE_SOURCE_URL_CHARS,
  MAX_VOICE_TOOL_TEXT_CHARS,
  VOICE_LANGUAGES,
  VoiceProfileError,
  defaultVoiceProfile,
  type RuntimeVoiceReference,
  type VoiceLanguage,
  type VoiceProfileErrorCode,
  type VoiceProfileSettingsInput,
  type VoiceProfileV1,
  type VoiceReferenceMetadata,
  type VoiceReferenceUpload,
} from "./types.js";

export type {
  VoiceSynthesisClient,
  VoiceSynthesisGenerateInput,
  VoiceSynthesisHealthResult,
  VoiceSynthesisPromptAudio,
  VoiceSynthesisResult,
} from "./synthesis.js";

export {
  VoiceProfileRepository,
  type VoiceProfileRepositoryOptions,
} from "./voiceProfileRepository.js";

export { VOICE_TRIGGER_POLICY, voicePromptVariables } from "./prompt.js";

export { VoiceOutputStore } from "./outputStore.js";
