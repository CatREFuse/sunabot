export const VOICE_LANGUAGES = ["zh", "en", "ja"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "ja";
export const MAX_VOICE_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_REFERENCE_TEXT_CHARS = 1_000;
export const MAX_VOICE_SOURCE_URL_CHARS = 2_048;
export const MAX_VOICE_TOOL_TEXT_CHARS = 300;
export const MAX_VOICE_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_VOICE_ID_CHARS = 256;

export interface VoiceProviderSettings {
  protocol: "openai-audio";
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  voices: Record<VoiceLanguage, string | null>;
}

export interface VoiceReferenceMetadata {
  language: VoiceLanguage;
  fileName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  referenceText: string;
  sourceUrl?: string;
  characterUrl?: string;
  updatedAt: string;
}

export interface VoiceProfileV1 {
  schemaVersion: 1;
  enabled: boolean;
  defaultLanguage: VoiceLanguage;
  languages: Record<VoiceLanguage, VoiceReferenceMetadata | null>;
  provider: VoiceProviderSettings;
}

export interface VoiceProfileSettingsInput {
  enabled: boolean;
  defaultLanguage: VoiceLanguage;
}

export type VoiceProviderSettingsInput = VoiceProviderSettings;

export interface VoiceReferenceUpload {
  language: VoiceLanguage;
  fileName: string;
  dataBase64: string;
  referenceText: string;
  sourceUrl?: string;
  characterUrl?: string;
}

export interface RuntimeVoiceReference {
  profile: VoiceProfileV1;
  language: VoiceLanguage;
  metadata: VoiceReferenceMetadata;
  bytes: Buffer;
}

export interface RuntimeVoiceTarget {
  profile: VoiceProfileV1;
  language: VoiceLanguage;
  voiceId: string;
  provider: VoiceProviderSettings;
}

export type VoiceProfileErrorCode =
  | "VOICE_WORKSPACE_INVALID"
  | "VOICE_PROFILE_INVALID"
  | "VOICE_PROFILE_TOO_LARGE"
  | "VOICE_LANGUAGE_INVALID"
  | "VOICE_DEFAULT_VOICE_REQUIRED"
  | "VOICE_PROVIDER_INVALID"
  | "VOICE_DISABLED"
  | "VOICE_REFERENCE_NOT_FOUND"
  | "VOICE_REFERENCE_INVALID"
  | "VOICE_REFERENCE_TOO_LARGE"
  | "VOICE_REFERENCE_TYPE_UNSUPPORTED"
  | "VOICE_REFERENCE_PATH_INVALID"
  | "VOICE_REFERENCE_CHANGED"
  | "VOICE_REFERENCE_BASE64_INVALID"
  | "VOICE_REFERENCE_FILE_NAME_INVALID"
  | "VOICE_REFERENCE_TEXT_INVALID"
  | "VOICE_REFERENCE_URL_INVALID";

export class VoiceProfileError extends Error {
  constructor(
    readonly code: VoiceProfileErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 415 | 500 = 400,
  ) {
    super(message);
    this.name = "VoiceProfileError";
  }
}

export function defaultVoiceProfile(): VoiceProfileV1 {
  return {
    schemaVersion: 1,
    enabled: false,
    defaultLanguage: DEFAULT_VOICE_LANGUAGE,
    languages: { zh: null, en: null, ja: null },
    provider: {
      protocol: "openai-audio",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-4o-mini-tts",
      voices: { zh: null, en: null, ja: null },
    },
  };
}
