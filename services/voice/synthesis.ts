export interface VoiceSynthesisPromptAudio {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

export interface VoiceSynthesisGenerateInput {
  text: string;
  promptAudio: VoiceSynthesisPromptAudio;
  signal?: AbortSignal;
}

export interface VoiceSynthesisResult {
  bytes: Buffer;
  mimeType: "audio/wav";
  sha256: string;
}

export interface VoiceSynthesisHealthResult {
  ok: true;
  latencyMs: number;
}

export interface VoiceSynthesisClient {
  health(input?: { signal?: AbortSignal }): Promise<VoiceSynthesisHealthResult>;
  generate(input: VoiceSynthesisGenerateInput): Promise<VoiceSynthesisResult>;
}
