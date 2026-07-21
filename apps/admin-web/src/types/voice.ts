export const VOICE_LANGUAGES = ["zh", "en", "ja"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const VOICE_LANGUAGE_LABELS: Readonly<Record<VoiceLanguage, string>> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
};

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

export interface VoiceProfile {
  schemaVersion: 1;
  enabled: boolean;
  defaultLanguage: VoiceLanguage;
  languages: Record<VoiceLanguage, VoiceReferenceMetadata | null>;
  provider: VoiceProviderSettings;
}

export interface VoiceProviderSettings {
  protocol: "openai-audio";
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  voices: Record<VoiceLanguage, string | null>;
}

export interface VoiceProviderStatus {
  provider: "OpenAI Audio";
  state: "ready" | "unconfigured" | "unavailable";
  ready: boolean;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
}

export type VoiceServiceAction = "check" | "";

export interface VoiceProfileGetResponse {
  profile: VoiceProfile;
  provider: VoiceProviderStatus;
}

export interface VoiceProfileMutationResponse {
  profile: VoiceProfile;
}

export interface VoiceProviderProbeResponse {
  provider: VoiceProviderStatus;
}

export interface VoiceProfileSettingsInput {
  enabled: boolean;
  defaultLanguage: VoiceLanguage;
}

export type VoiceProviderSettingsInput = VoiceProviderSettings;

export interface VoiceReferenceInput {
  file: File;
  referenceText: string;
  sourceUrl?: string;
  characterUrl?: string;
}
