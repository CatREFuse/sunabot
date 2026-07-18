import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { detectVoiceAudio, isWaveAudio } from "../../services/voice/audio.js";
import { VoiceAsyncMutex } from "../../services/voice/asyncMutex.js";
import {
  decodeStrictBase64,
  StrictBase64Error,
} from "../../services/voice/strictBase64.js";
import {
  MAX_VOICE_OUTPUT_BYTES,
  MAX_VOICE_REFERENCE_BYTES,
  MAX_VOICE_TOOL_TEXT_CHARS,
} from "../../services/voice/types.js";
import type {
  VoiceSynthesisClient,
  VoiceSynthesisGenerateInput,
  VoiceSynthesisHealthResult,
  VoiceSynthesisResult,
} from "../../services/voice/synthesis.js";

export const DEFAULT_MOSS_TTS_NANO_BASE_URL = "http://127.0.0.1:18083";
export const DEFAULT_MOSS_TTS_NANO_TIMEOUT_MS = 120_000;
export const DEFAULT_MOSS_TTS_NANO_MAX_OUTPUT_BYTES = MAX_VOICE_OUTPUT_BYTES;
const MAX_HEALTH_RESPONSE_BYTES = 16 * 1024;
const MAX_FILE_NAME_BYTES = 240;
const generationMutexes = new Map<string, VoiceAsyncMutex>();

export type MossTtsNanoErrorCode =
  | "MOSS_TTS_CONFIG_INVALID"
  | "MOSS_TTS_INPUT_INVALID"
  | "MOSS_TTS_PROMPT_AUDIO_INVALID"
  | "MOSS_TTS_REQUEST_ABORTED"
  | "MOSS_TTS_REQUEST_TIMEOUT"
  | "MOSS_TTS_UNAVAILABLE"
  | "MOSS_TTS_HTTP_ERROR"
  | "MOSS_TTS_RESPONSE_TOO_LARGE"
  | "MOSS_TTS_RESPONSE_INVALID";

export class MossTtsNanoError extends Error {
  constructor(
    readonly code: MossTtsNanoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MossTtsNanoError";
  }
}

export interface MossTtsNanoClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class MossTtsNanoClient implements VoiceSynthesisClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly generationMutex: VoiceAsyncMutex;

  constructor(options: MossTtsNanoClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_MOSS_TTS_NANO_BASE_URL,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new MossTtsNanoError(
        "MOSS_TTS_CONFIG_INVALID",
        "本地语音服务请求能力不可用。",
      );
    }
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_MOSS_TTS_NANO_TIMEOUT_MS,
      1_000,
      300_000,
      "请求超时时间",
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MOSS_TTS_NANO_MAX_OUTPUT_BYTES,
      1,
      DEFAULT_MOSS_TTS_NANO_MAX_OUTPUT_BYTES,
      "合成音频大小限制",
    );
    this.generationMutex = generationMutexFor(this.baseUrl);
  }

  async health(
    input: { signal?: AbortSignal } = {},
  ): Promise<VoiceSynthesisHealthResult> {
    const startedAt = performance.now();
    const value = await this.requestJson(
      endpoint(this.baseUrl, "health"),
      { method: "GET" },
      MAX_HEALTH_RESPONSE_BYTES,
      input.signal,
    );
    if (!isPlainObject(value) || value.status !== "ok") {
      throw new MossTtsNanoError(
        "MOSS_TTS_RESPONSE_INVALID",
        "本地语音服务状态响应无效。",
      );
    }
    return {
      ok: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  async generate(
    input: VoiceSynthesisGenerateInput,
  ): Promise<VoiceSynthesisResult> {
    const normalized = await normalizeGenerateInput(input);
    return this.generationMutex.runExclusive(async () => {
      const form = new FormData();
      form.append("text", normalized.text);
      form.append(
        "prompt_audio",
        new Blob([Uint8Array.from(normalized.promptAudio.bytes)], {
          type: normalized.promptAudio.mimeType,
        }),
        normalized.promptAudio.fileName,
      );
      form.append("cpu_threads", "4");
      form.append("enable_text_normalization", "0");
      form.append("enable_normalize_tts_text", "1");
      const maxResponseBytes =
        Math.ceil(this.maxOutputBytes / 3) * 4 + 64 * 1024;
      const value = await this.requestJson(
        endpoint(this.baseUrl, "api/generate"),
        { method: "POST", body: form },
        maxResponseBytes,
        normalized.signal,
      );
      if (!isPlainObject(value) || typeof value.audio_base64 !== "string") {
        throw new MossTtsNanoError(
          "MOSS_TTS_RESPONSE_INVALID",
          "本地语音服务返回了无效音频。",
        );
      }
      let bytes: Buffer;
      try {
        bytes = decodeStrictBase64(value.audio_base64, this.maxOutputBytes);
      } catch (error) {
        if (
          error instanceof StrictBase64Error &&
          error.reason === "too_large"
        ) {
          throw new MossTtsNanoError(
            "MOSS_TTS_RESPONSE_TOO_LARGE",
            "合成音频超过大小限制。",
          );
        }
        throw new MossTtsNanoError(
          "MOSS_TTS_RESPONSE_INVALID",
          "本地语音服务返回了无效音频。",
        );
      }
      if (!(await isWaveAudio(bytes))) {
        throw new MossTtsNanoError(
          "MOSS_TTS_RESPONSE_INVALID",
          "本地语音服务返回的音频格式无效。",
        );
      }
      return {
        bytes,
        mimeType: "audio/wav",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }, normalized.signal);
  }

  private async requestJson(
    url: URL,
    init: RequestInit,
    maxResponseBytes: number,
    signal?: AbortSignal,
  ) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: requestSignal,
      });
      assertSuccessfulResponse(response);
      return await readJsonResponse(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof MossTtsNanoError) throw error;
      if (signal?.aborted) {
        throw new MossTtsNanoError(
          "MOSS_TTS_REQUEST_ABORTED",
          "本地语音合成已取消。",
        );
      }
      if (timeoutSignal.aborted) {
        throw new MossTtsNanoError(
          "MOSS_TTS_REQUEST_TIMEOUT",
          "本地语音服务请求超时。",
        );
      }
      throw new MossTtsNanoError(
        "MOSS_TTS_UNAVAILABLE",
        "本地语音服务不可用。",
      );
    }
  }
}

async function normalizeGenerateInput(input: VoiceSynthesisGenerateInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MossTtsNanoError("MOSS_TTS_INPUT_INVALID", "语音合成内容无效。");
  }
  const text = normalizeText(input.text);
  const promptAudio = await normalizePromptAudio(input.promptAudio);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw new MossTtsNanoError(
      "MOSS_TTS_INPUT_INVALID",
      "语音合成取消信号无效。",
    );
  }
  return {
    text,
    promptAudio,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function normalizeText(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > MAX_VOICE_TOOL_TEXT_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) {
    throw new MossTtsNanoError(
      "MOSS_TTS_INPUT_INVALID",
      `语音合成内容应为 1 至 ${MAX_VOICE_TOOL_TEXT_CHARS} 个字符。`,
    );
  }
  return value;
}

async function normalizePromptAudio(
  value: VoiceSynthesisGenerateInput["promptAudio"],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MossTtsNanoError(
      "MOSS_TTS_PROMPT_AUDIO_INVALID",
      "参考音频无效。",
    );
  }
  if (
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength < 1 ||
    value.bytes.byteLength > MAX_VOICE_REFERENCE_BYTES
  ) {
    throw new MossTtsNanoError(
      "MOSS_TTS_PROMPT_AUDIO_INVALID",
      "参考音频无效。",
    );
  }
  const fileName = normalizeFileName(value.fileName);
  if (
    typeof value.mimeType !== "string" ||
    !/^audio\/[a-z0-9][a-z0-9.+-]{0,63}$/u.test(value.mimeType)
  ) {
    throw new MossTtsNanoError(
      "MOSS_TTS_PROMPT_AUDIO_INVALID",
      "参考音频格式无效。",
    );
  }
  const bytes = Buffer.from(value.bytes);
  const detected = await detectVoiceAudio(bytes);
  if (!detected || detected.mimeType !== value.mimeType.toLowerCase()) {
    throw new MossTtsNanoError(
      "MOSS_TTS_PROMPT_AUDIO_INVALID",
      "参考音频格式无效。",
    );
  }
  return { bytes, fileName, mimeType: detected.mimeType };
}

function normalizeFileName(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > MAX_FILE_NAME_BYTES ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF/\\]/u.test(value)
  ) {
    throw new MossTtsNanoError(
      "MOSS_TTS_PROMPT_AUDIO_INVALID",
      "参考音频文件名无效。",
    );
  }
  return value;
}

function normalizeBaseUrl(value: string) {
  try {
    if (
      typeof value !== "string" ||
      !value ||
      value !== value.trim() ||
      value.length > 2_048
    )
      throw new Error();
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new MossTtsNanoError(
      "MOSS_TTS_CONFIG_INVALID",
      "本地语音服务地址无效。",
    );
  }
}

function endpoint(baseUrl: string, relativePath: string) {
  return new URL(`${baseUrl.replace(/\/$/u, "")}/${relativePath}`);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new MossTtsNanoError("MOSS_TTS_CONFIG_INVALID", `${label}无效。`);
  }
  return result;
}

function generationMutexFor(baseUrl: string) {
  let mutex = generationMutexes.get(baseUrl);
  if (!mutex) {
    mutex = new VoiceAsyncMutex();
    generationMutexes.set(baseUrl, mutex);
  }
  return mutex;
}

function assertSuccessfulResponse(response: Response) {
  if (!response.ok) {
    throw new MossTtsNanoError(
      "MOSS_TTS_HTTP_ERROR",
      `本地语音服务请求失败（HTTP ${response.status}）。`,
    );
  }
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new MossTtsNanoError(
      "MOSS_TTS_RESPONSE_INVALID",
      "本地语音服务响应无效。",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MossTtsNanoError(
      "MOSS_TTS_RESPONSE_INVALID",
      "本地语音服务响应无效。",
    );
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) {
    throw new MossTtsNanoError(
      "MOSS_TTS_RESPONSE_INVALID",
      "本地语音服务响应无效。",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MossTtsNanoError(
          "MOSS_TTS_RESPONSE_TOO_LARGE",
          "本地语音服务响应超过大小限制。",
        );
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
