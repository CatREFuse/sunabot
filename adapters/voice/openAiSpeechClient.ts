import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isWaveAudio } from "../../services/voice/audio.js";
import {
  MAX_VOICE_OUTPUT_BYTES,
  MAX_VOICE_TOOL_TEXT_CHARS,
} from "../../services/voice/types.js";
import type {
  VoiceSynthesisClient,
  VoiceSynthesisGenerateInput,
  VoiceSynthesisHealthResult,
  VoiceSynthesisResult,
} from "../../services/voice/synthesis.js";

export const DEFAULT_OPENAI_SPEECH_TIMEOUT_MS = 120_000;
const MAX_MODEL_RESPONSE_BYTES = 64 * 1024;

export type OpenAiSpeechErrorCode =
  | "VOICE_PROVIDER_CONFIG_INVALID"
  | "VOICE_PROVIDER_KEY_MISSING"
  | "VOICE_PROVIDER_INPUT_INVALID"
  | "VOICE_PROVIDER_REQUEST_ABORTED"
  | "VOICE_PROVIDER_REQUEST_TIMEOUT"
  | "VOICE_PROVIDER_UNAVAILABLE"
  | "VOICE_PROVIDER_HTTP_ERROR"
  | "VOICE_PROVIDER_RESPONSE_TOO_LARGE"
  | "VOICE_PROVIDER_RESPONSE_INVALID";

export class OpenAiSpeechError extends Error {
  constructor(
    readonly code: OpenAiSpeechErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiSpeechError";
  }
}

export interface OpenAiSpeechClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class OpenAiSpeechClient implements VoiceSynthesisClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: OpenAiSpeechClientOptions) {
    this.baseUrl = normalizeBaseUrl(options?.baseUrl);
    this.apiKey = requiredText(
      options?.apiKey,
      8_192,
      "VOICE_PROVIDER_KEY_MISSING",
    );
    this.model = requiredToken(options?.model, 128);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw configError();
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_OPENAI_SPEECH_TIMEOUT_MS,
      1_000,
      300_000,
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      MAX_VOICE_OUTPUT_BYTES,
      1,
      MAX_VOICE_OUTPUT_BYTES,
    );
  }

  async health(
    input: { signal?: AbortSignal } = {},
  ): Promise<VoiceSynthesisHealthResult> {
    const startedAt = performance.now();
    const response = await this.request(
      endpoint(this.baseUrl, `models/${encodeURIComponent(this.model)}`),
      { method: "GET", headers: this.headers() },
      input.signal,
    );
    await readBoundedBody(response, MAX_MODEL_RESPONSE_BYTES);
    return {
      ok: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  async generate(
    input: VoiceSynthesisGenerateInput,
  ): Promise<VoiceSynthesisResult> {
    const normalized = normalizeGenerateInput(input);
    const response = await this.request(
      endpoint(this.baseUrl, "audio/speech"),
      {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify({
          model: this.model,
          input: normalized.text,
          voice: voiceRequestValue(normalized.voiceId),
          response_format: "wav",
          stream_format: "audio",
        }),
      },
      normalized.signal,
    );
    const bytes = Buffer.from(
      await readBoundedBody(response, this.maxOutputBytes),
    );
    if (!(await isWaveAudio(bytes))) {
      throw new OpenAiSpeechError(
        "VOICE_PROVIDER_RESPONSE_INVALID",
        "在线语音服务返回了无效音频。",
      );
    }
    return {
      bytes,
      mimeType: "audio/wav",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  private headers(contentType?: string) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  private async request(url: URL, init: RequestInit, signal?: AbortSignal) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: requestSignal,
      });
      if (!response.ok) {
        throw new OpenAiSpeechError(
          "VOICE_PROVIDER_HTTP_ERROR",
          `在线语音服务请求失败（HTTP ${response.status}）。`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof OpenAiSpeechError) throw error;
      if (signal?.aborted) {
        throw new OpenAiSpeechError(
          "VOICE_PROVIDER_REQUEST_ABORTED",
          "在线语音合成已取消。",
        );
      }
      if (timeoutSignal.aborted) {
        throw new OpenAiSpeechError(
          "VOICE_PROVIDER_REQUEST_TIMEOUT",
          "在线语音服务请求超时。",
        );
      }
      throw new OpenAiSpeechError(
        "VOICE_PROVIDER_UNAVAILABLE",
        "在线语音服务不可用。",
      );
    }
  }
}

function voiceRequestValue(voiceId: string) {
  return voiceId.startsWith("voice_") ? { id: voiceId } : voiceId;
}

function normalizeGenerateInput(input: VoiceSynthesisGenerateInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inputError();
  }
  const text = requiredText(
    input.text,
    MAX_VOICE_TOOL_TEXT_CHARS,
    "VOICE_PROVIDER_INPUT_INVALID",
  );
  const voiceId = requiredToken(input.voiceId, 256);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw inputError();
  }
  return { text, voiceId, ...(input.signal ? { signal: input.signal } : {}) };
}

async function readBoundedBody(response: Response, maximum: number) {
  if (!response.body) throw responseError();
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) throw tooLargeError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

function normalizeBaseUrl(value: unknown) {
  try {
    const text = requiredText(value, 2_048, "VOICE_PROVIDER_CONFIG_INVALID");
    const url = new URL(text);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch (error) {
    if (error instanceof OpenAiSpeechError) throw error;
    throw configError();
  }
}

function endpoint(baseUrl: string, relativePath: string) {
  return new URL(`${baseUrl.replace(/\/$/u, "")}/${relativePath}`);
}

function requiredToken(value: unknown, maximum: number) {
  const text = requiredText(value, maximum, "VOICE_PROVIDER_CONFIG_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(text)) throw configError();
  return text;
}

function requiredText(
  value: unknown,
  maximum: number,
  code:
    | "VOICE_PROVIDER_CONFIG_INVALID"
    | "VOICE_PROVIDER_KEY_MISSING"
    | "VOICE_PROVIDER_INPUT_INVALID",
) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    [...value].length > maximum ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) {
    if (code === "VOICE_PROVIDER_KEY_MISSING") {
      throw new OpenAiSpeechError(code, "在线语音服务 API Key 未配置。");
    }
    if (code === "VOICE_PROVIDER_INPUT_INVALID") throw inputError();
    throw configError();
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw configError();
  }
  return resolved;
}

function configError() {
  return new OpenAiSpeechError(
    "VOICE_PROVIDER_CONFIG_INVALID",
    "在线语音服务配置无效。",
  );
}

function inputError() {
  return new OpenAiSpeechError(
    "VOICE_PROVIDER_INPUT_INVALID",
    "语音合成内容或音色 ID 无效。",
  );
}

function responseError() {
  return new OpenAiSpeechError(
    "VOICE_PROVIDER_RESPONSE_INVALID",
    "在线语音服务响应无效。",
  );
}

function tooLargeError() {
  return new OpenAiSpeechError(
    "VOICE_PROVIDER_RESPONSE_TOO_LARGE",
    "在线语音服务响应超过大小限制。",
  );
}
